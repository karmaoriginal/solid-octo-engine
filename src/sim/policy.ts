import { CONFIG, TASKS, type TaskId } from "../config";
import { BASE_OBS, N_OBS } from "./observations";
import { ACTIVE_ROWS, BRAIN_BANK, MODEL_INFO, TOP_K } from "./moe";
import { N_JOINTS, JOINT_SPECS } from "./spec";
import { gaussian, type Rng } from "./rng";

/**
 * ============================================================
 *  CEREBRO MULTIDISCIPLINA
 * ============================================================
 * 1. CPG por disciplina: oscilador con amplitud/fase/sesbo por grupo de articulación,
 *    frecuencia propia, simetría (pasos alternados vs. sentadilla/salto en fase) y
 *    bias de postura. Da un "instinto" inicial distinto para cada deporte.
 * 2. Red de reflejos densa: N_OBS → 64 → 64 → 19 (tanh).
 * 3. Router evolutivo → 2 de 200 expertos por disciplina del banco MoE de 100 M.
 * 4. Los 24 canales activos de los expertos se proyectan a 19 articulaciones.
 * 5. Adaptadores, ganancias y salidas se suman y se saturan con tanh a [-1, 1].
 *
 * El genoma son ~20k parámetros entrenables por evolución; el banco MoE aporta
 * exactamente 100.000.000 parámetros base congelados (ver moe.ts).
 */

const H = CONFIG.brain.hidden;
const T = TASKS.length;
const D = CONFIG.brain.routerKeyDim;
const E = CONFIG.brain.expertsPerTask;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

const GROUPS: string[] = [];
const JOINT_GROUP: number[] = [];
const JOINT_RIGHT: boolean[] = [];
JOINT_SPECS.forEach((j) => {
  const right = / R( |$)/.test(j.name);
  const key = j.name.replace(/ [LR]( |$)/, "$1");
  let g = GROUPS.indexOf(key);
  if (g < 0) {
    g = GROUPS.length;
    GROUPS.push(key);
  }
  JOINT_GROUP.push(g);
  JOINT_RIGHT.push(right);
});
const NG = GROUPS.length;

// ------------------------------------------------------------------ genoma
const OFF_FREQ = 0;
const OFF_TASK_FREQ = OFF_FREQ + 1;
const OFF_SYM = OFF_TASK_FREQ + T;
const OFF_AMP = OFF_SYM + T;
const OFF_PHASE = OFF_AMP + T * NG;
const OFF_BIAS = OFF_PHASE + T * NG;
const OFF_TASK_GAIN = OFF_BIAS + T * NG;
const OFF_ACT_BIAS = OFF_TASK_GAIN + T * N_JOINTS;
export const CPG_PARAMS = OFF_ACT_BIAS + T * N_JOINTS;

const OFF_W1 = CPG_PARAMS;
const OFF_B1 = OFF_W1 + H * N_OBS;
const OFF_W2 = OFF_B1 + H;
const OFF_B2 = OFF_W2 + H * H;
const OFF_W3 = OFF_B2 + H;
const OFF_B3 = OFF_W3 + N_JOINTS * H;
const OFF_ROUTER_KEY = OFF_B3 + N_JOINTS;
const OFF_ROUTER_BIAS = OFF_ROUTER_KEY + T * E * D;
const OFF_MOE_OUT = OFF_ROUTER_BIAS + T * E;
const OFF_MOE_GAIN = OFF_MOE_OUT + T * N_JOINTS * ACTIVE_ROWS;
export const GENOME_SIZE = OFF_MOE_GAIN + T;

export const BRAIN_INFO = {
  ...MODEL_INFO,
  trainableParams: GENOME_SIZE,
  tasks: T,
  obs: N_OBS,
  joints: N_JOINTS,
};

/** Frecuencia del CPG de una disciplina (Hz). */
export function genomeFreq(g: ArrayLike<number>, taskIdx: number) {
  return clamp(1.4 + 0.35 * g[OFF_FREQ] + 0.5 * g[OFF_TASK_FREQ + taskIdx], 0.2, 3.2);
}

interface Template {
  freq: number; // se suma con peso 0.5 a la base 1.4 Hz
  sym: number; // 0 = piernas/brazos alternados, 1 = en fase
  amp: Record<string, number>;
  phase: Record<string, number>;
  bias: Record<string, number>;
  act: Record<string, number>;
}

const K = {
  spine: "Columna (inclinar)",
  side: "Columna (lateral)",
  neck: "Cuello",
  hip: "Cadera (flexión)",
  abd: "Cadera (abducción)",
  knee: "Rodilla",
  ankle: "Tobillo (flexión)",
  ankleSide: "Tobillo (lateral)",
  shoulder: "Hombro (flexión)",
  shoulderSide: "Hombro (abducción)",
  elbow: "Codo",
};

/** Priors motores: no son una solución, solo un punto de partida distinto por deporte. */
const TEMPLATES: Template[] = [
  {
    freq: 0, sym: 0,
    amp: { [K.hip]: 0.45, [K.knee]: 0.55, [K.ankle]: 0.3, [K.shoulder]: 0.25, [K.elbow]: 0.15, [K.spine]: 0.06 },
    phase: { [K.hip]: 0, [K.knee]: 1.1, [K.ankle]: 0.4, [K.shoulder]: 3.34, [K.elbow]: 0.5 },
    bias: { [K.knee]: 0.08, [K.spine]: 0.05 },
    act: { [K.knee]: 0.06 },
  },
  {
    freq: -2.0, sym: 1,
    amp: { [K.hip]: 0.65, [K.knee]: 0.72, [K.ankle]: 0.22, [K.shoulder]: 0.12, [K.elbow]: 0.1, [K.spine]: 0.14 },
    phase: { [K.hip]: 0, [K.knee]: 0, [K.ankle]: 0, [K.spine]: 0 },
    bias: { [K.knee]: 0.2, [K.hip]: 0.15 },
    act: { [K.knee]: 0.32, [K.hip]: 0.22, [K.ankle]: -0.1, [K.shoulder]: -0.12, [K.elbow]: 0.12, [K.spine]: 0.06 },
  },
  {
    freq: -0.8, sym: 0,
    amp: { [K.shoulder]: 0.8, [K.elbow]: 0.65, [K.hip]: 0.4, [K.knee]: 0.45, [K.spine]: 0.18 },
    phase: { [K.shoulder]: 0, [K.elbow]: 0.8, [K.hip]: 0.4, [K.knee]: 0.7 },
    bias: { [K.shoulder]: 0.2, [K.knee]: 0.12 },
    act: { [K.shoulder]: 0.72, [K.elbow]: 0.4, [K.hip]: 0.18, [K.knee]: 0.18, [K.spine]: -0.08 },
  },
  {
    freq: 1.4, sym: 0,
    amp: { [K.shoulder]: 0.85, [K.elbow]: 0.8, [K.spine]: 0.25, [K.knee]: 0.22, [K.hip]: 0.16 },
    phase: { [K.shoulder]: 0, [K.elbow]: 1.0, [K.spine]: 0.2 },
    bias: { [K.shoulder]: 0.15, [K.elbow]: 0.1 },
    act: { [K.shoulder]: 0.55, [K.elbow]: 0.3, [K.spine]: 0.1, [K.knee]: 0.08 },
  },
  {
    freq: -0.6, sym: 1,
    amp: { [K.hip]: 0.7, [K.knee]: 0.8, [K.ankle]: 0.35, [K.shoulder]: 0.35, [K.elbow]: 0.2, [K.spine]: 0.18 },
    phase: { [K.hip]: 0, [K.knee]: 0.5, [K.ankle]: 0, [K.shoulder]: 0.3 },
    bias: { [K.knee]: 0.18, [K.hip]: 0.15 },
    act: { [K.hip]: 0.3, [K.knee]: 0.34, [K.ankle]: -0.1, [K.shoulder]: -0.12, [K.spine]: 0.08 },
  },
];

/** Cerebro inicial: CPG con instintos por disciplina + reflejos y router aleatorios. */
export function initGenome(rng: Rng): Float32Array {
  const g = new Float32Array(GENOME_SIZE);
  g[OFF_FREQ] = gaussian(rng) * 0.5;
  for (let t = 0; t < T; t++) {
    const tpl = TEMPLATES[t];
    g[OFF_TASK_FREQ + t] = tpl.freq + gaussian(rng) * 0.08;
    g[OFF_SYM + t] = clamp(tpl.sym + gaussian(rng) * 0.05, 0, 1);
    for (let k = 0; k < NG; k++) {
      const key = GROUPS[k];
      g[OFF_AMP + t * NG + k] = (tpl.amp[key] ?? 0.12) + gaussian(rng) * 0.07;
      g[OFF_PHASE + t * NG + k] = (tpl.phase[key] ?? 0) + gaussian(rng) * 0.12;
      g[OFF_BIAS + t * NG + k] = (tpl.bias[key] ?? 0) + gaussian(rng) * 0.03;
    }
    for (let j = 0; j < N_JOINTS; j++) {
      const key = GROUPS[JOINT_GROUP[j]];
      g[OFF_ACT_BIAS + t * N_JOINTS + j] = (tpl.act[key] ?? 0) + gaussian(rng) * 0.04;
      g[OFF_TASK_GAIN + t * N_JOINTS + j] = 1 + gaussian(rng) * 0.05;
    }
  }
  const s1 = 1 / Math.sqrt(N_OBS);
  for (let i = 0; i < H * N_OBS; i++) g[OFF_W1 + i] = gaussian(rng) * s1;
  for (let i = 0; i < H * H; i++) g[OFF_W2 + i] = gaussian(rng) * (1 / Math.sqrt(H));
  for (let i = 0; i < N_JOINTS * H; i++) g[OFF_W3 + i] = gaussian(rng) * 0.05;
  for (let i = 0; i < T * E * D; i++) g[OFF_ROUTER_KEY + i] = gaussian(rng) * 0.18;
  for (let i = 0; i < T * E; i++) g[OFF_ROUTER_BIAS + i] = gaussian(rng) * 0.05;
  for (let i = 0; i < T * N_JOINTS * ACTIVE_ROWS; i++) g[OFF_MOE_OUT + i] = gaussian(rng) * 0.08;
  for (let t = 0; t < T; t++) g[OFF_MOE_GAIN + t] = CONFIG.brain.moeGainInit + gaussian(rng) * 0.02;
  return g;
}

/** Escala relativa de mutación de cada parámetro. */
export function mutationScales(activeTask?: number): Float32Array {
  const s = new Float32Array(GENOME_SIZE);
  for (let i = 0; i < CPG_PARAMS; i++) s[i] = CONFIG.cpgScale;
  s[OFF_FREQ] = CONFIG.cpgScale * 0.4;
  for (let t = 0; t < T; t++) {
    s[OFF_TASK_FREQ + t] = 0.25;
    s[OFF_SYM + t] = 0.1;
    for (let k = 0; k < NG; k++) s[OFF_PHASE + t * NG + k] = CONFIG.cpgScale * 0.8;
    for (let j = 0; j < N_JOINTS; j++) {
      s[OFF_TASK_GAIN + t * N_JOINTS + j] = 0.08;
      s[OFF_ACT_BIAS + t * N_JOINTS + j] = 0.18;
    }
  }
  for (let i = CPG_PARAMS; i < OFF_ROUTER_KEY; i++) s[i] = CONFIG.nnScale;
  for (let i = OFF_ROUTER_KEY; i < OFF_MOE_OUT; i++) s[i] = 0.08;
  for (let i = OFF_MOE_OUT; i < OFF_MOE_GAIN; i++) s[i] = 0.05;
  for (let i = OFF_MOE_GAIN; i < GENOME_SIZE; i++) s[i] = 0.04;
  if (activeTask !== undefined) {
    // Cada cerebro evalúa una sola disciplina: no gastar mutaciones en las otras.
    for (let t = 0; t < T; t++) if (t !== activeTask) {
      s[OFF_TASK_FREQ + t] = 0;
      s[OFF_SYM + t] = 0;
      s.fill(0, OFF_AMP + t * NG, OFF_AMP + (t + 1) * NG);
      s.fill(0, OFF_PHASE + t * NG, OFF_PHASE + (t + 1) * NG);
      s.fill(0, OFF_BIAS + t * NG, OFF_BIAS + (t + 1) * NG);
      s.fill(0, OFF_TASK_GAIN + t * N_JOINTS, OFF_TASK_GAIN + (t + 1) * N_JOINTS);
      s.fill(0, OFF_ACT_BIAS + t * N_JOINTS, OFF_ACT_BIAS + (t + 1) * N_JOINTS);
      s.fill(0, OFF_ROUTER_KEY + t * E * D, OFF_ROUTER_KEY + (t + 1) * E * D);
      s.fill(0, OFF_ROUTER_BIAS + t * E, OFF_ROUTER_BIAS + (t + 1) * E);
      s.fill(0, OFF_MOE_OUT + t * N_JOINTS * ACTIVE_ROWS, OFF_MOE_OUT + (t + 1) * N_JOINTS * ACTIVE_ROWS);
      s[OFF_MOE_GAIN + t] = 0;
    }
  }
  return s;
}

const FEATURE_IDX = [
  0,
  N_JOINTS,
  N_JOINTS * 2,
  N_JOINTS * 2 + 3,
  N_JOINTS * 2 + 6,
  N_JOINTS * 2 + 9,
  BASE_OBS - 4,
  BASE_OBS - 3,
];

export class Policy {
  g: ArrayLike<number> = new Float32Array(GENOME_SIZE);
  freq = 1.4;
  taskIdx = 0;
  private hid = new Float32Array(H);
  private hid2 = new Float32Array(H);
  private mlpOut = new Float32Array(N_JOINTS);
  private moeOut = new Float32Array(N_JOINTS);
  private feat = new Float32Array(D);
  private expertIds = new Int32Array(TOP_K);

  set(genome: ArrayLike<number>, task: number | TaskId) {
    this.g = genome;
    this.taskIdx = typeof task === "number" ? task : TASKS.findIndex((t) => t.id === task);
    this.freq = genomeFreq(genome, this.taskIdx);
  }

  private buildFeatures(obs: Float32Array, t: number) {
    for (let d = 0; d < D - 2; d++) this.feat[d] = clamp(obs[FEATURE_IDX[d] % N_OBS], -1.5, 1.5);
    const ph = 2 * Math.PI * this.freq * t;
    this.feat[D - 2] = Math.sin(ph);
    this.feat[D - 1] = Math.cos(ph);
  }

  /** Router aprendido: elige los 2 expertos con mayor score para la disciplina actual. */
  private route() {
    const g = this.g;
    const task = this.taskIdx;
    const keyBase = OFF_ROUTER_KEY + task * E * D;
    const biasBase = OFF_ROUTER_BIAS + task * E;
    let best = -Infinity, second = -Infinity, i0 = 0, i1 = 0;
    for (let e = 0; e < E; e++) {
      let score = g[biasBase + e];
      const kb = keyBase + e * D;
      for (let d = 0; d < D; d++) score += g[kb + d] * this.feat[d];
      const id = task * E + e;
      if (score > best) {
        second = best; i1 = i0;
        best = score; i0 = id;
      } else if (score > second) {
        second = score; i1 = id;
      }
    }
    this.expertIds[0] = i0;
    this.expertIds[1] = i1;
  }

  /** Calcula las acciones u (19 valores en [-1,1]) a partir de las observaciones. */
  act(obs: Float32Array, t: number, u: Float32Array) {
    const g = this.g;
    const task = this.taskIdx;
    // --- red de reflejos densa
    for (let h = 0; h < H; h++) {
      let s = g[OFF_B1 + h];
      const b = OFF_W1 + h * N_OBS;
      for (let i = 0; i < N_OBS; i++) s += g[b + i] * obs[i];
      this.hid[h] = Math.tanh(s);
    }
    for (let h = 0; h < H; h++) {
      let s = g[OFF_B2 + h];
      const b = OFF_W2 + h * H;
      for (let i = 0; i < H; i++) s += g[b + i] * this.hid[i];
      this.hid2[h] = Math.tanh(s);
    }
    for (let j = 0; j < N_JOINTS; j++) {
      let s = g[OFF_B3 + j];
      const b = OFF_W3 + j * H;
      for (let h = 0; h < H; h++) s += g[b + h] * this.hid2[h];
      this.mlpOut[j] = 0.45 * Math.tanh(s);
    }
    // --- banco MoE de 100 M parámetros (inferencia dispersa)
    this.buildFeatures(obs, t);
    this.route();
    BRAIN_BANK.forward(
      obs,
      this.expertIds,
      task,
      g,
      OFF_MOE_OUT + task * N_JOINTS * ACTIVE_ROWS,
      g[OFF_MOE_GAIN + task],
      this.moeOut,
    );
    // --- CPG + reflejos + adaptadores
    const ph = 2 * Math.PI * this.freq * t;
    const sym = clamp(g[OFF_SYM + task], 0, 1);
    const alt = Math.PI * (1 - sym);
    for (let j = 0; j < N_JOINTS; j++) {
      const k = JOINT_GROUP[j];
      const shift = JOINT_RIGHT[j] ? alt : 0;
      const cpg =
        g[OFF_BIAS + task * NG + k] +
        g[OFF_AMP + task * NG + k] * Math.sin(ph + g[OFF_PHASE + task * NG + k] + shift);
      const bias = g[OFF_ACT_BIAS + task * N_JOINTS + j];
      const gain = clamp(g[OFF_TASK_GAIN + task * N_JOINTS + j], 0.35, 1.8);
      u[j] = Math.tanh(gain * (bias + cpg + this.mlpOut[j] + this.moeOut[j]));
    }
  }
}
