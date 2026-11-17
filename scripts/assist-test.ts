import assert from "node:assert/strict";
import { CONFIG, taskDef } from "../src/config";
import { Simulation } from "../src/sim/sim";

const sim = await Simulation.create(42);
sim.desiredSlots = 1;
sim.configure("train");
assert.equal(sim.evo.populationSize, 50); // 48 mutaciones + élite y media
const update = (metric: number, time: number) =>
  (sim as unknown as { updateAssist(result: { fit: number; metric: number; time: number }): void }).updateAssist({ fit: 0, metric, time });
const def = taskDef("walk");
const start = sim.assist;
update(2, def.episode);
update(2, def.episode);
assert.equal(sim.assist, start);
// Una disciplina no hereda la racha de otra.
sim.setTask("boxing");
update(2, taskDef("boxing").episode);
assert.equal(sim.assist, taskDef("boxing").assistStart);
sim.setTask("walk");
// La racha se conserva por disciplina y en el guardado v2.
const saved = JSON.parse(JSON.stringify(sim.exportBrain()));
assert.equal(saved.tasks.walk.assistGood, 2);
const restored = await Simulation.create(43);
restored.desiredSlots = 1;
restored.configure("train");
restored.importBrain(saved);
const restoredUpdate = (metric: number, time: number) =>
  (restored as unknown as { updateAssist(result: { fit: number; metric: number; time: number }): void }).updateAssist({ fit: 0, metric, time });
restoredUpdate(2, def.episode);
assert(Math.abs(restored.assist - (start - CONFIG.assist.step)) < 1e-6);
update(0, 1); // una caída rompe la racha
update(2, def.episode);
update(2, def.episode);
assert.equal(sim.assist, start);
update(2, def.episode);
assert(Math.abs(sim.assist - (start - CONFIG.assist.step)) < 1e-6);
for (let i = 0; i < CONFIG.assist.stallGenerations; i++) update(0, 1);
assert(Math.abs(sim.assist - start) < 1e-6);
sim.slots.forEach(s => s.dispose());
restored.slots.forEach(s => s.dispose());
console.log("Población y rachas de arnés por disciplina, guardado y recuperación: OK");
