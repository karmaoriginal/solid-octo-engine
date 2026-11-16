// Prueba sin pantalla: entrena y muestra el progreso. Uso: npx tsx scripts/headless.ts [generaciones] [agentes] [terreno]
import { Simulation } from "../src/sim/sim";
import { CONFIG } from "../src/config";

if (process.env.OVR) Object.assign(CONFIG, JSON.parse(process.env.OVR));
const gens = Number(process.argv[2] ?? 30);
const agents = Number(process.argv[3] ?? 24);
const sim = await Simulation.create();
sim.desiredSlots = agents;
sim.unlockAll = true;
sim.configure("train");
const t0 = Date.now();
let steps = 0;
let lastGen = 0;
let nextReport = Date.now();
while (sim.evo.gen < gens) {
  sim.stepOnce();
  steps++;
  if (sim.evo.gen !== lastGen) {
    lastGen = sim.evo.gen;
    const h = sim.history[sim.history.length - 1];
    if (lastGen % Number(process.argv[4] ?? 5) === 0 || lastGen === 1)
      console.log(`gen ${h.gen} terr=${h.terrain} bestMetric=${h.bestMetric.toFixed(2)} meanMetric=${h.meanMetric.toFixed(2)} bestFit=${h.bestFit.toFixed(1)} meanFit=${h.meanFit.toFixed(1)} meanT=${h.meanTime.toFixed(2)} sigma=${sim.evo.sigma.toFixed(3)} assist=${sim.assist.toFixed(2)} | ${((Date.now() - t0) / 1000).toFixed(0)}s ${(steps / ((Date.now() - t0) / 1000)).toFixed(0)} steps/s`);
  }
  void nextReport; void CONFIG;
}
console.log("stage", sim.stage());
