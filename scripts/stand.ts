import { Simulation } from "../src/sim/sim";
import { CONFIG } from "../src/config";
import { GENOME_SIZE } from "../src/sim/policy";
import { JOINT_SPECS } from "../src/sim/character";
if (process.env.OVR) Object.assign(CONFIG, JSON.parse(process.env.OVR));
const sim = await Simulation.create();

sim.desiredSlots = 1; sim.configure("test");
sim.evo.elite = new Float32Array(GENOME_SIZE);
sim.restartAll(true);
const s = sim.slots[0];
let fellAt = -1, maxViol = 0, worst = "";
const t0 = performance.now();
for (let i = 0; i < 60*10; i++) {
  sim.stepOnce();
  const a = s.agent;
  if (s.state !== "run" && fellAt < 0) { fellAt = i/60; }
  if (fellAt < 0) JOINT_SPECS.forEach((j, k) => { const v = Math.max(j.min - a.angle[k], a.angle[k] - j.max); if (v > maxViol) { maxViol = v; worst = j.name; } });
}
console.log(process.env.OVR, "fellAt", fellAt, "maxLimitViolation", maxViol.toFixed(2), worst, "pelvisY", s.agent.py.toFixed(2), "ms/step", ((performance.now()-t0)/600).toFixed(3));
