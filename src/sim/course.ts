import { CONFIG, TERRAINS, taskDef, type TaskId, type TerrainId } from "../config";
import { buildProfile, type Piece } from "./terrain";

/**
 * Escenarios por disciplina. El mismo layout alimenta las colisiones (worker),
 * el dibujado 3D (scene) y las recompensas (sim).
 */

export interface Structure {
  kind: "box" | "sphere" | "cylinder";
  pos: [number, number, number];
  /** box: semiejes [hx,hy,hz]; sphere: [radio]; cylinder: [radio, semialtura] */
  size: number[];
  color: number;
  solid?: boolean;
  rotation?: [number, number, number];
  opacity?: number;
}

export interface Hold {
  id: number;
  level: number;
  side: number;
  x: number;
  y: number;
  z: number;
}

export interface Wall {
  id: number;
  x: number;
  h: number;
}

export interface BagSpec {
  pos: [number, number, number];
  anchor: [number, number, number];
  radius: number;
  halfHeight: number;
  mass: number;
  restLength: number;
  k: number;
  damping: number;
}

export interface TaskLayout {
  task: TaskId;
  terrain: number;
  profile: Piece[];
  structures: Structure[];
  holds: Hold[];
  walls: Wall[];
  bag: BagSpec | null;
  propKind: "none" | "weight" | "glove";
  loadKg: number;
  spawnY: number;
  goal: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const load = (kg: number) => Math.round(kg * CONFIG.loadScale * 10) / 10;

function parkourProfile(): { profile: Piece[]; walls: Wall[] } {
  const L = CONFIG.terrainLength;
  const p: Piece[] = [];
  const walls: Wall[] = [];
  let x = -30;
  let y = 0;
  const flat = (len: number) => {
    p.push({ x0: x, x1: x + len, y0: y, y1: y });
    x += len;
  };
  const hole = (len: number) => {
    p.push({ x0: x, x1: x + len, y0: -4, y1: -4, hole: true });
    x += len;
  };
  const jump = (dy: number) => {
    y += dy;
  };
  flat(36); // x=-30 → 6 m de aproximación
  let i = 0;
  while (x < L) {
    flat(3.4);
    if (i % 2 === 0) {
      hole(1.0 + 0.14 * (i % 3));
      flat(3.1);
    } else {
      jump(0.16 + 0.03 * (i % 3));
      flat(2.2);
      jump(-(0.16 + 0.03 * (i % 3)));
      flat(2.8);
    }
    const h = 0.26 + 0.07 * (i % 5);
    walls.push({ id: walls.length, x: x + 0.85, h });
    flat(4.2);
    i++;
  }
  flat(60);
  return { profile: p, walls };
}

function flatTask(task: TaskId): Piece[] {
  void task;
  return buildProfile("flat");
}

export function buildTaskLayout(task: TaskId, terrainIdx: number): TaskLayout {
  const def = taskDef(task);
  const terrain = clamp(terrainIdx, 0, TERRAINS.length - 1);
  const tid = TERRAINS[terrain].id as TerrainId;
  const base: TaskLayout = {
    task,
    terrain,
    profile: buildProfile(tid),
    structures: [],
    holds: [],
    walls: [],
    bag: null,
    propKind: "none",
    loadKg: load(def.loadKg),
    spawnY: 0,
    goal: def.target,
  };

  if (task === "exercise") {
    base.profile = flatTask(task);
    base.propKind = "weight";
    base.structures = [
      { kind: "box", pos: [0, -0.015, 0], size: [1.3, 0.02, 0.9], color: 0x334155, solid: false, opacity: 0.85 },
      { kind: "cylinder", pos: [-0.42, 0.72, -0.48], size: [0.025, 0.72], color: 0x475569, solid: false },
      { kind: "cylinder", pos: [-0.42, 0.72, 0.48], size: [0.025, 0.72], color: 0x475569, solid: false },
      { kind: "cylinder", pos: [-0.42, 1.43, 0], size: [0.025, 0.48], color: 0x94a3b8, solid: false, rotation: [Math.PI / 2, 0, 0] },
      { kind: "box", pos: [-0.42, 0.02, 0], size: [0.18, 0.03, 0.65], color: 0x1e293b, solid: false },
    ];
  } else if (task === "climb") {
    base.profile = flatTask(task);
    base.structures.push({
      kind: "box", pos: [0.78, 2.45, 0], size: [0.16, 2.45, 0.9], color: 0x64748b, solid: true,
    });
    for (let i = 0; i < 13; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const h: Hold = {
        id: i,
        level: i + 1,
        side,
        x: i < 2 ? 0.3 : 0.48,
        y: 0.86 + i * 0.29,
        z: side * 0.22,
      };
      base.holds.push(h);
      base.structures.push({
        kind: "sphere", pos: [h.x, h.y, h.z], size: [0.065], color: side > 0 ? 0xfbbf24 : 0x38bdf8, solid: false,
      });
    }
    base.structures.push({ kind: "box", pos: [0.55, 0.08, 0], size: [0.24, 0.08, 0.7], color: 0x475569, solid: true });
  } else if (task === "boxing") {
    base.profile = flatTask(task);
    base.propKind = "glove";
    base.bag = {
      pos: [0.92, 1.42, 0],
      anchor: [0.92, 2.78, 0],
      radius: 0.22,
      halfHeight: 0.42,
      mass: 45,
      restLength: 1.14,
      k: 2600,
      damping: 95,
    };
    base.structures = [
      { kind: "box", pos: [0.45, -0.015, 0], size: [1.5, 0.02, 0.9], color: 0x1e293b, solid: false, opacity: 0.8 },
      { kind: "box", pos: [0.92, 2.84, 0], size: [0.34, 0.06, 0.34], color: 0x475569, solid: false },
      { kind: "cylinder", pos: [0.92, 2.69, 0], size: [0.015, 0.14], color: 0x94a3b8, solid: false },
      { kind: "sphere", pos: [0.92, 1.42, 0], size: [0.26], color: 0xef4444, solid: false, opacity: 0.14 },
    ];
  } else if (task === "parkour") {
    const pk = parkourProfile();
    base.profile = pk.profile;
    base.walls = pk.walls;
    base.structures = pk.walls.map((w) => ({
      kind: "box" as const,
      pos: [w.x, w.h / 2, 0] as [number, number, number],
      size: [0.12, w.h / 2, 0.9],
      color: 0xf97316,
      solid: true,
    }));
    base.structures.push({ kind: "box", pos: [8, 0.02, 0], size: [3, 0.02, 0.7], color: 0x0f172a, solid: false, opacity: 0.4 });
  }
  return base;
}
