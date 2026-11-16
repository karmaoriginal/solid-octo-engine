/**
 * Datos del personaje (sin dependencias de física): segmentos, articulaciones, límites y torques.
 * Se usan tanto en el simulador (worker) como en la interfaz (nombres de articulaciones, formas).
 */
export type Part = "torso" | "limb" | "foot" | "head" | "hidden";

export interface BodySpec {
  name: string;
  shape: "box" | "capsule" | "ball" | "dummy";
  pos: [number, number, number];
  /** box: half extents; capsule: [halfHeight, radius]; ball: [radius] */
  size: number[];
  mass: number;
  friction: number;
  part: Part;
}

export interface JointSpec {
  name: string;
  parent: string;
  child: string;
  anchor: [number, number, number]; // en coordenadas del mundo, pose de reposo
  axis: [number, number, number];
  min: number;
  max: number;
  rest: number;
  maxTorque: number; // N·m
}

const SIDES: [string, number][] = [
  ["L", 1],
  ["R", -1],
];

const bodies: BodySpec[] = [
  { name: "pelvis", shape: "box", pos: [0, 0.95, 0], size: [0.08, 0.06, 0.13], mass: 9, friction: 0.6, part: "torso" },
  { name: "chest", shape: "box", pos: [0, 1.18, 0], size: [0.09, 0.17, 0.15], mass: 23.3, friction: 0.6, part: "torso" },
  { name: "head", shape: "ball", pos: [0, 1.47, 0], size: [0.1], mass: 4.5, friction: 0.6, part: "head" },
  { name: "spineD", shape: "dummy", pos: [0, 1.01, 0], size: [], mass: 1, friction: 0, part: "hidden" },
];
for (const [s, k] of SIDES) {
  const z = k * 0.09;
  const za = k * 0.2;
  bodies.push(
    { name: "hipD" + s, shape: "dummy", pos: [0, 0.9, z], size: [], mass: 1, friction: 0, part: "hidden" },
    { name: "thigh" + s, shape: "capsule", pos: [0, 0.69, z], size: [0.145, 0.065], mass: 7, friction: 0.6, part: "limb" },
    { name: "shin" + s, shape: "capsule", pos: [0, 0.28, z], size: [0.15, 0.05], mass: 3.2, friction: 0.6, part: "limb" },
    { name: "ankleD" + s, shape: "dummy", pos: [0, 0.08, z], size: [], mass: 0.6, friction: 0, part: "hidden" },
    { name: "foot" + s, shape: "box", pos: [0.04, 0.035, z], size: [0.12, 0.035, 0.055], mass: 1.4, friction: 1.4, part: "foot" },
    { name: "shoulderD" + s, shape: "dummy", pos: [0, 1.31, za], size: [], mass: 0.5, friction: 0, part: "hidden" },
    { name: "uarm" + s, shape: "capsule", pos: [0, 1.17, za], size: [0.1, 0.04], mass: 2, friction: 0.6, part: "limb" },
    { name: "farm" + s, shape: "capsule", pos: [0, 0.9, za], size: [0.095, 0.035], mass: 1.4, friction: 0.6, part: "limb" },
  );
}

const joints: JointSpec[] = [
  // ---- Columna y cuello ----
  { name: "Columna (inclinar)", parent: "spineD", child: "chest", anchor: [0, 1.01, 0], axis: [0, 0, -1], min: -0.4, max: 0.6, rest: 0.05, maxTorque: 110 },
  { name: "Columna (lateral)", parent: "pelvis", child: "spineD", anchor: [0, 1.01, 0], axis: [1, 0, 0], min: -0.35, max: 0.35, rest: 0, maxTorque: 90 },
  { name: "Cuello", parent: "chest", child: "head", anchor: [0, 1.37, 0], axis: [0, 0, -1], min: -0.6, max: 0.6, rest: 0, maxTorque: 12 },
];
for (const [s, k] of SIDES) {
  const z = k * 0.09;
  joints.push(
    { name: `Cadera ${s} (flexión)`, parent: "hipD" + s, child: "thigh" + s, anchor: [0, 0.9, z], axis: [0, 0, 1], min: -0.6, max: 1.4, rest: 0.0, maxTorque: 220 },
    { name: `Cadera ${s} (abducción)`, parent: "pelvis", child: "hipD" + s, anchor: [0, 0.9, z], axis: [k, 0, 0].map((v) => -v) as [number, number, number], min: -0.3, max: 0.6, rest: 0.0, maxTorque: 170 },
    { name: `Rodilla ${s}`, parent: "thigh" + s, child: "shin" + s, anchor: [0, 0.48, z], axis: [0, 0, -1], min: 0, max: 2.2, rest: 0.05, maxTorque: 220 },
    { name: `Tobillo ${s} (flexión)`, parent: "ankleD" + s, child: "foot" + s, anchor: [0, 0.08, z], axis: [0, 0, 1], min: -0.7, max: 0.5, rest: 0, maxTorque: 160 },
    { name: `Tobillo ${s} (lateral)`, parent: "shin" + s, child: "ankleD" + s, anchor: [0, 0.08, z], axis: [-k, 0, 0], min: -0.35, max: 0.35, rest: 0, maxTorque: 110 },
  );
}
for (const [s, k] of SIDES) {
  const za = k * 0.2;
  joints.push(
    { name: `Hombro ${s} (flexión)`, parent: "shoulderD" + s, child: "uarm" + s, anchor: [0, 1.31, za], axis: [0, 0, 1], min: -1.5, max: 2.0, rest: 0, maxTorque: 35 },
    { name: `Hombro ${s} (abducción)`, parent: "chest", child: "shoulderD" + s, anchor: [0, 1.31, za], axis: [-k, 0, 0], min: -0.1, max: 1.6, rest: 0.12, maxTorque: 25 },
    { name: `Codo ${s}`, parent: "uarm" + s, child: "farm" + s, anchor: [0, 1.03, za], axis: [0, 0, 1], min: 0, max: 2.4, rest: 0.3, maxTorque: 25 },
  );
}

export const BODY_SPECS = bodies;
export const JOINT_SPECS = joints;
export const N_JOINTS = joints.length; // 19 grados de libertad
export const N_BODIES = bodies.length;
export const STAND_PELVIS_Y = 0.95;
export const TOTAL_MASS = bodies.reduce((a, b) => a + b.mass, 0); // 72.0 kg
export const BODY_MASS_KG = TOTAL_MASS;

/** Grupos de colisión de Rapier. */
export const GROUP_AGENT = 0x00020001; // miembro 2, colisiona con miembro 1
export const GROUP_TERRAIN = 0x0001ffff; // miembro 1, colisiona con todos
export const GROUP_PROP_VS_AGENT = 0x00010002; // saco: miembro 1, solo con agentes

const idx: Record<string, number> = {};
bodies.forEach((b, i) => (idx[b.name] = i));
export const BODY_INDEX = idx;

/** Índices de los segmentos que se dibujan (todos menos las bisagras invisibles). */
export const RENDER_BODIES = BODY_SPECS.map((b, i) => (b.shape === "dummy" ? -1 : i)).filter((i) => i >= 0);
export const RENDER_COUNT = RENDER_BODIES.length;
