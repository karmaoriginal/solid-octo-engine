import { CONFIG } from "../config";
import { BODY_SPECS, JOINT_SPECS, N_JOINTS, RENDER_BODIES, RENDER_COUNT } from "./spec";

/**
 * ============================================================
 *  MÚSCULOS: fuerza, activación, fatiga y coste metabólico
 * ============================================================
 * Cada articulación tiene un par agonista/antagonista representado por un grupo
 * muscular con:
 *   - fuerza máxima isométrica F0 (N), área transversal y masa estimada,
 *   - brazo de momento r (m) → torque máximo τ = F0 · r,
 *   - dinámica de activación (contracción/relajación con constantes de tiempo),
 *   - curva fuerza-velocidad de Hill y fatiga/recuperación,
 *   - potencia mecánica y gasto metabólico (W, J).
 * El torque REAL del motor de Rapier se limita a τ·fuerzaDisponible en cada
 * decisión: si el músculo está fatigado o se mueve rápido, tiene menos fuerza.
 */

export interface MuscleSpec {
  name: string;
  joint: number;
  body: string;
  momentArm: number; // m
  maxForceN: number; // N
  areaCm2: number; // sección transversal fisiológica
  massKg: number;
}

function momentArm(name: string): number {
  if (/Cadera|Rodilla/.test(name)) return 0.055;
  if (/Tobillo/.test(name)) return 0.045;
  if (/Columna/.test(name)) return 0.07;
  if (/Hombro|Codo/.test(name)) return 0.035;
  return 0.05;
}

function muscleName(name: string): string {
  const side = / L( |$)/.test(name) ? " izq." : / R( |$)/.test(name) ? " der." : "";
  if (/Columna \(inclinar\)/.test(name)) return "Erector espinal";
  if (/Columna \(lateral\)/.test(name)) return "Oblicuos / core";
  if (/Cuello/.test(name)) return "Trapecio";
  if (/Cadera .*flexión/.test(name)) return "Psoas-ilíaco" + side;
  if (/Cadera .*abducción/.test(name)) return "Glúteo medio" + side;
  if (/Rodilla/.test(name)) return "Cuádriceps / isquios" + side;
  if (/Tobillo .*flexión/.test(name)) return "Gastrocnemio / tibial" + side;
  if (/Tobillo .*lateral/.test(name)) return "Peroneos" + side;
  if (/Hombro .*flexión/.test(name)) return "Deltoide anterior" + side;
  if (/Hombro .*abducción/.test(name)) return "Deltoide lateral" + side;
  if (/Codo/.test(name)) return "Bíceps / tríceps" + side;
  return "Músculo" + side;
}

/** Segmento visible al que se asocia cada articulación (para el dibujado). */
function bodyForJoint(child: string): string {
  if (child.startsWith("hipD")) return child.replace("hipD", "thigh");
  if (child.startsWith("ankleD")) return child.replace("ankleD", "foot");
  if (child.startsWith("shoulderD")) return child.replace("shoulderD", "uarm");
  if (child === "spineD") return "pelvis";
  return child;
}

export const MUSCLE_SPECS: MuscleSpec[] = JOINT_SPECS.map((j, i) => {
  const r = momentArm(j.name);
  const maxForceN = j.maxTorque / r;
  const areaCm2 = maxForceN / 30; // tensión específica ~30 N/cm²
  return {
    name: muscleName(j.name),
    joint: i,
    body: bodyForJoint(j.child),
    momentArm: r,
    maxForceN,
    areaCm2,
    massKg: Math.round((areaCm2 * 0.9 * 1.06 * 10) / 10) / 10, // densidad ~1.06 g/cm³, longitud ~9 cm
  };
});

export const MUSCLE_MASS_KG = MUSCLE_SPECS.reduce((a, m) => a + m.massKg, 0);

const renderNameToIndex = new Map<string, number>();
RENDER_BODIES.forEach((bi, k) => renderNameToIndex.set(BODY_SPECS[bi].name, k));
const RENDER_MUSCLES: number[][] = Array.from({ length: RENDER_COUNT }, () => []);
MUSCLE_SPECS.forEach((m, j) => {
  const k = renderNameToIndex.get(m.body);
  if (k !== undefined) RENDER_MUSCLES[k].push(j);
});
// El cuádriceps/isquiotibial se ve tanto en el muslo como en la pantorrilla.
JOINT_SPECS.forEach((j, i) => {
  if (!/Rodilla/.test(j.name)) return;
  const thigh = / L/.test(j.name) ? "thighL" : "thighR";
  const k = renderNameToIndex.get(thigh);
  if (k !== undefined && !RENDER_MUSCLES[k].includes(i)) RENDER_MUSCLES[k].push(i);
});
// La pelvis y el pecho comparten los estabilizadores del tronco.
for (const j of [0, 1]) {
  const k = renderNameToIndex.get("pelvis");
  if (k !== undefined && !RENDER_MUSCLES[k].includes(j)) RENDER_MUSCLES[k].push(j);
  const c = renderNameToIndex.get("chest");
  if (c !== undefined && !RENDER_MUSCLES[c].includes(j)) RENDER_MUSCLES[c].push(j);
}

/** Dos floats por segmento dibujado: activación [0,1] y fatiga [0,1]. */
export const MUSCLE_VIEW_SIZE = RENDER_COUNT * 2;

const ARM_JOINTS: [number, number][] = [0, 1].map((side) => {
  const s = side === 0 ? "L" : "R";
  const shoulder = JOINT_SPECS.findIndex((j) => j.name.includes(`Hombro ${s} (flexión)`));
  const elbow = JOINT_SPECS.findIndex((j) => j.name.includes(`Codo ${s}`));
  return [Math.max(0, shoulder), Math.max(0, elbow)];
}) as [number, number][];

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class MuscleSystem {
  activation = new Float32Array(N_JOINTS);
  fatigue = new Float32Array(N_JOINTS);
  forceN = new Float32Array(N_JOINTS);
  powerW = new Float32Array(N_JOINTS);
  strength = new Float32Array(N_JOINTS);
  energyJ = 0;
  peakForceN = 0;
  meanActivation = 0;
  meanFatigue = 0;
  meanForceN = 0;
  powerTotalW = 0;

  reset() {
    this.activation.fill(0);
    this.fatigue.fill(0);
    this.forceN.fill(0);
    this.powerW.fill(0);
    this.strength.fill(1);
    this.energyJ = 0;
    this.peakForceN = 0;
    this.meanActivation = 0;
    this.meanFatigue = 0;
    this.meanForceN = 0;
    this.powerTotalW = 0;
  }

  /**
   * Actualiza fisiología muscular y devuelve el torque máximo disponible por articulación.
   * `demand` es el esfuerzo normalizado que pide el controlador, `vel` la velocidad angular.
   */
  update(demand: ArrayLike<number>, vel: ArrayLike<number>, dt: number): Float32Array {
    const M = CONFIG.muscles;
    const scale = CONFIG.muscleScale * CONFIG.torqueScale;
    const fatigueScale = CONFIG.fatigueScale;
    let sa = 0, sf = 0, sforce = 0, spower = 0;
    for (let j = 0; j < N_JOINTS; j++) {
      const m = MUSCLE_SPECS[j];
      const target = clamp(Math.abs(demand[j]), 0, 1);
      const tau = target > this.activation[j] ? M.activationTau : M.relaxationTau;
      this.activation[j] += (target - this.activation[j]) * (1 - Math.exp(-dt / tau));
      const a = this.activation[j];
      // Curva de Hill simplificada: a mayor velocidad de acortamiento, menos fuerza.
      const hill = 1 / (1 + Math.abs(vel[j]) / M.vmax);
      this.fatigue[j] = clamp(
        this.fatigue[j] + (a * a * M.fatigueRate * fatigueScale - M.recoveryRate * (1 - a)) * dt,
        0,
        1,
      );
      const f = this.fatigue[j];
      const available = scale * hill * (1 - (1 - M.strengthFloor) * f);
      this.strength[j] = hill * (1 - (1 - M.strengthFloor) * f);
      const maxTorque = m.maxForceN * m.momentArm * available;
      // Fuerza realmente ejercida: el torque PD saturado dividido por el brazo de momento.
      const torqueUsed = clamp(demand[j], -1, 1) * maxTorque;
      this.forceN[j] = Math.abs(torqueUsed) / m.momentArm;
      const mechPower = Math.abs(torqueUsed * vel[j]);
      const metabolicW = M.restingCost + a * m.maxForceN * 0.002 + mechPower / M.efficiency;
      this.powerW[j] = metabolicW;
      this.energyJ += metabolicW * dt;
      sa += a;
      sf += f;
      sforce += this.forceN[j];
      spower += metabolicW;
      this.peakForceN = Math.max(this.peakForceN, this.forceN[j]);
    }
    this.meanActivation = sa / N_JOINTS;
    this.meanFatigue = sf / N_JOINTS;
    this.meanForceN = sforce / N_JOINTS;
    this.powerTotalW = spower;
    return this.strength;
  }

  /** Fuerza máxima de agarre disponible en una mano (N), limitada por la fatiga del brazo. */
  gripForceN(side: number): number {
    const [sh, el] = ARM_JOINTS[side];
    const fatigue = (this.fatigue[sh] + this.fatigue[el]) * 0.5;
    const base = Math.min(MUSCLE_SPECS[sh].maxForceN, MUSCLE_SPECS[el].maxForceN);
    return clamp(base * (1 - 0.65 * fatigue) * CONFIG.muscleScale, 120, 620);
  }

  /** Fuerza de impacto disponible para un puñetazo (N). */
  punchForceN(side: number): number {
    const [sh, el] = ARM_JOINTS[side];
    const fatigue = (this.fatigue[sh] + this.fatigue[el]) * 0.5;
    const base = (MUSCLE_SPECS[sh].maxForceN + MUSCLE_SPECS[el].maxForceN) * 0.5;
    return clamp(base * (1 - 0.55 * fatigue) * CONFIG.muscleScale, 180, 1400);
  }

  /** Rellena el buffer de visualización (activación, fatiga) por segmento. */
  view(out: Float32Array) {
    for (let k = 0; k < RENDER_COUNT; k++) {
      const js = RENDER_MUSCLES[k];
      let a = 0, f = 0;
      for (const j of js) {
        a += this.activation[j];
        f += this.fatigue[j];
      }
      const n = Math.max(1, js.length);
      out[k * 2] = a / n;
      out[k * 2 + 1] = f / n;
    }
  }

  /** Detalle para la hoja "Músculos" de la interfaz. */
  rows() {
    return MUSCLE_SPECS.map((m, j) => ({
      name: m.name,
      activation: this.activation[j],
      fatigue: this.fatigue[j],
      forceN: this.forceN[j],
      powerW: this.powerW[j],
      maxForceN: m.maxForceN,
      massKg: m.massKg,
    }));
  }
}
