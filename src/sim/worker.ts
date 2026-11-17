/// <reference lib="webworker" />
import { Simulation, type Mode } from "./sim";
import { CTX_SIZE, MUSCLE_VIEW_SIZE, PROP_COUNT, PROP_STRIDE } from "./sim";
import { RENDER_BODIES } from "./spec";

/**
 * ============================================================
 *  WORKER: física + 5 cerebros + telemetría, fuera del hilo de UI
 * ============================================================
 * Manda ~60 veces/s las poses, la activación de los músculos y los objetos
 * dinámicos (saco, pesas/guantes); y 4 veces/s el resumen de entrenamiento,
 * fuerza, peso, velocidad, energía y métricas de la disciplina.
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let sim: Simulation | null = null;
let speed = 1;
let paused = false;
let background = false;
let checkpointAt = 0;
let checkpointKey = "";
let budgetMs = 12;
let last = performance.now();
let acc = 0;
let lastPost = 0;
let lastSnap = 0;
let sentHistory = -1;
let sentTerrain = -1;
let winSteps = 0;
let winStart = performance.now();
let effSpeed = 0;
let stepMs = 0;

const channel = new MessageChannel();
channel.port1.onmessage = () => loop();

function schedule() {
  if (speed > 1 && !paused) channel.port2.postMessage(0);
  else setTimeout(loop, 3);
}

function loop() {
  const now = performance.now();
  const dtReal = Math.min(now - last, 100);
  last = now;
  if (sim) {
    if (!paused) {
      acc += (dtReal / 1000) * 60 * speed;
      if (speed <= 1 && acc > 6) acc = 6;
      const t0 = performance.now();
      let n = 0;
      while (acc >= 1 && performance.now() - t0 < budgetMs) {
        sim.stepOnce();
        acc -= 1;
        n++;
      }
      if (acc >= 1 && speed > 1) acc = 0;
      if (n > 0) {
        const el = performance.now() - t0;
        stepMs = stepMs * 0.9 + (el / n) * 0.1;
      }
      winSteps += n;
    }
    const t = performance.now();
    if (t - winStart >= 1000) {
      effSpeed = paused ? 0 : winSteps / ((t - winStart) / 1000) / 60;
      winSteps = 0;
      winStart = t;
    }
    const key = `${sim.taskId}:${sim.evo.gen}`;
    if (key !== checkpointKey && t - checkpointAt >= 3000) {
      checkpointKey = key;
      checkpointAt = t;
      ctx.postMessage({ t: "checkpoint", data: sim.exportBrain() });
    }
    if (t - lastPost >= 15 && !background) {
      lastPost = t;
      postFrame();
    }
    if (t - lastSnap >= 250) {
      lastSnap = t;
      postSnapshot();
    }
  }
  schedule();
}

function writeTransform(buf: Float32Array, o: number, body: { translation(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number } } | null) {
  if (!body) {
    buf[o + 7] = 0;
    return;
  }
  const p = body.translation();
  const q = body.rotation();
  buf[o] = p.x; buf[o + 1] = p.y; buf[o + 2] = p.z;
  buf[o + 3] = q.x; buf[o + 4] = q.y; buf[o + 5] = q.z; buf[o + 6] = q.w;
  buf[o + 7] = 1;
}

function postFrame() {
  if (!sim) return;
  const s = sim;
  s.updateFocus();
  const R = RENDER_BODIES.length;
  const n = s.slots.length;
  const tr = new Float32Array(n * R * 7);
  const mus = new Float32Array(n * MUSCLE_VIEW_SIZE);
  const props = new Float32Array(n * PROP_COUNT * PROP_STRIDE);
  const look = new Uint8Array(n);
  const lane = new Float32Array(n);
  const cur = new Float32Array(n * 2);
  const alive: number[] = [];
  for (let i = 0; i < n; i++) if (s.slots[i].role === "es" && s.slots[i].state === "run") alive.push(i);
  alive.sort((a, b) => s.slots[b].fit - s.slots[a].fit);
  const top = new Set(alive.slice(0, 3));
  let o = 0;
  for (let i = 0; i < n; i++) {
    const slot = s.slots[i];
    const bodies = slot.agent.bodies;
    for (let k = 0; k < R; k++) {
      const b = bodies[RENDER_BODIES[k]];
      const p = b.translation();
      const q = b.rotation();
      tr[o++] = p.x; tr[o++] = p.y; tr[o++] = p.z;
      tr[o++] = q.x; tr[o++] = q.y; tr[o++] = q.z; tr[o++] = q.w;
    }
    slot.agent.muscles.view(slot.muscleView);
    mus.set(slot.muscleView, i * MUSCLE_VIEW_SIZE);
    const base = i * PROP_COUNT * PROP_STRIDE;
    writeTransform(props, base, slot.bag);
    writeTransform(props, base + PROP_STRIDE, slot.agent.weightBodies[0] ?? null);
    writeTransform(props, base + 2 * PROP_STRIDE, slot.agent.weightBodies[1] ?? null);
    lane[i] = slot.laneZ;
    cur[i * 2] = slot.maxMetric;
    cur[i * 2 + 1] = slot.fit;
    let l = 0;
    if (slot.state !== "run") l = 3;
    else if (slot.role === "manual") l = 4;
    else if (slot.role === "brain") l = 5;
    else if (top.has(i)) l = 1;
    if (i === s.focus && slot.state === "run" && slot.role === "es") l = 2;
    look[i] = l;
  }
  const msg: Record<string, unknown> = {
    t: "frame", tr, mus, props, look, lane, cur, focus: s.focus, assist: s.assist, n,
    task: s.taskId, ctxSize: CTX_SIZE,
  };
  ctx.postMessage(msg, [tr.buffer, mus.buffer, props.buffer]);
  if (sentTerrain !== s.terrainVersion) {
    sentTerrain = s.terrainVersion;
    ctx.postMessage({
      t: "profile",
      pieces: s.profile,
      structures: s.layout.structures,
      task: s.taskId,
      terrainIdx: s.terrainIdx,
      bag: s.layout.bag,
      propKind: s.layout.propKind,
    });
  }
}

function postSnapshot() {
  if (!sim) return;
  const snap = sim.snapshot() as Record<string, unknown>;
  const historyKey = sim.evo.gen;
  if (historyKey !== sentHistory) sentHistory = historyKey;
  else delete snap.history;
  snap.effSpeed = effSpeed;
  snap.stepMs = stepMs;
  snap.speed = speed;
  snap.autoAssist = sim.autoAssist;
  snap.autoCurriculum = sim.autoCurriculum;
  snap.unlockAll = sim.unlockAll;
  snap.slotCount = sim.slots.length;
  const events = sim.events.splice(0);
  ctx.postMessage({ t: "snap", snap, events });
}

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.t === "init") {
    sim = await Simulation.create();
    sim.desiredSlots = m.agents;
    sim.configure("train");
    if (m.saved) {
      try { sim.importBrain(m.saved); }
      catch (err) { ctx.postMessage({ t: "toast", text: "❌ No se pudo restaurar: " + (err as Error).message }); }
    }
    ctx.postMessage({ t: "ready" });
    last = performance.now();
    schedule();
    return;
  }
  if (!sim) return;
  switch (m.t) {
    case "speed": speed = m.v; break;
    case "pause": paused = !!m.v; break;
    case "background": background = !!m.v; break;
    case "robotics": sim.setRobotics(!!m.controller, m.randomization); checkpointKey = ""; checkpointAt = 0; break;
    case "training": sim.setTraining(m.guidance, m.exploration); checkpointKey = ""; checkpointAt = 0; break;
    case "budget": budgetMs = m.v; break;
    case "mode": sim.configure(m.mode as Mode); sentHistory = -1; break;
    case "task": sim.setTask(m.task); sentHistory = -1; sentTerrain = -1; checkpointKey = ""; checkpointAt = 0; break;
    case "terrain": sim.setTerrain(m.i); sentTerrain = -1; break;
    case "physics": sim.setPhysics(m.v); sentHistory = -1; sentTerrain = -1; checkpointKey = ""; checkpointAt = 0; break;
    case "agents": sim.setSlotCount(m.n); break;
    case "push": sim.push(sim.mode === "train" ? sim.focus : m.slot ?? 0); break;
    case "manual": sim.manualU.set(m.u); break;
    case "resetSlot": sim.resetSlot(m.i); break;
    case "resetBrain": sim.resetBrain(); sentHistory = -1; checkpointKey = ""; checkpointAt = 0; break;
    case "resetAll": sim.resetAllBrains(); sentHistory = -1; sentTerrain = -1; checkpointKey = ""; checkpointAt = 0; break;
    case "unlockAll": sim.unlockAll = !!m.v; break;
    case "autoCurriculum": sim.autoCurriculum = !!m.v; checkpointKey = ""; checkpointAt = 0; break;
    case "assist":
      checkpointKey = ""; checkpointAt = 0;
      sim.autoAssist = !!m.auto;
      if (!m.auto) sim.assist = m.value;
      break;
    case "export": ctx.postMessage({ t: "brain", data: sim.exportBrain(), purpose: m.purpose }); break;
    case "import":
      try {
        sim.importBrain(m.data);
        checkpointKey = ""; checkpointAt = 0;
        sentHistory = -1;
        sentTerrain = -1;
        ctx.postMessage({ t: "toast", text: "✅ Cerebro v2 cargado" });
      } catch (err) {
        ctx.postMessage({ t: "toast", text: "❌ " + (err as Error).message });
      }
      break;
  }
};
