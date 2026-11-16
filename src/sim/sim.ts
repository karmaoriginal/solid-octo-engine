import RAPIER from "@dimforge/rapier3d-compat";
import { CONFIG, TASKS, TERRAINS, taskDef, taskIndex, type TaskDef, type TaskId, type TerrainId } from "../config";
import { Agent, N_JOINTS, N_OBS, TOTAL_MASS } from "./character";
import { BODY_INDEX, GROUP_PROP_VS_AGENT, GROUP_TERRAIN, JOINT_SPECS } from "./spec";
import { Evolution } from "./es";
import { BRAIN_INFO, CPG_PARAMS, GENOME_SIZE, Policy, initGenome, mutationScales } from "./policy";
import { makeRng, type Rng } from "./rng";
import { buildTaskLayout, type Hold, type TaskLayout, type Wall } from "./course";
import { pieceBox, terrainY, type Piece } from "./terrain";
import { CTX, CTX_SIZE, PROP_COUNT, PROP_STRIDE, createTaskMetrics, type PhysicsSettings, type TaskMetrics } from "./tasks";
import { MUSCLE_VIEW_SIZE } from "./muscles";

/** Alias de importación para mantener limpio el bloque de arriba. */
export type { PhysicsSettings } from "./tasks";

/**
 * ============================================================
 *  SIMULACIÓN MULTIDISCIPLINA
 * ============================================================
 * Un mundo de Rapier por personaje. Cada disciplina tiene su propio cerebro
 * evolutivo (élite, media, historial, arnés y terrenos desbloqueados) y comparte
 * el banco MoE de 100 M parámetros. Las recompensas y la física de los objetos
 * cambian con la disciplina: pesas, presas, saco, huecos y muros.
 */

export type Mode = "train" | "test" | "manual";
type Role = "es" | "brain" | "manual";
type SlotState = "run" | "linger" | "idle";

export interface GenStat {
  gen: number;
  task: TaskId;
  terrain: number;
  bestMetric: number;
  meanMetric: number;
  bestFit: number;
  meanFit: number;
  meanTime: number;
}

interface Result {
  fit: number;
  metric: number;
  time: number;
}

interface BrainState {
  evo: Evolution;
  history: GenStat[];
  assist: number;
  assistStall: number;
  terrainBest: number[];
  unlocked: number;
  bestEver: number;
  terrainIdx: number;
}

export interface TaskBrainFile {
  mean: number[];
  elite: number[];
  sigma: number;
  gen: number;
  eliteFit: number;
  history: GenStat[];
  terrainBest: number[];
  unlocked: number;
  assist: number;
  terrainIdx: number;
  bestEver: number;
}

export interface BrainFile {
  format: "ia-camina";
  version: 2;
  genomeSize: number;
  activeTask: TaskId;
  tasks: Partial<Record<TaskId, TaskBrainFile>>;
  savedAt: string;
  model: typeof BRAIN_INFO;
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const findJoint = (re: RegExp) => JOINT_SPECS.findIndex((j) => re.test(j.name));
const J_SHOULDER = [findJoint(/Hombro L \(flexión\)/), findJoint(/Hombro R \(flexión\)/)];
const J_ELBOW = [findJoint(/Codo L/), findJoint(/Codo R/)];
const FOREARM = [BODY_INDEX.farmL, BODY_INDEX.farmR];
const CONTACT_DT = 0.06; // duración estimada del impacto de un puño

interface Mechanics {
  events: number;
  combos: number;
  penalty: number;
  skill: number;
  forward: number;
}

export class Slot {
  world!: RAPIER.World;
  bag: RAPIER.RigidBody | null = null;
  agent!: Agent;
  role: Role = "es";
  policy = new Policy();
  state: SlotState = "idle";
  laneZ = 0;
  cand = -1;
  phys = 0;
  t = 0;
  fit = 0;
  metric = 0;
  maxMetric = 0;
  x0 = 0;
  lingerT = 0;
  fell = false;
  contact = [true, true];
  lastStepFoot = -1;
  lastStepX = 0;
  obs = new Float32Array(N_OBS);
  u = new Float32Array(N_JOINTS);
  uPrev = new Float32Array(N_JOINTS);
  ctx = new Float32Array(CTX_SIZE);
  muscleView = new Float32Array(MUSCLE_VIEW_SIZE);
  metrics = createTaskMetrics();
  eventCount = 0;
  eventPrev = 0;
  comboPrev = 0;

  build(layout: TaskLayout) {
    if (this.world) this.world.free();
    const w = new RAPIER.World({ x: 0, y: CONFIG.gravity * CONFIG.gravityScale, z: 0 });
    w.timestep = CONFIG.physicsDt;
    w.integrationParameters.numSolverIterations = CONFIG.solverIterations;
    const ground = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const hw = CONFIG.terrainHalfWidth;
    for (const p of layout.profile) {
      if (p.hole) continue;
      const b = pieceBox(p);
      w.createCollider(
        RAPIER.ColliderDesc.cuboid(b.halfLen, b.halfThick, hw)
          .setTranslation(b.cx, b.cy, 0)
          .setRotation({ x: 0, y: 0, z: Math.sin(b.angle / 2), w: Math.cos(b.angle / 2) })
          .setFriction(CONFIG.groundFriction)
          .setRestitution(0)
          .setCollisionGroups(GROUP_TERRAIN),
        ground,
      );
    }
    for (const st of layout.structures) {
      if (!st.solid || st.kind !== "box") continue;
      w.createCollider(
        RAPIER.ColliderDesc.cuboid(st.size[0], st.size[1], st.size[2])
          .setTranslation(st.pos[0], st.pos[1], st.pos[2])
          .setFriction(CONFIG.groundFriction)
          .setRestitution(0)
          .setCollisionGroups(GROUP_TERRAIN),
        ground,
      );
    }
    this.bag = null;
    if (layout.bag) {
      const B = layout.bag;
      const body = w.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(B.pos[0], B.pos[1], B.pos[2])
          .setLinearDamping(0.25)
          .setAngularDamping(0.7)
          .setCanSleep(false),
      );
      w.createCollider(
        RAPIER.ColliderDesc.capsule(B.halfHeight, B.radius)
          .setMass(B.mass)
          .setFriction(0.8)
          .setRestitution(0.15)
          .setCollisionGroups(GROUP_PROP_VS_AGENT),
        body,
      );
      this.bag = body;
    }
    this.world = w;
    this.agent = new Agent(w, layout.loadKg);
  }
  dispose() {
    if (this.world) this.world.free();
  }
}

export class Simulation {
  slots: Slot[] = [];
  mode: Mode = "train";
  taskId: TaskId = "walk";
  layout!: TaskLayout;
  terrainIdx = 0;
  terrainVersion = 0;
  unlocked = 0;
  autoCurriculum = true;
  terrainBest: number[] = TERRAINS.map(() => 0);
  unlockAll = false;
  assist = CONFIG.assist.start;
  autoAssist = true;
  private assistStall = 0;
  private bestEver = 0;

  evo!: Evolution;
  history: GenStat[] = [];
  private brains = new Map<TaskId, BrainState>();
  private rng: Rng = makeRng(Date.now() & 0xffffff);
  private nextCand = 0;
  private results: (Result | null)[] = [];
  private completed = 0;
  manualU = new Float32Array(N_JOINTS);
  focus = 0;
  physSteps = 0;
  events: string[] = [];
  desiredSlots = CONFIG.agentsDesktop;

  static async create(): Promise<Simulation> {
    await RAPIER.init();
    const s = new Simulation();
    s.init();
    return s;
  }

  private init() {
    this.buildLayout("walk", 0);
    const b = this.ensureBrain("walk");
    this.activateBrain(b);
    this.results = this.evo.cands.map(() => null);
  }

  get profile(): Piece[] {
    return this.layout.profile;
  }

  private buildLayout(task: TaskId, terrain: number) {
    this.layout = buildTaskLayout(task, terrain);
    this.terrainVersion++;
  }

  // ------------------------------------------------------------------ cerebros por disciplina
  private ensureBrain(id: TaskId): BrainState {
    let b = this.brains.get(id);
    if (!b) {
      const evo = new Evolution(initGenome(this.rng), mutationScales(), this.rng);
      evo.denseCount = CPG_PARAMS;
      evo.nnFactor = 0.2;
      evo.ask();
      b = {
        evo,
        history: [],
        assist: taskDef(id).assistStart,
        assistStall: 0,
        terrainBest: TERRAINS.map(() => 0),
        unlocked: 0,
        bestEver: 0,
        terrainIdx: 0,
      };
      this.brains.set(id, b);
    }
    return b;
  }

  private saveBrainState() {
    const b = this.brains.get(this.taskId);
    if (!b) return;
    b.evo = this.evo;
    b.history = this.history;
    b.assist = this.assist;
    b.assistStall = this.assistStall;
    b.terrainBest = this.terrainBest;
    b.unlocked = this.unlocked;
    b.bestEver = this.bestEver;
    b.terrainIdx = this.terrainIdx;
  }

  private activateBrain(b: BrainState) {
    this.evo = b.evo;
    this.history = b.history;
    this.assist = b.assist;
    this.assistStall = b.assistStall;
    this.terrainBest = b.terrainBest;
    this.unlocked = b.unlocked;
    this.bestEver = b.bestEver;
    this.terrainIdx = b.terrainIdx;
    this.updateNnStage();
  }

  setTask(id: TaskId) {
    if (id === this.taskId || !TASKS.some((t) => t.id === id)) return;
    this.saveBrainState();
    this.taskId = id;
    const b = this.ensureBrain(id);
    this.activateBrain(b);
    this.buildLayout(id, this.terrainIdx);
    const def = taskDef(id);
    this.events.push(`${def.icon} Disciplina: ${def.name} — cerebro propio`);
    this.restartAll(true);
  }

  isUnlocked(i: number) {
    return this.unlockAll || i <= this.unlocked;
  }

  setTerrain(i: number) {
    if (this.taskId !== "walk" || !this.isUnlocked(i) || i === this.terrainIdx) return;
    this.terrainIdx = i;
    this.buildLayout(this.taskId, i);
    this.restartAll(true);
  }

  setPhysics(p: PhysicsSettings) {
    CONFIG.gravityScale = clamp(p.gravityScale, 0.2, 2);
    CONFIG.loadScale = clamp(p.loadScale, 0.2, 2);
    CONFIG.muscleScale = clamp(p.muscleScale, 0.4, 1.8);
    CONFIG.fatigueScale = clamp(p.fatigueScale, 0, 2.5);
    CONFIG.groundFriction = clamp(p.groundFriction, 0.3, 1.8);
    this.buildLayout(this.taskId, this.terrainIdx);
    this.restartAll(true);
    this.events.push("⚙️ Física recalculada: masa, gravedad, fuerza y fricción");
  }

  // ------------------------------------------------------------------ slots y modos
  configure(mode: Mode) {
    this.mode = mode;
    const roles: Role[] =
      mode === "train" ? Array.from({ length: this.desiredSlots }, () => "es" as Role) : mode === "test" ? ["brain"] : ["manual", "brain"];
    while (this.slots.length > roles.length) this.slots.pop()!.dispose();
    while (this.slots.length < roles.length) this.slots.push(new Slot());
    const n = roles.length;
    this.slots.forEach((s, i) => {
      s.role = roles[i];
      s.laneZ = (i - (n - 1) / 2) * CONFIG.laneWidth;
    });
    this.focus = 0;
    this.restartAll(true);
  }

  setSlotCount(n: number) {
    this.desiredSlots = n;
    if (this.mode === "train" && n !== this.slots.length) this.configure("train");
  }

  restartAll(resetGeneration: boolean) {
    if (resetGeneration || this.mode !== "train") {
      this.nextCand = 0;
      this.completed = 0;
      this.results = this.evo.cands.map(() => null);
    }
    for (const s of this.slots) this.startEpisode(s);
  }

  resetSlot(i: number) {
    const s = this.slots[i];
    if (s) this.startEpisode(s);
  }

  private startEpisode(s: Slot) {
    const ti = taskIndex(this.taskId);
    if (s.role === "es") {
      if (this.nextCand >= this.evo.cands.length) {
        s.state = "idle";
        s.cand = -1;
        if (s.world) s.agent.freeze();
        return;
      }
      s.cand = this.nextCand++;
      s.policy.set(this.evo.cands[s.cand], ti);
    } else if (s.role === "brain") {
      s.policy.set(this.evo.elite, ti);
    }
    s.build(this.layout);
    const a = s.agent;
    a.reset(0, 0, this.layout.spawnY);
    s.state = "run";
    s.phys = 0;
    s.t = 0;
    s.fit = 0;
    s.metric = 0;
    s.maxMetric = 0;
    s.lingerT = 0;
    s.fell = false;
    s.contact[0] = s.contact[1] = true;
    s.lastStepFoot = -1;
    s.lastStepX = 0;
    s.x0 = 0;
    s.u.fill(0);
    s.uPrev.fill(0);
    s.ctx.fill(0);
    s.metrics = createTaskMetrics();
    s.eventCount = 0;
    s.eventPrev = 0;
    s.comboPrev = 0;
    this.decide(s);
  }

  private decide(s: Slot) {
    const a = s.agent;
    const dtc = CONFIG.physicsDt * CONFIG.controlEvery;
    a.readState(dtc);
    if (s.role === "manual") {
      s.u.set(this.manualU);
    } else {
      a.observe(s.obs, s.t, s.policy.freq, this.layout.profile, taskIndex(this.taskId), s.ctx);
      s.policy.act(s.obs, s.t, s.u);
    }
    s.uPrev.set(s.u);
    a.applyActions(s.u, dtc);
  }

  // ------------------------------------------------------------------ paso de simulación
  stepOnce() {
    this.physSteps++;
    const dt = CONFIG.physicsDt;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.state === "idle") continue;
      if (this.assist > 0 && s.state === "run") s.agent.driveUpright(this.assist, dt);
      this.coursePhysics(s, dt);
      s.world.step();
      s.phys++;
      if (s.state === "linger") {
        s.lingerT += dt;
        if (s.lingerT >= CONFIG.lingerSeconds) this.startEpisode(s);
        continue;
      }
      if (s.phys % CONFIG.controlEvery === 0) this.control(s);
    }
  }

  /** Cuerda del saco de boxeo: fuerza de resorte + amortiguador sobre 45 kg. */
  private coursePhysics(s: Slot, dt: number) {
    const B = this.layout.bag;
    if (!B || !s.bag) return;
    void dt;
    const bag = s.bag;
    bag.resetForces(false);
    const p = bag.translation();
    const v = bag.linvel();
    const dx = B.anchor[0] - p.x, dy = B.anchor[1] - p.y, dz = B.anchor[2] - p.z;
    const d = Math.hypot(dx, dy, dz);
    if (d <= B.restLength || d < 1e-5) return;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    const vAlong = v.x * ux + v.y * uy + v.z * uz;
    const f = clamp(B.k * (d - B.restLength) - B.damping * vAlong, -2500, 5000);
    bag.addForce({ x: ux * f, y: uy * f, z: uz * f }, true);
  }

  /** Un paso de control (30 Hz): leer, recompensar, decidir, actuar. */
  private control(s: Slot) {
    const a = s.agent;
    const def = taskDef(this.taskId);
    const F = def.fall;
    const dtc = CONFIG.physicsDt * CONFIG.controlEvery;
    s.t += dtc;

    a.clearExternalForces();
    a.readState(dtc);
    const prof = this.layout.profile;
    const g = terrainY(prof, a.px);
    a.applyAssistForce(this.assist, g);
    const h = a.py - g;
    const pit = g < -2 && a.py < -0.35;
    const fell =
      pit || a.py < -0.6 || h < F.pelvisMinHeight ||
      a.headY - g < F.headMinHeight || a.upY < F.minUpright || a.chestUpY < F.minUpright;

    if (fell) {
      s.fell = true;
      a.goLimp();
      s.state = "linger";
      s.lingerT = 0;
      if (s.role === "es") {
        s.fit -= CONFIG.reward.fall;
        this.finishEs(s);
      }
      return;
    }

    if (s.role === "manual") {
      s.u.set(this.manualU);
      this.taskMechanics(s, a, s.u, dtc, g);
      s.uPrev.set(s.u);
      a.applyActions(s.u, dtc);
      return;
    }

    this.fillContext(s, a, g);
    a.observe(s.obs, s.t, s.policy.freq, prof, taskIndex(this.taskId), s.ctx);
    s.policy.act(s.obs, s.t, s.u);
    const mech = this.taskMechanics(s, a, s.u, dtc, g);

    if (s.role === "es") {
      s.fit += this.reward(s, a, def, dtc, g, mech);
      if (s.t >= def.episode) {
        if (!this.finishEs(s)) this.startEpisode(s);
        return;
      }
    } else if (s.role === "brain") {
      if (s.t >= def.episode || a.px > CONFIG.terrainLength - 5 || s.metric >= def.target * 1.5) {
        this.startEpisode(s);
        return;
      }
    }
    s.uPrev.set(s.u);
    a.applyActions(s.u, dtc);
  }

  private fillContext(s: Slot, a: Agent, g: number) {
    const ctx = s.ctx;
    const def = taskDef(this.taskId);
    const m = s.metrics;
    const gravity = Math.abs(CONFIG.gravity * CONFIG.gravityScale);
    const handSpeed = (Math.hypot(a.handVel[0].x, a.handVel[0].y, a.handVel[0].z) + Math.hypot(a.handVel[1].x, a.handVel[1].y, a.handVel[1].z)) * 0.5;
    const ph = 2 * Math.PI * s.policy.freq * s.t;
    ctx[CTX.goal] = clamp((def.target - s.metric) / def.target, -1, 1);
    ctx[CTX.metric] = clamp((s.metric / def.target) * 2 - 1, -1, 1);
    ctx[CTX.load] = clamp((this.layout.loadKg / 30) * 2 - 1, -1, 1);
    ctx[CTX.fatigue] = clamp(a.muscles.meanFatigue * 2 - 1, -1, 1);
    ctx[CTX.support] = clamp(a.supportN / (a.totalMassKg * gravity * 2) - 0.5, -1, 1);
    ctx[CTX.speed] = clamp(a.vx / 3, -1, 1);
    ctx[CTX.handSpeed] = clamp((handSpeed / 8) * 2 - 1, -1, 1);
    ctx[CTX.sin] = Math.sin(ph);
    ctx[CTX.cos] = Math.cos(ph);
    if (s.bag) {
      const p = s.bag.translation();
      const v = s.bag.linvel();
      const d = Math.min(
        Math.hypot(a.handPos[0].x - p.x, a.handPos[0].y - p.y, a.handPos[0].z - p.z),
        Math.hypot(a.handPos[1].x - p.x, a.handPos[1].y - p.y, a.handPos[1].z - p.z),
      );
      ctx[CTX.bagDist] = clamp((d / 1.2) * 2 - 1, -1, 1);
      ctx[CTX.bagSpeed] = clamp((Math.hypot(v.x, v.y, v.z) / 3) * 2 - 1, -1, 1);
    } else {
      ctx[CTX.bagDist] = 1;
      ctx[CTX.bagSpeed] = -1;
    }
    let hd = 2;
    for (const hold of this.layout.holds) {
      hd = Math.min(hd, Math.hypot(a.handPos[0].x - hold.x, a.handPos[0].y - hold.y, a.handPos[0].z - hold.z));
    }
    ctx[CTX.holdDist] = clamp((hd / 1.2) * 2 - 1, -1, 1);
    ctx[CTX.holdLevel] = clamp((m.maxHold / Math.max(1, this.layout.holds.length)) * 2 - 1, -1, 1);
    ctx[CTX.gripL] = m.gripL >= 0 ? 1 : -1;
    ctx[CTX.gripR] = m.gripR >= 0 ? 1 : -1;
    let wallAhead = 10;
    for (const w of this.layout.walls) if (w.x > a.px) wallAhead = Math.min(wallAhead, w.x - a.px);
    ctx[CTX.wallAhead] = clamp((wallAhead / 8) * 2 - 1, -1, 1);
    void g;
  }

  /** Física y eventos específicos de cada disciplina; devuelve señales para la recompensa. */
  private taskMechanics(s: Slot, a: Agent, u: Float32Array, dtc: number, g: number): Mechanics {
    const def = taskDef(this.taskId);
    const m = s.metrics;
    const upright = clamp(a.upY, 0, 1) * clamp(a.chestUpY, 0, 1);
    const dist = a.px - s.x0;
    let events = 0, combos = 0, penalty = 0, skill = 0, forward = 0;

    if (this.taskId === "walk") {
      s.metric = Math.max(s.metric, dist);
      forward = a.vx;
      for (let f = 0; f < 2; f++) {
        const c = a.footContact(f, this.layout.profile);
        if (c && !s.contact[f]) {
          if (s.lastStepFoot !== f) {
            if (a.px - s.lastStepX > 0.12) events++;
            s.lastStepX = a.px;
          } else penalty += def.reward.combo;
          s.lastStepFoot = f;
        }
        s.contact[f] = c;
      }
    } else if (this.taskId === "exercise") {
      const depth = clamp((0.95 - (a.py - g)) / 0.42, 0, 1);
      const work = Math.max(0, a.vy) * a.totalMassKg * Math.abs(CONFIG.gravity * CONFIG.gravityScale) * dtc;
      m.workJ += work;
      m.minPelvis = Math.min(m.minPelvis, a.py - g);
      if (!m.squatDown && a.py - g < 0.66) m.squatDown = true;
      if (m.squatDown && a.py - g > 0.86 && a.upY > 0.65) {
        m.reps++;
        m.squatDown = false;
        events++;
      }
      s.metric = Math.max(s.metric, m.reps);
      skill = depth * (0.4 + 0.6 * upright) + Math.min(1, work / 50) * 0.3;
    } else if (this.taskId === "climb") {
      const height = clamp(a.py - this.layout.spawnY - 0.95, 0, 6);
      s.metric = Math.max(s.metric, height);
      skill = height * 0.7 + (m.gripL >= 0 ? 0.3 : 0) + (m.gripR >= 0 ? 0.3 : 0);
      // updateGrips contabiliza las presas nuevas directamente en s.eventCount.
      this.updateGrips(s, a, u, dtc);
    } else if (this.taskId === "boxing") {
      s.metric = Math.max(s.metric, m.hits);
      // updatePunches contabiliza golpes y combos directamente en s.eventCount.
      this.updatePunches(s, a, dtc);
      skill = clamp(m.bagSpeed / 3, 0, 1) + clamp((a.handPos[0].y + a.handPos[1].y) / 2 - 0.9, 0, 0.6);
    } else if (this.taskId === "parkour") {
      const contact = a.footContact(0, this.layout.profile) || a.footContact(1, this.layout.profile);
      if (!contact && a.py - g > 0.6) {
        if (!m.airborne) {
          m.jumps++;
          m.airborne = true;
          m.airTime = 0;
        }
        m.airTime += dtc;
      } else if (contact && m.airborne) {
        if (m.airTime > 0.14 && Math.abs(a.vy) < 3.5) {
          m.landings++;
          events++;
        }
        m.airborne = false;
        m.airTime = 0;
      }
      for (const w of this.layout.walls) {
        if (a.px > w.x + 0.15 && !m.cleared.has(w.id) && a.py - g > w.h + 0.22) {
          m.cleared.add(w.id);
          m.wallsCleared++;
          events++;
        }
      }
      s.metric = Math.max(s.metric, dist);
      forward = a.vx;
      skill = Math.min(1, m.airTime) * 0.3 + m.wallsCleared * 0.1;
    }
    s.maxMetric = Math.max(s.maxMetric, s.metric);
    s.eventCount += events;
    void def;
    return { events, combos, penalty, skill, forward };
  }

  /** Agarres a presas: fuerza elástica limitada por fuerza muscular y fatiga. */
  private updateGrips(s: Slot, a: Agent, u: Float32Array, dtc: number) {
    const m = s.metrics;
    const holds: Hold[] = this.layout.holds;
    for (let side = 0; side < 2; side++) {
      const cur = side === 0 ? m.gripL : m.gripR;
      const hp = a.handPos[side];
      const wants = u[J_SHOULDER[side]] > 0.05 || u[J_ELBOW[side]] > 0.0;
      if (cur < 0 && wants) {
        let best = -1, bd = 0.34;
        for (const hold of holds) {
          const d = Math.hypot(hp.x - hold.x, hp.y - hold.y, hp.z - hold.z);
          if (d < bd) { bd = d; best = hold.id; }
        }
        if (best >= 0) {
          if (side === 0) { m.gripL = best; m.gripTimeL = 0; }
          else { m.gripR = best; m.gripTimeR = 0; }
          if (!m.touchedHolds.has(best)) {
            m.touchedHolds.add(best);
            m.holdTouches++;
            m.maxHold = Math.max(m.maxHold, holds[best].level);
            s.eventCount++;
          }
        }
      }
      const active = side === 0 ? m.gripL : m.gripR;
      if (active >= 0) {
        const hold = holds[active];
        const d = Math.hypot(hp.x - hold.x, hp.y - hold.y, hp.z - hold.z);
        const timer = side === 0 ? (m.gripTimeL += dtc) : (m.gripTimeR += dtc);
        const fatigue = Math.max(a.muscles.fatigue[J_SHOULDER[side]], a.muscles.fatigue[J_ELBOW[side]]);
        if (d > 0.62 || timer > 1.7 || fatigue > 0.95 || u[J_SHOULDER[side]] < -0.85) {
          if (side === 0) m.gripL = -1;
          else m.gripR = -1;
        } else {
          a.applyHandForce(side, hold, 1500, 70, a.muscles.gripForceN(side));
        }
      }
    }
  }

  /** Impactos al saco: J = m_efectiva·Δv, F = J/Δt, tercera ley en el antebrazo. */
  private updatePunches(s: Slot, a: Agent, dtc: number) {
    const B = this.layout.bag;
    if (!B || !s.bag) return;
    const m = s.metrics;
    m.cooldownL = Math.max(0, m.cooldownL - dtc);
    m.cooldownR = Math.max(0, m.cooldownR - dtc);
    const bag = s.bag;
    const p = bag.translation();
    const bv = bag.linvel();
    for (let side = 0; side < 2; side++) {
      const cooldown = side === 0 ? m.cooldownL : m.cooldownR;
      if (cooldown > 0) continue;
      const hp = a.handPos[side];
      const hv = a.handVel[side];
      const dr = Math.hypot(hp.x - p.x, hp.z - p.z);
      const dy = Math.abs(hp.y - p.y);
      const approaching = hv.x - bv.x;
      if (dy > B.halfHeight + 0.12 || dr > B.radius + 0.16 || approaching < 0.6 || hp.x > p.x + 0.15) continue;
      const effMass = clamp(1.2 + a.totalMassKg * 0.055, 2, 6); // brazo + tronco
      let J = clamp(effMass * approaching, 0, 120); // N·s
      J = Math.min(J, a.muscles.punchForceN(side) * CONTACT_DT * 2);
      const impulse = { x: J, y: J * 0.08, z: (side === 0 ? 1 : -1) * J * 0.06 };
      bag.applyImpulse(impulse, true);
      a.bodies[FOREARM[side]].applyImpulse({ x: -impulse.x, y: -impulse.y, z: -impulse.z }, true);
      m.peakPunchN = Math.max(m.peakPunchN, J / CONTACT_DT);
      m.bagSpeed = Math.hypot(bv.x + J / B.mass, bv.y, bv.z);
      m.hits++;
      s.eventCount++;
      if (m.lastHand !== side && s.t - m.lastHitT < 0.9) {
        m.combo++;
        s.eventCount++;
      }
      m.lastHand = side;
      m.lastHitT = s.t;
      if (side === 0) m.cooldownL = 0.22;
      else m.cooldownR = 0.22;
    }
  }

  private reward(s: Slot, a: Agent, def: TaskDef, dtc: number, g: number, mech: Mechanics): number {
    const R = def.reward;
    const upright = clamp(a.upY, 0, 1) * clamp(a.chestUpY, 0, 1);
    const hf = clamp((a.py - g - 0.45) / 0.5, 0, 1);
    const posture = hf * upright;
    let energy = a.muscles.meanActivation * a.muscles.meanActivation + 0.4 * a.muscles.meanFatigue;
    let jerk = 0;
    for (let i = 0; i < N_JOINTS; i++) {
      const d = s.u[i] - s.uPrev[i];
      jerk += d * d;
    }
    jerk /= N_JOINTS;
    const drag = ((a.shinY[0] - g < 0.12 ? 1 : 0) + (a.shinY[1] - g < 0.12 ? 1 : 0)) * 0.5;
    const straight = Math.abs(a.fwdZ) + 0.3 * Math.abs(a.pz);
    const vxc = clamp(mech.forward, -1, CONFIG.targetSpeed);
    let r =
      (R.alive * upright * (0.4 + 0.6 * hf) +
        R.forward * vxc * (0.2 + 0.8 * posture) +
        R.skill * mech.skill -
        R.energy * energy -
        R.jerk * jerk -
        R.straight * straight -
        R.drag * drag) * dtc;
    const ev = s.eventCount - s.eventPrev;
    s.eventPrev = s.eventCount;
    const cmb = s.metrics.combo - s.comboPrev;
    s.comboPrev = s.metrics.combo;
    r += R.event * ev + R.combo * cmb - mech.penalty;
    void energy;
    return r;
  }

  // ------------------------------------------------------------------ evolución
  private finishEs(s: Slot): boolean {
    if (s.cand < 0 || this.results[s.cand]) return false;
    this.results[s.cand] = { fit: s.fit, metric: s.maxMetric, time: s.t };
    this.completed++;
    if (this.completed >= this.results.length) {
      this.endGeneration();
      return true;
    }
    return false;
  }

  private endGeneration() {
    const res = this.results as Result[];
    const n = res.length;
    let bestMetric = 0, sumMetric = 0, bestFit = -Infinity, sumFit = 0, sumT = 0;
    for (const r of res) {
      bestMetric = Math.max(bestMetric, r.metric);
      sumMetric += r.metric;
      bestFit = Math.max(bestFit, r.fit);
      sumFit += r.fit;
      sumT += r.time;
    }
    this.history.push({
      gen: this.evo.gen + 1,
      task: this.taskId,
      terrain: this.terrainIdx,
      bestMetric,
      meanMetric: sumMetric / n,
      bestFit,
      meanFit: sumFit / n,
      meanTime: sumT / n,
    });
    if (this.history.length > 600) this.history.splice(0, this.history.length - 600);
    this.terrainBest[this.terrainIdx] = Math.max(this.terrainBest[this.terrainIdx], bestMetric);
    this.bestEver = Math.max(this.bestEver, bestMetric);
    this.updateAssist(res[0]);
    this.updateNnStage();
    this.evo.tell(res.map((r) => r.fit));
    this.checkUnlock();
    this.nextCand = 0;
    this.completed = 0;
    this.results = this.evo.cands.map(() => null);
    this.restartAll(false);
  }

  private updateNnStage() {
    this.evo.nnFactor = clamp((CONFIG.nnStartAssist - this.assist) / 0.25, 0.2, 1);
  }

  private updateAssist(elite: Result) {
    if (!this.autoAssist || this.assist <= 0) return;
    const A = CONFIG.assist;
    const def = taskDef(this.taskId);
    const goal = Math.min(A.minDist, def.target * 0.35);
    this.assistStall++;
    if (elite.time >= def.episode - 0.1 && elite.metric >= goal) {
      this.assist = Math.max(0, this.assist - A.step);
      this.assistStall = 0;
    } else if (this.assistStall >= A.stallGenerations) {
      this.assist = Math.max(0, this.assist - A.slowStep);
      this.assistStall = 0;
    }
    if (this.assist < 0.005) {
      this.assist = 0;
      this.events.push("🎓 ¡Arnés retirado! Física sin ayudas");
    }
  }

  private checkUnlock() {
    if (this.taskId !== "walk") return;
    const th = CONFIG.unlockDistances;
    while (this.unlocked < TERRAINS.length - 1 && this.assist <= CONFIG.assist.unlockMax && this.terrainBest[this.unlocked] >= th[this.unlocked + 1]) {
      this.unlocked++;
      this.events.push(`🔓 Terreno desbloqueado: ${TERRAINS[this.unlocked].name}`);
      if (this.autoCurriculum && this.unlocked === this.terrainIdx + 1) {
        this.terrainIdx = this.unlocked;
        this.buildLayout(this.taskId, this.terrainIdx);
      }
    }
  }

  resetBrain() {
    const b = this.ensureBrain(this.taskId);
    const evo = new Evolution(initGenome(this.rng), mutationScales(), this.rng);
    evo.denseCount = CPG_PARAMS;
    evo.nnFactor = 0.2;
    evo.ask();
    b.evo = evo;
    b.history = [];
    b.assist = taskDef(this.taskId).assistStart;
    b.assistStall = 0;
    b.terrainBest = TERRAINS.map(() => 0);
    b.unlocked = 0;
    b.bestEver = 0;
    b.terrainIdx = 0;
    this.activateBrain(b);
    this.terrainIdx = 0;
    this.buildLayout(this.taskId, 0);
    this.restartAll(true);
  }

  resetAllBrains() {
    this.brains.clear();
    this.taskId = "walk";
    this.terrainIdx = 0;
    const b = this.ensureBrain("walk");
    this.activateBrain(b);
    this.buildLayout(this.taskId, 0);
    this.restartAll(true);
    this.events.push("🧠 Los cinco cerebros volvieron a cero");
  }

  // ------------------------------------------------------------------ interacción
  push(slotIdx: number) {
    const s = this.slots[slotIdx];
    if (!s || s.state !== "run") return;
    const ang = this.rng() * Math.PI * 2;
    const k = CONFIG.pushImpulse * (s.agent.totalMassKg / TOTAL_MASS);
    s.agent.bodies[1].applyImpulse({ x: Math.cos(ang) * k, y: 10, z: Math.sin(ang) * k }, true);
  }

  updateFocus() {
    let best = -1, bestScore = -Infinity;
    const distanceTask = this.taskId === "walk" || this.taskId === "parkour";
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.state !== "run") continue;
      const score = distanceTask ? s.agent.px : s.metric + s.agent.py * 0.05;
      const bonus = i === this.focus ? (distanceTask ? 0.8 : 0.3) : 0;
      if (score + bonus > bestScore) {
        bestScore = score + bonus;
        best = i;
      }
    }
    if (best >= 0) this.focus = best;
    else if (this.focus >= this.slots.length) this.focus = 0;
    if (this.mode === "manual") this.focus = 0;
    return this.focus;
  }

  // ------------------------------------------------------------------ estadísticas
  stage(): { level: number; label: string } {
    const def = taskDef(this.taskId);
    const last = this.history.slice(-3);
    if (last.length === 0) return { level: 0, label: def.stageLabels[0] };
    const bd = Math.max(...last.map((h) => h.bestMetric));
    let level = 0;
    for (const th of def.stage) if (bd >= th) level++;
    return { level, label: def.stageLabels[Math.min(level, def.stageLabels.length - 1)] };
  }

  snapshot() {
    const def = taskDef(this.taskId);
    const last = this.history[this.history.length - 1];
    let curBest = 0, running = 0;
    for (const s of this.slots) {
      if (s.role === "es") curBest = Math.max(curBest, s.maxMetric);
      if (s.state === "run") running++;
    }
    for (const r of this.results) if (r) curBest = Math.max(curBest, r.metric);
    const brain = this.slots.find((s) => s.role === "brain");
    const fi = this.updateFocus();
    const fs = this.slots[fi] ?? this.slots[0];
    const a = fs?.agent;
    const gravity = Math.abs(CONFIG.gravity * CONFIG.gravityScale);
    const mass = a?.totalMassKg ?? TOTAL_MASS;
    const m = fs?.metrics ?? createTaskMetrics();
    const taskBest: Record<string, number> = {};
    for (const t of TASKS) taskBest[t.id] = this.brains.get(t.id)?.bestEver ?? 0;
    return {
      gen: this.evo.gen + 1,
      evaluated: this.completed,
      pop: this.results.length,
      curBest,
      last,
      bestEver: this.bestEver,
      terrainBest: this.terrainBest[this.terrainIdx],
      sigma: this.evo.sigma,
      eliteFit: this.evo.eliteFit,
      running,
      agents: this.slots.length,
      stage: this.stage(),
      stageLabels: def.stageLabels,
      brainMetric: brain ? brain.maxMetric : 0,
      brainTime: brain ? brain.t : 0,
      history: this.history,
      unlocked: this.unlocked,
      terrainIdx: this.terrainIdx,
      mode: this.mode,
      assist: this.assist,
      task: this.taskId,
      taskName: def.name,
      taskIcon: def.icon,
      metricLabel: def.metric,
      metricUnit: def.unit,
      goal: def.target,
      taskBest,
      model: BRAIN_INFO,
      physics: {
        massKg: mass,
        loadKg: this.layout.loadKg,
        weightN: mass * gravity,
        gravity,
        gravityScale: CONFIG.gravityScale,
        velocity: a?.speed ?? 0,
        peakSpeed: a?.peakSpeed ?? 0,
        supportN: a?.supportN ?? 0,
        peakSupportN: a?.peakSupportN ?? 0,
        muscleForceN: a?.muscleForceN ?? 0,
        peakForceN: a?.peakForceN ?? 0,
        fatigue: a?.fatigue ?? 0,
        energyJ: a?.energyJ ?? 0,
        powerW: a?.powerW ?? 0,
        friction: CONFIG.groundFriction,
        muscleScale: CONFIG.muscleScale,
        fatigueScale: CONFIG.fatigueScale,
        loadScale: CONFIG.loadScale,
      },
      muscles: a ? a.muscles.rows() : [],
      taskMetrics: {
        metric: fs?.metric ?? 0,
        maxMetric: fs?.maxMetric ?? 0,
        fit: fs?.fit ?? 0,
        time: fs?.t ?? 0,
        reps: m.reps,
        workJ: m.workJ,
        maxHold: m.maxHold,
        holdTouches: m.holdTouches,
        hits: m.hits,
        combo: m.combo,
        peakPunchN: m.peakPunchN,
        bagSpeed: m.bagSpeed,
        wallsCleared: m.wallsCleared,
        landings: m.landings,
        jumps: m.jumps,
        airTime: m.airTime,
      },
    };
  }

  // ------------------------------------------------------------------ guardar / cargar (v2: 5 cerebros)
  private serializeBrain(b: BrainState): TaskBrainFile {
    return {
      mean: Array.from(b.evo.mean, round5),
      elite: Array.from(b.evo.elite, round5),
      sigma: round5(b.evo.sigma),
      gen: b.evo.gen,
      eliteFit: round5(b.evo.eliteFit),
      history: b.history.slice(-300).map((h) => ({
        ...h,
        bestMetric: round5(h.bestMetric),
        meanMetric: round5(h.meanMetric),
        bestFit: round5(h.bestFit),
        meanFit: round5(h.meanFit),
        meanTime: round5(h.meanTime),
      })),
      terrainBest: b.terrainBest.map(round5),
      unlocked: b.unlocked,
      assist: round5(b.assist),
      terrainIdx: b.terrainIdx,
      bestEver: round5(b.bestEver),
    };
  }

  exportBrain(): BrainFile {
    this.saveBrainState();
    const tasks: Partial<Record<TaskId, TaskBrainFile>> = {};
    for (const [id, b] of this.brains) tasks[id] = this.serializeBrain(b);
    return {
      format: "ia-camina",
      version: 2,
      genomeSize: GENOME_SIZE,
      activeTask: this.taskId,
      tasks,
      savedAt: new Date().toISOString(),
      model: BRAIN_INFO,
    };
  }

  private evolutionFrom(d: TaskBrainFile): Evolution {
    if (!d || d.mean.length !== GENOME_SIZE || d.elite.length !== GENOME_SIZE) throw new Error("Genoma no compatible con el modelo de 100 M parámetros");
    const evo = new Evolution(Float32Array.from(d.mean), mutationScales(), this.rng);
    evo.load(Float32Array.from(d.mean), Float32Array.from(d.elite), clamp(d.sigma, 0.04, 1.2), d.gen, d.eliteFit);
    evo.denseCount = CPG_PARAMS;
    evo.nnFactor = clamp((CONFIG.nnStartAssist - clamp(d.assist, 0, 1)) / 0.25, 0.2, 1);
    evo.ask();
    return evo;
  }

  importBrain(b: BrainFile) {
    if (!b || b.format !== "ia-camina" || b.version !== 2 || b.genomeSize !== GENOME_SIZE || !b.tasks) {
      throw new Error("Se requiere un cerebro v2 (5 disciplinas, 100 M parámetros)");
    }
    const next = new Map<TaskId, BrainState>();
    for (const t of TASKS) {
      const d = b.tasks[t.id];
      if (!d) continue;
      const history = (d.history ?? []).map((h) => ({ ...h, task: t.id }));
      next.set(t.id, {
        evo: this.evolutionFrom(d),
        history,
        assist: clamp(d.assist ?? t.assistStart, 0, 1),
        assistStall: 0,
        terrainBest: (d.terrainBest ?? TERRAINS.map(() => 0)).slice(0, TERRAINS.length),
        unlocked: clamp(d.unlocked ?? 0, 0, TERRAINS.length - 1),
        bestEver: d.bestEver ?? 0,
        terrainIdx: clamp(d.terrainIdx ?? 0, 0, TERRAINS.length - 1),
      });
    }
    this.brains = next;
    const active: TaskId = TASKS.some((t) => t.id === b.activeTask) ? b.activeTask : "walk";
    this.taskId = active;
    const state = this.ensureBrain(active);
    this.activateBrain(state);
    this.buildLayout(this.taskId, this.terrainIdx);
    this.restartAll(true);
    this.events.push("✅ Cerebros de las 5 disciplinas cargados");
  }
}

/** Tipos auxiliares para el worker (evita importarlos dos veces). */
export type { Hold, Wall, TaskLayout };
export { CTX_SIZE, PROP_COUNT, PROP_STRIDE, MUSCLE_VIEW_SIZE, type TaskMetrics, type TerrainId };
