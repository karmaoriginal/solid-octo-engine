import { CONFIG, TASKS, type TaskId } from "../config";

/**
 * Contexto de tarea y métricas que se comparten entre simulación, worker e interfaz.
 * No importa Rapier: este módulo también se usa desde el bundle de la UI.
 */

/** Una neurada por disciplina = TASK_COUNT + 16 señales físicas/de objetivo. */
export const TASK_CONTEXT_SIZE = TASKS.length + 16;
export const CTX_SIZE = TASK_CONTEXT_SIZE - TASKS.length;
export const CTX = {
  goal: 0,
  metric: 1,
  load: 2,
  fatigue: 3,
  support: 4,
  speed: 5,
  handSpeed: 6,
  sin: 7,
  cos: 8,
  bagDist: 9,
  bagSpeed: 10,
  holdDist: 11,
  holdLevel: 12,
  gripL: 13,
  gripR: 14,
  wallAhead: 15,
} as const;

/** Objetos dinámicos que el worker manda a la escena: saco, mano L, mano R. */
export const PROP_BAG = 0;
export const PROP_HAND_L = 1;
export const PROP_HAND_R = 2;
export const PROP_COUNT = 3;
export const PROP_STRIDE = 8; // x,y,z,qx,qy,qz,qw,visible

export interface TaskMetrics {
  // ejercicio
  squatDown: boolean;
  reps: number;
  minPelvis: number;
  workJ: number;
  // escalada
  gripL: number;
  gripR: number;
  gripTimeL: number;
  gripTimeR: number;
  maxHold: number;
  holdTouches: number;
  touchedHolds: Set<number>;
  // boxeo
  hits: number;
  combo: number;
  lastHand: number;
  lastHitT: number;
  cooldownL: number;
  cooldownR: number;
  peakPunchN: number;
  bagSpeed: number;
  // parkour
  wallsCleared: number;
  cleared: Set<number>;
  landings: number;
  airborne: boolean;
  airTime: number;
  jumps: number;
  // genérico
  peakSupportN: number;
}

export function createTaskMetrics(): TaskMetrics {
  return {
    squatDown: false,
    reps: 0,
    minPelvis: 1,
    workJ: 0,
    gripL: -1,
    gripR: -1,
    gripTimeL: 0,
    gripTimeR: 0,
    maxHold: 0,
    holdTouches: 0,
    touchedHolds: new Set<number>(),
    hits: 0,
    combo: 0,
    lastHand: -1,
    lastHitT: -10,
    cooldownL: 0,
    cooldownR: 0,
    peakPunchN: 0,
    bagSpeed: 0,
    wallsCleared: 0,
    cleared: new Set<number>(),
    landings: 0,
    airborne: false,
    airTime: 0,
    jumps: 0,
    peakSupportN: 0,
  };
}

export interface PhysicsSettings {
  gravityScale: number;
  loadScale: number;
  muscleScale: number;
  fatigueScale: number;
  groundFriction: number;
}

export function defaultPhysics(): PhysicsSettings {
  return {
    gravityScale: CONFIG.gravityScale,
    loadScale: CONFIG.loadScale,
    muscleScale: CONFIG.muscleScale,
    fatigueScale: CONFIG.fatigueScale,
    groundFriction: CONFIG.groundFriction,
  };
}

/** Resume la disciplina para el HUD. */
export function taskUnit(id: TaskId) {
  return TASKS[Math.max(0, TASKS.findIndex((t) => t.id === id))].unit;
}
