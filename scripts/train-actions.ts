import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG, TASKS, type TaskId } from "../src/config";
import { Simulation } from "../src/sim/sim";

// Entrenamiento independiente por disciplina para GitHub Actions.
const task = process.argv[2] as TaskId;
const generations = Number(process.argv[3] ?? 1000);
const agents = Number(process.argv[4] ?? 100);
const output = process.argv[5] ?? `training-output/${task}.json`;
if (!TASKS.some(t => t.id === task) || !Number.isInteger(generations) || generations < 1 || agents !== 100) {
  throw new Error("Uso: train-actions.ts <walk|exercise|climb|boxing|parkour> <generaciones> 100 <archivo>");
}
// Evolution contiene élite y media más mutaciones en parejas: 98 + 2 = 100.
CONFIG.sampledPerGeneration = 98;
const seed = 20261116 + TASKS.findIndex(t => t.id === task);
const sim = await Simulation.create(seed);
sim.desiredSlots = agents;
sim.setTask(task);
sim.configure("train");
if (sim.evo.populationSize !== 100 || sim.slots.length !== 100 || sim.evo.cands.length !== 100) {
  throw new Error("Se esperaban exactamente 100 agentes y 100 candidatos");
}
mkdirSync(dirname(output), { recursive: true });
function checkpoint() {
  const data = sim.exportBrain();
  const temp = `${output}.tmp`;
  writeFileSync(temp, JSON.stringify({ task, seed, population: agents, generations: sim.evo.gen, brain: data }));
  renameSync(temp, output);
}
const start = performance.now();
let last = 0;
while (sim.evo.gen < generations) {
  sim.stepOnce();
  if (sim.evo.gen !== last) {
    last = sim.evo.gen;
    if (last === 1 || last % 25 === 0 || last === generations) checkpoint();
    if (last === 1 || last % 10 === 0 || last === generations) {
      const h = sim.history.at(-1)!;
      console.log(JSON.stringify({task, gen: last, population: sim.evo.populationSize, best: h.bestMetric, mean: h.meanMetric, fitness: h.bestFit, assist: sim.assist, elapsedSeconds: Math.round((performance.now() - start) / 1000)}));
    }
  }
}
const data = sim.exportBrain();
if (data.tasks[task]?.gen !== generations) throw new Error("Entrenamiento incompleto");
checkpoint();
sim.slots.forEach(s => s.dispose());
