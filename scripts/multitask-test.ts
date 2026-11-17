import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/sim';
import { TASKS } from '../src/config';
import { GENOME_SIZE } from '../src/sim/policy';
import { PARAM_COUNT } from '../src/sim/moe';

const sim = await Simulation.create();
sim.desiredSlots = 2;
sim.configure('train');
assert.equal(PARAM_COUNT, 100_000_000);
for (const task of TASKS) {
  sim.setTask(task.id);
  for (let i = 0; i < 300; i++) sim.stepOnce();
  const snap = sim.snapshot();
  assert.equal(snap.task, task.id);
  assert(Number.isFinite(snap.physics.velocity));
  assert(Number.isFinite(snap.physics.energyJ));
  assert(sim.slots.every(s => s.agent.bodies.every(b => Number.isFinite(b.translation().y))));
  assert.equal(sim.slots[0].obs.length, 81);
  console.log(task.id, 'metric', snap.taskMetrics.metric.toFixed(2), 'mass', snap.physics.massKg.toFixed(1), 'energy', snap.physics.energyJ.toFixed(0));
}
const saved = JSON.parse(JSON.stringify(sim.exportBrain()));
assert.equal(Object.keys(saved.tasks).length, 5);
assert.equal(saved.genomeSize, GENOME_SIZE);
sim.importBrain(saved);
assert.equal(sim.taskId, 'parkour');
sim.setPhysics({gravityScale: 0.5, loadScale: 1, muscleScale: 1, fatigueScale: 1, groundFriction: 1});
assert.equal(sim.snapshot().physics.gravity, 4.905);
sim.slots.forEach(s => s.dispose());
console.log('multitask and save/load OK');
