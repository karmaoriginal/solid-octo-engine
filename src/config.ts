/**
 * ============================================================
 *  PARÁMETROS AJUSTABLES  (todo lo "tuneable" está aquí arriba)
 * ============================================================
 * Unidades: metros, kilogramos, segundos, radianes, newtons, julios.
 * La gravedad, la masa, la carga, la fuerza muscular y la fatiga se pueden
 * cambiar en vivo desde la hoja "⚙️ Física" de la interfaz.
 */
export const CONFIG = {
  // ---------- Física ----------
  physicsDt: 1 / 60, // paso de física
  controlEvery: 2, // la IA decide cada N pasos de física (30 Hz)
  gravity: -9.81, // m/s²
  gravityScale: 1,
  groundFriction: 1.0,
  solverIterations: 4,

  // ---------- Motores / músculos ----------
  /** Error (rad) con el que el motor llega a su torque máximo. Menor = más rígido. */
  motorFullTorqueError: 0.03,
  /** Amortiguamiento del motor como fracción del torque máximo (N·m por rad/s). */
  motorDampingFactor: 0.2,
  limpDamping: 1.5,
  /** Multiplicadores globales, ajustables en vivo. */
  torqueScale: 1.0,
  muscleScale: 1.0,
  fatigueScale: 1.0,
  loadScale: 1.0,

  // ---------- Episodios ----------
  episodeSeconds: 10,
  lingerSeconds: 0.8,
  terrainLength: 140,
  terrainHalfWidth: 22,
  laneWidth: 1.4,

  // ---------- Evolución ----------
  sampledPerGeneration: 24,
  initialSigma: 0.35,
  sigmaMin: 0.1,
  cpgScale: 0.5,
  nnScale: 0.12,
  nnHidden: 64,
  nnStartAssist: 0.85,
  targetSpeed: 1.6,

  // ---------- Recompensa base (se especializa por disciplina en TASKS) ----------
  reward: {
    alive: 0.6,
    forward: 8.0,
    energy: 0.6,
    jerk: 1.2,
    straight: 0.8,
    drag: 2.0,
    stepBonus: 0.7,
    sameFootPenalty: 0.2,
    fall: 2.5,
  },
  fall: {
    pelvisMinHeight: 0.5,
    headMinHeight: 0.7,
    minUpright: 0.35,
  },

  // ---------- Arnés de equilibrio ----------
  assist: {
    start: 1.0,
    tiltKp: 120,
    tiltKd: 16,
    yawKp: 40,
    yawKd: 8,
    weightSupport: 0.5,
    step: 0.08,
    minDist: 1.5,
    stallGenerations: 40,
    slowStep: 0.04,
    unlockMax: 0.25,
  },

  unlockDistances: [0, 6, 9, 12],

  // ---------- Rendimiento ----------
  agentsDesktop: 24,
  agentsMobile: 12,
  minAgents: 4,
  simBudgetMs: 9,
  pushImpulse: 140,

  // ---------- Modelo muscular de Hill simplificado ----------
  muscles: {
    activationTau: 0.045, // s: contracción
    relaxationTau: 0.09, // s: relajación
    fatigueRate: 0.22, // por s a activación 1
    recoveryRate: 0.12, // por s en reposo
    vmax: 9, // rad/s: velocidad de acortamiento
    efficiency: 0.25, // músculo → trabajo mecánico
    restingCost: 12, // W en reposo
    strengthFloor: 0.42, // fuerza residual con fatiga = 1
  },

  // ---------- Cerebro: banco MoE de 100.000.000 parámetros ----------
  // 5 disciplinas × 200 expertos × (250 entradas × 400 salidas) = 100.000.000 pesos.
  // Los pesos son int8 virtuales, generados por hash determinista; solo se activa
  // un subconjunto disperso en cada decisión (2 expertos × 24 filas × 250 columnas).
  brain: {
    targetParams: 100_000_000,
    expertsPerTask: 200,
    expertInput: 250,
    expertOutput: 400,
    topK: 2,
    activeRows: 24,
    hidden: 64,
    routerKeyDim: 8,
    seed: 0x1a2b3c4d,
    moeGainInit: 0.18,
    rowCache: 192,
  },
};

export type Config = typeof CONFIG;

export const TERRAINS = [
  { id: "flat", name: "Plano", icon: "▭" },
  { id: "slopes", name: "Pendientes", icon: "◢" },
  { id: "stairs", name: "Escalones", icon: "▟" },
  { id: "obstacles", name: "Obstáculos", icon: "▮" },
] as const;

export type TerrainId = (typeof TERRAINS)[number]["id"];

export interface TaskReward {
  alive: number;
  forward: number;
  energy: number;
  jerk: number;
  straight: number;
  drag: number;
  skill: number;
  event: number;
  combo: number;
}

export interface TaskDef {
  id: "walk" | "exercise" | "climb" | "boxing" | "parkour";
  name: string;
  icon: string;
  desc: string;
  metric: string;
  unit: string;
  target: number;
  episode: number;
  assistStart: number;
  loadKg: number;
  fall: { pelvisMinHeight: number; headMinHeight: number; minUpright: number };
  reward: TaskReward;
  stage: readonly number[];
  stageLabels: readonly string[];
}

export const TASKS = [
  {
    id: "walk",
    name: "Marcha",
    icon: "🚶",
    desc: "Locomoción con paso alterno, equilibrio y terrenos desbloqueables.",
    metric: "distancia",
    unit: "m",
    target: 30,
    episode: 10,
    assistStart: 1.0,
    loadKg: 0,
    fall: { pelvisMinHeight: 0.5, headMinHeight: 0.7, minUpright: 0.35 },
    reward: { alive: 0.6, forward: 8, energy: 0.6, jerk: 1.2, straight: 0.8, drag: 2, skill: 0, event: 0.7, combo: 0.2 },
    stage: [1, 2.2, 5, 9],
    stageLabels: ["Cae", "Gatea", "Pasos", "Camina", "Estable"],
  },
  {
    id: "exercise",
    name: "Ejercicio",
    icon: "🏋️",
    desc: "Sentadillas con 24 kg en las manos: repeticiones, trabajo vertical y fatiga.",
    metric: "repeticiones",
    unit: "rep",
    target: 8,
    episode: 12,
    assistStart: 0.55,
    loadKg: 24,
    fall: { pelvisMinHeight: 0.34, headMinHeight: 0.55, minUpright: 0.25 },
    reward: { alive: 0.8, forward: 0, energy: 0.9, jerk: 1.0, straight: 1.0, drag: 0.8, skill: 3.2, event: 3.5, combo: 0.4 },
    stage: [0.5, 2, 4, 7],
    stageLabels: ["Tambalea", "Flexiona", "Sentadillas", "Series", "Fuerza"],
  },
  {
    id: "climb",
    name: "Escalada",
    icon: "🧗",
    desc: "Pared con presas: fuerza de agarre, reaches alternos y altura.",
    metric: "altura",
    unit: "m",
    target: 3.5,
    episode: 14,
    assistStart: 0.6,
    loadKg: 0,
    fall: { pelvisMinHeight: 0.3, headMinHeight: 0.45, minUpright: 0.12 },
    reward: { alive: 0.7, forward: 0, energy: 0.9, jerk: 0.9, straight: 0.7, drag: 0.5, skill: 4.0, event: 1.4, combo: 0.8 },
    stage: [0.25, 0.7, 1.4, 2.4],
    stageLabels: ["Resbala", "Se cuelga", "Agarra", "Trepa", "Cumbre"],
  },
  {
    id: "boxing",
    name: "Boxeo",
    icon: "🥊",
    desc: "Saco de 45 kg con cuerda: impacto en newtons, combos y guardia.",
    metric: "golpes",
    unit: "golpes",
    target: 12,
    episode: 12,
    assistStart: 0.65,
    loadKg: 1.2,
    fall: { pelvisMinHeight: 0.42, headMinHeight: 0.6, minUpright: 0.22 },
    reward: { alive: 0.8, forward: 0, energy: 0.7, jerk: 0.8, straight: 1.0, drag: 0.4, skill: 1.6, event: 2.2, combo: 1.6 },
    stage: [1, 3, 6, 10],
    stageLabels: ["Sin contacto", "Rozando", "Golpea", "Combina", "Potencia"],
  },
  {
    id: "parkour",
    name: "Parkour",
    icon: "🤸",
    desc: "Huecos, muros y plataformas: saltos, vaults y aterrizajes.",
    metric: "recorrido",
    unit: "m",
    target: 40,
    episode: 14,
    assistStart: 0.75,
    loadKg: 0,
    fall: { pelvisMinHeight: 0.35, headMinHeight: 0.55, minUpright: 0.2 },
    reward: { alive: 0.6, forward: 7.0, energy: 0.7, jerk: 1.0, straight: 0.9, drag: 1.6, skill: 1.2, event: 2.0, combo: 0.8 },
    stage: [2, 6, 14, 26],
    stageLabels: ["Hueco", "Brinca", "Vaults", "Fluido", "Traceur"],
  },
] as const satisfies readonly TaskDef[];

export type TaskId = (typeof TASKS)[number]["id"];
export const TASK_COUNT = TASKS.length;
export function taskIndex(id: TaskId): number {
  const i = TASKS.findIndex((t) => t.id === id);
  return i < 0 ? 0 : i;
}
export function taskDef(id: TaskId): TaskDef {
  return TASKS[taskIndex(id)] as TaskDef;
}
