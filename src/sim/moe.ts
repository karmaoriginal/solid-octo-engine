import { CONFIG, TASKS } from "../config";
import { N_OBS } from "./observations";
import { makeRng } from "./rng";

/**
 * ============================================================
 *  BANCO DE EXPERTOS (MoE) — 100.000.000 parámetros
 * ============================================================
 * Arquitectura exacta:
 *   5 disciplinas × 200 expertos × matriz(250 × 400 int8) = 100.000.000 pesos.
 *
 * ¿Por qué "virtual"? Guardar 100 M float32 serían 400 MB por cerebro y evaluar
 * 100 M MAC por decisión × 24 agentes × 30 Hz es inviable en un navegador.
 * En su lugar:
 *   - los pesos son int8 deterministas generados por hash (semilla + experto + fila + columna),
 *     direccionables individualmente: la matriz virtual contiene 100 M valores fijos;
 *   - un router aprendido por evolución elige 2 expertos por disciplina;
 *   - de cada experto solo se calculan 24 filas → 12.000 pesos activos por decisión;
 *   - las filas calculadas se guardan en una caché LRU (unos cientos de KB).
 *
 * Las proyecciones de entrada/salida, el router y los adaptadores SÍ son parámetros
 * evolutivos entrenables y viajan en el genoma (policy.ts). Los 100 M valores se derivan
 * de una semilla, no son 100 M parámetros independientes ni entrenables.
 */

export const EXPERT_COUNT = TASKS.length * CONFIG.brain.expertsPerTask;
export const EXPERT_INPUT = CONFIG.brain.expertInput;
export const EXPERT_OUTPUT = CONFIG.brain.expertOutput;
export const ACTIVE_ROWS = CONFIG.brain.activeRows;
export const TOP_K = CONFIG.brain.topK;
export const PARAM_COUNT = EXPERT_COUNT * EXPERT_INPUT * EXPERT_OUTPUT;
export const ACTIVE_PARAMS = TOP_K * ACTIVE_ROWS * EXPERT_INPUT;

if (PARAM_COUNT !== CONFIG.brain.targetParams) {
  throw new Error(`El banco MoE debería tener ${CONFIG.brain.targetParams} parámetros, tiene ${PARAM_COUNT}`);
}

export const MODEL_INFO = {
  totalParams: PARAM_COUNT, // 100.000.000
  activeParams: ACTIVE_PARAMS, // 12.000
  experts: EXPERT_COUNT, // 1.000
  expertsPerTask: CONFIG.brain.expertsPerTask,
  input: EXPERT_INPUT,
  output: EXPERT_OUTPUT,
  topK: TOP_K,
  activeRows: ACTIVE_ROWS,
  precision: "int8 virtual",
  bytesIfMaterialized: PARAM_COUNT,
};

const fastTanh = (x: number) => x / (1 + Math.abs(x));

/** Entero int8 en [-1, 1) calculado por hash sin almacenar la matriz completa. */
function hashedWeight(expert: number, row: number, col: number): number {
  let h = CONFIG.brain.seed ^ Math.imul(expert + 1, 0x9e3779b1) ^ Math.imul(row + 1, 0x85ebca6b) ^ Math.imul(col + 1, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 13;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return ((h & 255) / 127.5) - 1;
}

export class BrainBank {
  private embA = new Uint16Array(EXPERT_INPUT);
  private embB = new Uint16Array(EXPERT_INPUT);
  private embC = new Uint16Array(EXPERT_INPUT);
  private embD = new Uint16Array(EXPERT_INPUT);
  private embS = new Float32Array(EXPERT_INPUT * 4);
  private rowCache = new Map<number, Float32Array>();
  private rowOrder: number[] = [];
  private emb = new Float32Array(EXPERT_INPUT);
  private res = new Float32Array(ACTIVE_ROWS);

  constructor() {
    const rng = makeRng(CONFIG.brain.seed ^ 0x5bf03635);
    for (let i = 0; i < EXPERT_INPUT; i++) {
      this.embA[i] = Math.floor(rng() * N_OBS) % N_OBS;
      this.embB[i] = Math.floor(rng() * N_OBS) % N_OBS;
      this.embC[i] = Math.floor(rng() * N_OBS) % N_OBS;
      this.embD[i] = Math.floor(rng() * N_OBS) % N_OBS;
      for (let k = 0; k < 4; k++) this.embS[i * 4 + k] = rng() < 0.5 ? -1 : 1;
    }
  }

  /** Proyección aleatoria fija y dispersa: 81 observaciones → 250 features. */
  private embed(obs: Float32Array) {
    const e = this.emb;
    for (let i = 0; i < EXPERT_INPUT; i++) {
      const b = i * 4;
      const v =
        obs[this.embA[i]] * this.embS[b] +
        obs[this.embB[i]] * this.embS[b + 1] +
        obs[this.embC[i]] * this.embS[b + 2] +
        obs[this.embD[i]] * this.embS[b + 3] * 0.5;
      e[i] = fastTanh(v * 0.7);
    }
    return e;
  }

  /** Materializa (y cachea) una fila de 250 pesos de un experto. */
  private getRow(expert: number, row: number): Float32Array {
    const key = expert * EXPERT_OUTPUT + row;
    const hit = this.rowCache.get(key);
    if (hit) return hit;
    const w = new Float32Array(EXPERT_INPUT);
    for (let i = 0; i < EXPERT_INPUT; i++) w[i] = hashedWeight(expert, row, i);
    this.rowCache.set(key, w);
    this.rowOrder.push(key);
    if (this.rowOrder.length > CONFIG.brain.rowCache) {
      const old = this.rowOrder.shift()!;
      this.rowCache.delete(old);
    }
    return w;
  }

  /**
   * Inferencia dispersa: `expertIds` son los 2 expertos globales seleccionados.
   * `outProj` es el bloque del genoma [TASK][19][ACTIVE_ROWS].
   */
  forward(
    obs: Float32Array,
    expertIds: Int32Array,
    taskIdx: number,
    genome: ArrayLike<number>,
    outProjOffset: number,
    gain: number,
    out: Float32Array,
  ) {
    const emb = this.embed(obs);
    const e0 = expertIds[0];
    const e1 = expertIds[1] ?? e0;
    for (let r = 0; r < ACTIVE_ROWS; r++) {
      const row0 = (e0 * 131 + r * 97 + taskIdx * 53) % EXPERT_OUTPUT;
      const row1 = (e1 * 173 + r * 61 + taskIdx * 29 + 137) % EXPERT_OUTPUT;
      const w0 = this.getRow(e0, row0);
      const w1 = this.getRow(e1, row1);
      let s0 = 0, s1 = 0;
      for (let i = 0; i < EXPERT_INPUT; i++) {
        const x = emb[i];
        s0 += x * w0[i];
        s1 += x * w1[i];
      }
      this.res[r] = fastTanh((s0 + 0.7 * s1) / (Math.sqrt(EXPERT_INPUT) * 1.7));
    }
    const g = Math.max(-0.6, Math.min(0.6, gain));
    for (let j = 0; j < out.length; j++) {
      let s = 0;
      const base = outProjOffset + j * ACTIVE_ROWS;
      for (let r = 0; r < ACTIVE_ROWS; r++) s += this.res[r] * genome[base + r];
      out[j] = g * fastTanh(s / Math.sqrt(ACTIVE_ROWS));
    }
  }

  get cachedRows() {
    return this.rowCache.size;
  }
}

export const BRAIN_BANK = new BrainBank();
