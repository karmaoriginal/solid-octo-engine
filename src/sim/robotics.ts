import { JOINT_SPECS, N_JOINTS } from "./spec";
import { makeRng } from "./rng";

/** Técnicas inspiradas en control robótico, en unidades de acción normalizada.
 * Son heurísticas de simulación, no un controlador validado para robots reales. */
const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));
const joint = (name: string) => {
  const i = JOINT_SPECS.findIndex(j => j.name === name);
  if (i < 0) throw new Error(`Articulación ausente: ${name}`);
  return i;
};
const hips = [joint("Cadera L (flexión)"), joint("Cadera R (flexión)")];
const ankles = [joint("Tobillo L (flexión)"), joint("Tobillo R (flexión)")];

export interface BalanceState { upX: number; wz: number }

/**
 * Capa de seguridad de los actuadores: corrige la inclinación en marcha con
 * retroalimentación acotada de orientación y velocidad angular (tipo PD),
 * limita la velocidad de cambio y mantiene las acciones dentro de [-1, 1].
 * No mueve directamente el cuerpo ni sustituye el arnés de la simulación.
 */
export class RobotController {
  private previous = new Float32Array(N_JOINTS);
  reset() { this.previous.fill(0); }
  apply(actions: Float32Array, state: BalanceState, dt: number, walking: boolean) {
    const correction = walking ? clamp(-0.22 * state.upX + 0.035 * state.wz, -0.16, 0.16) : 0;
    const maxChange = 5 * dt; // acciones normalizadas por segundo
    for (let j = 0; j < N_JOINTS; j++) {
      let desired = Number.isFinite(actions[j]) ? actions[j] : 0;
      if (walking && hips.includes(j)) desired += correction;
      if (walking && ankles.includes(j)) desired -= correction * 0.5;
      desired = clamp(desired, -1, 1);
      const prev = this.previous[j];
      actions[j] = prev + clamp(desired - prev, -maxChange, maxChange);
      this.previous[j] = actions[j];
    }
  }
}

export interface DomainVariation { gravity: number; friction: number }
/** Condiciones comunes para todos los candidatos de una generación.
 * Semilla determinista independiente del orden de slots y de la RNG evolutiva. */
export function generationDomain(generation: number, task: number, amount: number): DomainVariation {
  const rng = makeRng((Math.imul(generation + 1, 0x9e3779b1) ^ Math.imul(task + 1, 0x85ebca6b)) >>> 0);
  const range = clamp(amount, 0, 0.25);
  return { gravity: 1 + (rng() * 2 - 1) * range, friction: 1 + (rng() * 2 - 1) * range };
}
