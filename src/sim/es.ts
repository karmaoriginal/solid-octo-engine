import { CONFIG } from "../config";
import { gaussian, type Rng } from "./rng";

/**
 * ============================================================
 *  ESTRATEGIA EVOLUTIVA ELITISTA con muestreo en espejo
 * ============================================================
 * Se mantienen dos "centros": la ÉLITE (mejor cerebro conocido) y la MEDIA (recombinación
 * ponderada de los mejores de la generación anterior). Cada generación se evalúan:
 *   - la élite y la media tal cual (sin mutar)  → progreso medible y sin ruido
 *   - K mutaciones alrededor de ambos centros, en parejas espejo (+z, -z) y con un tamaño de
 *     paso σ·exp(ruido) variable por pareja (así siempre se prueban pasos pequeños y grandes)
 * σ se adapta por éxito: crece si alguna mutación supera a la élite, y se encoge si no
 * (regla tipo 1/5 de éxito). Como la simulación es determinista, la comparación es exacta.
 */
export class Evolution {
  n: number;
  mean: Float32Array;
  sigma = CONFIG.initialSigma;
  scale: Float32Array;
  elite: Float32Array;
  eliteFit = -Infinity;
  gen = 0;
  cands: Float32Array[] = [];

  private K = CONFIG.sampledPerGeneration;
  /** Los primeros `denseCount` parámetros (oscilador) se mutan con más frecuencia. */
  denseCount = 0;
  /** Factor de mutación de la red neuronal (0 = congelada; se activa por etapas). */
  nnFactor = 0;
  private mu = 8;
  private w: Float64Array;

  constructor(init: Float32Array, scale: Float32Array, private rng: Rng) {
    this.n = init.length;
    this.mean = Float32Array.from(init);
    this.elite = Float32Array.from(init);
    this.scale = scale;
    const raw = Array.from({ length: this.mu }, (_, i) => Math.log(this.mu + 0.5) - Math.log(i + 1));
    const sum = raw.reduce((a, b) => a + b, 0);
    this.w = Float64Array.from(raw.map((v) => v / sum));
    this.ask();
  }

  get populationSize() {
    return this.K + 2;
  }

  /** Genera los candidatos de la generación actual. */
  ask(): Float32Array[] {
    const n = this.n;
    this.cands = [this.elite, this.mean];
    const z = new Float32Array(n);
    const densities = [0.03, 0.08, 0.2, 0.5, 1];
    for (let k = 0; k < this.K; k += 2) {
      const centre = k < this.K / 2 ? this.elite : this.mean;
      const sg = this.sigma * Math.exp(0.35 * gaussian(this.rng));
      // mutación dispersa: cada pareja modifica solo una fracción de los parámetros
      const d = densities[Math.floor(this.rng() * densities.length)];
      for (let i = 0; i < n; i++) {
        const pr = i < this.denseCount ? Math.min(1, d * 4 + 0.1) : d;
        const sc = i < this.denseCount ? this.scale[i] : this.scale[i] * this.nnFactor;
        z[i] = sc > 0 && this.rng() < pr ? gaussian(this.rng) * sg * sc : 0;
      }
      const a = new Float32Array(n);
      const b = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        a[i] = centre[i] + z[i];
        b[i] = centre[i] - z[i];
      }
      this.cands.push(a, b);
    }
    return this.cands;
  }

  /** Recibe las recompensas (mismo orden que cands) y prepara la siguiente generación. */
  tell(fits: number[]) {
    const n = this.n;
    const eliteNow = fits[0]; // la élite se reevalúa cada generación (el terreno pudo cambiar)
    let bi = 0;
    for (let i = 1; i < fits.length; i++) if (fits[i] > fits[bi]) bi = i;
    const success = fits[bi] > eliteNow + 1e-6;
    // nueva media: recombinación ponderada de los mejores
    const order = Array.from({ length: fits.length }, (_, i) => i).sort((a, b) => fits[b] - fits[a]);
    const m = new Float64Array(n);
    for (let r = 0; r < this.mu; r++) {
      const c = this.cands[order[r]];
      const w = this.w[r];
      for (let i = 0; i < n; i++) m[i] += w * c[i];
    }
    this.elite = Float32Array.from(this.cands[bi]);
    this.eliteFit = fits[bi];
    this.mean = Float32Array.from(m);
    this.sigma *= success ? 1.15 : 0.97;
    this.sigma = Math.min(1.0, Math.max(CONFIG.sigmaMin, this.sigma));
    this.gen++;
    this.ask();
  }

  /** Cambia el cerebro de partida (al cargar un archivo). */
  load(mean: ArrayLike<number>, elite: ArrayLike<number>, sigma: number, gen: number, eliteFit: number) {
    this.mean = Float32Array.from(mean);
    this.elite = Float32Array.from(elite);
    this.eliteFit = eliteFit;
    this.sigma = sigma;
    this.gen = gen;
    this.ask();
  }
}
