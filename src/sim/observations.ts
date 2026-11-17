import { N_JOINTS } from "./spec";
import { TASK_CONTEXT_SIZE } from "./tasks";

/** Observaciones proprioceptivas originales: ángulos, velocidades, orientación, etc. */
export const BASE_OBS =
  N_JOINTS * 2 + // ángulo y velocidad de cada articulación
  3 + 3 + 3 + // pelvis arriba/adelante, pecho arriba
  1 + // altura de la pelvis
  3 + 3 + // velocidad lineal y angular
  2 + // contacto de los pies
  2 + // fase del oscilador
  2; // vista del terreno a 0.5 m y 1 m

/** Vector completo de observaciones: 60 valores corporales + one-hot de disciplina + 16 de contexto. */
export const N_OBS = BASE_OBS + TASK_CONTEXT_SIZE;
