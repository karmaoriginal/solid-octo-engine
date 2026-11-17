import assert from "node:assert/strict";
import { swingKneeBonus } from "../src/sim/gait";
import { Simulation } from "../src/sim/sim";
import { JOINT_SPECS } from "../src/sim/spec";
const sim = await Simulation.create(123);
sim.configure("manual");
const l = JOINT_SPECS.findIndex(j => j.name === "Rodilla L");
const r = JOINT_SPECS.findIndex(j => j.name === "Rodilla R");
sim.manualU[l] = .6; sim.manualU[r] = .6;
let maxL = 0, maxR = 0;
for(let i=0;i<120;i++) {sim.stepOnce(); const a=sim.slots[0].agent; maxL=Math.max(maxL,a.angle[l]); maxR=Math.max(maxR,a.angle[r]);}
assert(maxL > 0.3 && maxR > 0.3, "ambas rodillas deben flexionarse en marcha manual");
assert(swingKneeBonus(true, false, 0, 0.6, 0.5) > 0);
assert.equal(swingKneeBonus(false, false, 0.6, 0.6, 0.5), 0);
assert.equal(swingKneeBonus(true, false, 0, 0.6, 0), 0);
assert.equal(swingKneeBonus(true, false, 0.6, 0, 0.5), 0);
console.log("Rodillas en marcha manual:", {leftRad:maxL,rightRad:maxR}, "recompensa de paso: OK");
sim.slots.forEach(s=>s.dispose());
