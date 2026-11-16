import RAPIER from "@dimforge/rapier3d-compat";
import { CONFIG, TASKS } from "../config";
import { terrainY, type Piece } from "./terrain";
import { N_OBS } from "./observations";
import { CTX_SIZE } from "./tasks";
import { MuscleSystem } from "./muscles";
export { MUSCLE_SPECS, MUSCLE_MASS_KG, MUSCLE_VIEW_SIZE } from "./muscles";
import {
  BODY_INDEX,
  BODY_SPECS,
  GROUP_AGENT,
  GROUP_TERRAIN,
  JOINT_SPECS,
  N_BODIES,
  N_JOINTS,
  STAND_PELVIS_Y,
  TOTAL_MASS,
} from "./spec";

/**
 * ============================================================
 *  PERSONAJE HUMANOIDE CON MÚSCULOS REALES
 * ============================================================
 * - 72 kg de masa segmentaria (peso = m·g) + carga opcional en las manos.
 * - 19 articulaciones con límites, motores de torque y pares musculares agonistas.
 * - F = τ / r, τ = F0·r·disponibilidad, curva fuerza-velocidad, fatiga y energía.
 * - Fuerza de reacción del suelo estimada por F = m·(a − g), velocidad del COM,
 *   velocidad de las manos para golpes/agarres.
 */

export {
  BODY_INDEX, BODY_SPECS, JOINT_SPECS, N_BODIES, N_JOINTS, STAND_PELVIS_Y, TOTAL_MASS,
  GROUP_TERRAIN, N_OBS,
};

const bodies = BODY_SPECS;
const joints = JOINT_SPECS;
const idx = BODY_INDEX;
const UPRIGHT_BODIES = [idx.pelvis, idx.chest];
const jParent = joints.map((j) => idx[j.parent]);
const jChild = joints.map((j) => idx[j.child]);
const jointRange = joints.map((j) => j.max - j.min);
const jointMid = joints.map((j) => (j.max + j.min) / 2);
const HAND_LOCAL: [number, number, number] = [0, -0.13, 0];

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
type V3 = { x: number; y: number; z: number };

function rotate(q: RAPIER.Rotation, v: [number, number, number]): [number, number, number] {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + y * tz - z * ty,
    v[1] + w * ty + z * tx - x * tz,
    v[2] + w * tz + x * ty - y * tx,
  ];
}

/** Un personaje completo dentro del mundo de física. */
export class Agent {
  bodies: RAPIER.RigidBody[] = [];
  joints: RAPIER.RevoluteImpulseJoint[] = [];
  weightBodies: RAPIER.RigidBody[] = [];
  muscles = new MuscleSystem();
  loadKg: number;
  totalMassKg: number;

  private q = new Float64Array(N_BODIES * 4);
  private demand = new Float32Array(N_JOINTS);
  angle = new Float32Array(N_JOINTS);
  vel = new Float32Array(N_JOINTS);
  private prevAngle = new Float32Array(N_JOINTS);
  private needInit = true;
  torqueFrac = new Float32Array(N_JOINTS);
  limp = false;
  enabled = true;

  px = 0; py = 0; pz = 0;
  vx = 0; vy = 0; vz = 0;
  wx = 0; wy = 0; wz = 0;
  upX = 0; upZ = 0; upY = 1;
  chestUpY = 1;
  fwdZ = 0;
  headY = 0;
  chestY = 0;
  footX = [0, 0];
  footY = [0, 0];
  shinY = [0, 0];
  handPos: V3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  handVel: V3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  speed = 0;
  peakSpeed = 0;
  supportN = 0;
  peakSupportN = 0;
  private comVy = 0;
  private prevComVy = 0;
  muscleForceN = 0;
  peakForceN = 0;
  fatigue = 0;
  energyJ = 0;
  powerW = 0;

  private pUp = [0, 1, 0];
  private pFwd = [1, 0, 0];
  private cUp = [0, 1, 0];

  constructor(private world: RAPIER.World, loadKg = 0) {
    this.loadKg = Math.max(0, loadKg);
    this.totalMassKg = TOTAL_MASS + this.loadKg;
    for (const b of bodies) {
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(b.pos[0], b.pos[1], b.pos[2])
        .setLinearDamping(0.02)
        .setAngularDamping(0.05)
        .setCanSleep(false);
      if (b.shape === "dummy") {
        const I = 0.02;
        desc.setAdditionalMassProperties(b.mass, { x: 0, y: 0, z: 0 }, { x: I, y: I, z: I }, { x: 0, y: 0, z: 0, w: 1 });
      }
      const body = world.createRigidBody(desc);
      if (b.shape !== "dummy") {
        let cd: RAPIER.ColliderDesc;
        if (b.shape === "box") cd = RAPIER.ColliderDesc.cuboid(b.size[0], b.size[1], b.size[2]);
        else if (b.shape === "capsule") cd = RAPIER.ColliderDesc.capsule(b.size[0], b.size[1]);
        else cd = RAPIER.ColliderDesc.ball(b.size[0]);
        cd.setMass(b.mass).setFriction(b.friction).setRestitution(0).setCollisionGroups(GROUP_AGENT);
        world.createCollider(cd, body);
      }
      this.bodies.push(body);
    }
    joints.forEach((j, i) => {
      const bp = bodies[jParent[i]].pos;
      const bc = bodies[jChild[i]].pos;
      const a1 = { x: j.anchor[0] - bp[0], y: j.anchor[1] - bp[1], z: j.anchor[2] - bp[2] };
      const a2 = { x: j.anchor[0] - bc[0], y: j.anchor[1] - bc[1], z: j.anchor[2] - bc[2] };
      const data = RAPIER.JointData.revolute(a1, a2, { x: j.axis[0], y: j.axis[1], z: j.axis[2] });
      data.limitsEnabled = true;
      data.limits = [j.min, j.max];
      const joint = world.createImpulseJoint(data, this.bodies[jParent[i]], this.bodies[jChild[i]], true) as RAPIER.RevoluteImpulseJoint;
      joint.configureMotorModel(RAPIER.MotorModel.ForceBased);
      joint.setMotorMaxForce(j.maxTorque * CONFIG.torqueScale * CONFIG.muscleScale);
      this.joints.push(joint);
    });
    if (this.loadKg > 0) this.buildWeights();
    this.setRestTargets();
  }

  /** Pesas / guantes lastrados sujetos a cada antebrazo con una unión fija. */
  private buildWeights() {
    const idq = { x: 0, y: 0, z: 0, w: 1 };
    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? "L" : "R";
      const z = side === 0 ? 0.2 : -0.2;
      const farm = this.bodies[idx["farm" + s]];
      const rb = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(0, 0.77 + 0.01, z)
          .setLinearDamping(0.05)
          .setAngularDamping(0.1)
          .setCanSleep(false),
      );
      const cd = RAPIER.ColliderDesc.cuboid(0.085, 0.06, 0.06)
        .setMass(this.loadKg / 2)
        .setFriction(0.8)
        .setRestitution(0)
        .setCollisionGroups(GROUP_AGENT);
      this.world.createCollider(cd, rb);
      const data = RAPIER.JointData.fixed({ x: HAND_LOCAL[0], y: HAND_LOCAL[1], z: HAND_LOCAL[2] }, idq, { x: 0, y: 0, z: 0 }, idq);
      const joint = this.world.createImpulseJoint(data, farm, rb, true);
      joint.setContactsEnabled(false);
      this.weightBodies.push(rb);
    }
  }

  /** Coloca al personaje de pie en (x, z) sobre el terreno y activa los músculos. */
  reset(x: number, z: number, groundY: number) {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const p = bodies[i].pos;
      b.setEnabled(true);
      b.setTranslation({ x: p[0] + x, y: p[1] + groundY + 0.01, z: p[2] + z }, false);
      b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, false);
      b.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.setAngvel({ x: 0, y: 0, z: 0 }, false);
      b.resetForces(false);
      b.resetTorques(false);
      b.wakeUp();
    }
    for (let i = 0; i < this.weightBodies.length; i++) {
      const b = this.weightBodies[i];
      const zz = i === 0 ? 0.2 : -0.2;
      b.setEnabled(true);
      b.setTranslation({ x: x, y: 0.77 + groundY + 0.01, z: z + zz }, false);
      b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, false);
      b.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.setAngvel({ x: 0, y: 0, z: 0 }, false);
      b.resetForces(false);
      b.resetTorques(false);
      b.wakeUp();
    }
    this.limp = false;
    this.enabled = true;
    this.needInit = true;
    this.prevComVy = 0;
    this.comVy = 0;
    this.peakSpeed = 0;
    this.peakSupportN = 0;
    this.muscles.reset();
    this.setRestTargets();
  }

  freeze() {
    if (!this.enabled) return;
    for (const b of this.bodies) b.setEnabled(false);
    for (const b of this.weightBodies) b.setEnabled(false);
    this.enabled = false;
  }

  remove() {
    for (const b of this.bodies) this.world.removeRigidBody(b);
    for (const b of this.weightBodies) this.world.removeRigidBody(b);
    this.bodies.length = 0;
    this.joints.length = 0;
    this.weightBodies.length = 0;
  }

  setRestTargets() {
    const kpBase = 1 / CONFIG.motorFullTorqueError;
    for (let i = 0; i < N_JOINTS; i++) {
      const j = joints[i];
      const mt = j.maxTorque * CONFIG.torqueScale * CONFIG.muscleScale;
      this.joints[i].setMotorMaxForce(mt);
      this.joints[i].configureMotorPosition(j.rest, mt * kpBase, mt * CONFIG.motorDampingFactor);
    }
  }

  /** Relaja todos los músculos (cae como un muñeco). */
  goLimp() {
    this.limp = true;
    for (let i = 0; i < N_JOINTS; i++) {
      this.joints[i].setMotorMaxForce(0.01);
      this.joints[i].configureMotorPosition(joints[i].rest, 0, CONFIG.limpDamping);
    }
  }

  static targetAngle(i: number, u: number) {
    const j = joints[i];
    return u >= 0 ? j.rest + u * (j.max - j.rest) : j.rest + u * (j.rest - j.min);
  }

  static normAngle(i: number, a: number) {
    const j = joints[i];
    return a >= j.rest ? (a - j.rest) / (j.max - j.rest) : (a - j.rest) / (j.rest - j.min);
  }

  /** Limpia fuerzas externasPersistentes antes de volver a aplicar arnés/agarres. */
  clearExternalForces() {
    for (const name of ["pelvis", "chest", "farmL", "farmR"]) this.bodies[idx[name]].resetForces(false);
    for (const b of this.weightBodies) b.resetForces(false);
  }

  /** Aplica acciones a los motores, con fuerza limitada por la fisiología muscular. */
  applyActions(u: ArrayLike<number>, dtc: number) {
    if (this.limp) return;
    const kpBase = 1 / CONFIG.motorFullTorqueError;
    for (let i = 0; i < N_JOINTS; i++) {
      const tauPD = (Agent.targetAngle(i, clamp(u[i], -1, 1)) - this.angle[i]) * kpBase - this.vel[i] * CONFIG.motorDampingFactor;
      this.demand[i] = clamp(tauPD, -1, 1);
    }
    const strength = this.muscles.update(this.demand, this.vel, dtc);
    for (let i = 0; i < N_JOINTS; i++) {
      const j = joints[i];
      const t = Agent.targetAngle(i, clamp(u[i], -1, 1));
      const base = j.maxTorque * CONFIG.torqueScale * CONFIG.muscleScale;
      const mt = Math.max(0.05, base * strength[i]);
      this.joints[i].setMotorMaxForce(mt);
      this.joints[i].configureMotorPosition(t, mt * kpBase, mt * CONFIG.motorDampingFactor);
      this.torqueFrac[i] = clamp((t - this.angle[i]) * kpBase - this.vel[i] * CONFIG.motorDampingFactor, -1, 1);
    }
  }

  /** Fuerza externa en una mano (agarre a una presa), limitada por los músculos del brazo. */
  applyHandForce(side: number, target: V3, kp: number, kd: number, maxForceN: number) {
    const b = this.bodies[idx[side === 0 ? "farmL" : "farmR"]];
    const p = b.translation();
    const v = b.linvel();
    let fx = kp * (target.x - p.x) - kd * v.x;
    let fy = kp * (target.y - p.y) - kd * v.y;
    let fz = kp * (target.z - p.z) - kd * v.z;
    const len = Math.hypot(fx, fy, fz);
    if (len > maxForceN) {
      const k = maxForceN / len;
      fx *= k; fy *= k; fz *= k;
    }
    b.addForce({ x: fx, y: fy, z: fz }, true);
  }

  /** Lee el estado de física: ángulos, velocidades, tronco, pies, manos, COM. */
  readState(dtc: number) {
    const q = this.q;
    for (let i = 0; i < N_BODIES; i++) {
      const r = this.bodies[i].rotation();
      q[i * 4] = r.x; q[i * 4 + 1] = r.y; q[i * 4 + 2] = r.z; q[i * 4 + 3] = r.w;
    }
    for (let j = 0; j < N_JOINTS; j++) {
      const a = jParent[j] * 4, b = jChild[j] * 4;
      const ax = q[a], ay = q[a + 1], az = q[a + 2], aw = q[a + 3];
      const bx = q[b], by = q[b + 1], bz = q[b + 2], bw = q[b + 3];
      const w = aw * bw + ax * bx + ay * by + az * bz;
      const vx = aw * bx - bw * ax - (ay * bz - az * by);
      const vy = aw * by - bw * ay - (az * bx - ax * bz);
      const vz = aw * bz - bw * az - (ax * by - ay * bx);
      const axis = joints[j].axis;
      let ang = 2 * Math.atan2(vx * axis[0] + vy * axis[1] + vz * axis[2], w);
      if (ang > Math.PI) ang -= 2 * Math.PI;
      else if (ang < -Math.PI) ang += 2 * Math.PI;
      this.angle[j] = ang;
    }
    if (this.needInit) {
      this.prevAngle.set(this.angle);
      this.needInit = false;
    }
    for (let j = 0; j < N_JOINTS; j++) {
      this.vel[j] = (this.angle[j] - this.prevAngle[j]) / dtc;
      this.prevAngle[j] = this.angle[j];
    }
    const B = this.bodies;
    const pelvis = B[idx.pelvis];
    const t = pelvis.translation();
    const lv = pelvis.linvel();
    const av = pelvis.angvel();
    this.px = t.x; this.py = t.y; this.pz = t.z;
    this.vx = lv.x; this.vy = lv.y; this.vz = lv.z;
    this.wx = av.x; this.wy = av.y; this.wz = av.z;
    this.speed = Math.hypot(this.vx, this.vy, this.vz);
    this.peakSpeed = Math.max(this.peakSpeed, this.speed);
    {
      const x = q[idx.pelvis * 4], y = q[idx.pelvis * 4 + 1], z = q[idx.pelvis * 4 + 2], w = q[idx.pelvis * 4 + 3];
      this.pUp[0] = 2 * (x * y - w * z);
      this.pUp[1] = 1 - 2 * (x * x + z * z);
      this.pUp[2] = 2 * (y * z + w * x);
      this.pFwd[0] = 1 - 2 * (y * y + z * z);
      this.pFwd[1] = 2 * (x * y + w * z);
      this.pFwd[2] = 2 * (x * z - w * y);
      this.upX = 2 * (x * y - w * z);
      this.upY = this.pUp[1];
      this.upZ = 2 * (y * z + w * x);
      this.fwdZ = 2 * (x * z - w * y);
    }
    {
      const c = idx.chest * 4;
      const x = q[c], y = q[c + 1], z = q[c + 2], w = q[c + 3];
      this.cUp[0] = 2 * (x * y - w * z);
      this.cUp[1] = 1 - 2 * (x * x + z * z);
      this.cUp[2] = 2 * (y * z + w * x);
      this.chestUpY = this.cUp[1];
    }
    this.chestY = B[idx.chest].translation().y;
    this.headY = B[idx.head].translation().y;
    const fl = B[idx.footL].translation();
    const fr = B[idx.footR].translation();
    this.footX[0] = fl.x; this.footY[0] = fl.y;
    this.footX[1] = fr.x; this.footY[1] = fr.y;
    this.shinY[0] = B[idx.shinL].translation().y;
    this.shinY[1] = B[idx.shinR].translation().y;
    for (let side = 0; side < 2; side++) {
      const fb = B[idx[side === 0 ? "farmL" : "farmR"]];
      const fq = fb.rotation();
      const fp = fb.translation();
      const r = rotate(fq, HAND_LOCAL);
      const fv = fb.linvel();
      const fw = fb.angvel();
      this.handPos[side].x = fp.x + r[0];
      this.handPos[side].y = fp.y + r[1];
      this.handPos[side].z = fp.z + r[2];
      this.handVel[side].x = fv.x + fw.y * r[2] - fw.z * r[1];
      this.handVel[side].y = fv.y + fw.z * r[0] - fw.x * r[2];
      this.handVel[side].z = fv.z + fw.x * r[1] - fw.y * r[0];
    }
    // Centro de masas: F_suelo = m·(a_y − g).
    let mass = 0, cv = 0;
    for (let i = 0; i < N_BODIES; i++) {
      const vy = this.bodies[i].linvel().y;
      mass += bodies[i].mass;
      cv += bodies[i].mass * vy;
    }
    for (const b of this.weightBodies) {
      const vy = b.linvel().y;
      mass += this.loadKg / 2;
      cv += (this.loadKg / 2) * vy;
    }
    this.comVy = cv / Math.max(1, mass);
    const ay = (this.comVy - this.prevComVy) / dtc;
    this.prevComVy = this.comVy;
    this.supportN = clamp(this.totalMassKg * (ay - CONFIG.gravity * CONFIG.gravityScale), 0, 8000);
    this.peakSupportN = Math.max(this.peakSupportN, this.supportN);
    this.muscleForceN = this.muscles.meanForceN;
    this.peakForceN = this.muscles.peakForceN;
    this.fatigue = this.muscles.meanFatigue;
    this.energyJ = this.muscles.energyJ;
    this.powerW = this.muscles.powerTotalW;
  }

  /** Arnés, parte 1: fuerza vertical que sostiene parte del peso. */
  applyAssistForce(a: number, groundY: number) {
    const pelvis = this.bodies[idx.pelvis];
    pelvis.resetForces(false);
    if (a <= 0) return;
    const h = this.py - groundY;
    if (h < STAND_PELVIS_Y + 0.02) {
      pelvis.addForce({ x: 0, y: a * CONFIG.assist.weightSupport * this.totalMassKg * Math.abs(CONFIG.gravity * CONFIG.gravityScale), z: 0 }, false);
    }
  }

  /** Arnés, parte 2: endereza pelvis y pecho (aceleración angular). */
  driveUpright(a: number, dt: number) {
    const A = CONFIG.assist;
    for (const bi of UPRIGHT_BODIES) {
      const b = this.bodies[bi];
      const r = b.rotation();
      const x = r.x, y = r.y, z = r.z, w = r.w;
      const upX = 2 * (x * y - w * z);
      const upZ = 2 * (y * z + w * x);
      const fz = 2 * (x * z - w * y);
      const v = b.angvel();
      const ax = a * (-A.tiltKp * upZ - A.tiltKd * v.x);
      const az = a * (A.tiltKp * upX - A.tiltKd * v.z);
      const ay = a * (A.yawKp * fz - A.yawKd * v.y);
      b.setAngvel({ x: v.x + clamp(ax, -300, 300) * dt, y: v.y + clamp(ay, -300, 300) * dt, z: v.z + clamp(az, -300, 300) * dt }, false);
    }
  }

  footContact(i: number, prof: Piece[]) {
    return this.footY[i] - terrainY(prof, this.footX[i]) < 0.065;
  }

  /** Vector de observación: 60 señales corporales + una neurona por disciplina + 16 de contexto. */
  observe(out: Float32Array, t: number, freq: number, prof: Piece[], taskIdx: number, ctx: Float32Array) {
    let k = 0;
    for (let i = 0; i < N_JOINTS; i++) out[k++] = clamp((this.angle[i] - jointMid[i]) / (jointRange[i] / 2), -1.5, 1.5);
    for (let i = 0; i < N_JOINTS; i++) out[k++] = clamp(this.vel[i] / 8, -1, 1);
    out[k++] = this.pUp[0]; out[k++] = this.pUp[1]; out[k++] = this.pUp[2];
    out[k++] = this.pFwd[0]; out[k++] = this.pFwd[1]; out[k++] = this.pFwd[2];
    out[k++] = this.cUp[0]; out[k++] = this.cUp[1]; out[k++] = this.cUp[2];
    const g = terrainY(prof, this.px);
    out[k++] = clamp((this.py - g) / STAND_PELVIS_Y, 0, 1.5) - 1;
    out[k++] = clamp(this.vx / 2, -1.5, 1.5); out[k++] = clamp(this.vy / 2, -1.5, 1.5); out[k++] = clamp(this.vz / 2, -1.5, 1.5);
    out[k++] = clamp(this.wx / 5, -1.5, 1.5); out[k++] = clamp(this.wy / 5, -1.5, 1.5); out[k++] = clamp(this.wz / 5, -1.5, 1.5);
    out[k++] = this.footContact(0, prof) ? 1 : -1;
    out[k++] = this.footContact(1, prof) ? 1 : -1;
    const ph = 2 * Math.PI * freq * t;
    out[k++] = Math.sin(ph);
    out[k++] = Math.cos(ph);
    out[k++] = clamp((terrainY(prof, this.px + 0.5) - g) / 0.2, -1, 1);
    out[k++] = clamp((terrainY(prof, this.px + 1.0) - g) / 0.3, -1, 1);
    for (let i = 0; i < TASKS.length; i++) out[k++] = i === taskIdx ? 1 : -1;
    for (let i = 0; i < CTX_SIZE; i++) out[k++] = clamp(ctx[i] ?? 0, -1.5, 1.5);
    if (k !== N_OBS) throw new Error(`Observaciones inconsistentes: ${k} ≠ ${N_OBS}`);
  }
}

