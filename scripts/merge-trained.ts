import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TASKS, type TaskId } from "../src/config";
import { GENOME_SIZE } from "../src/sim/policy";
import type { BrainFile } from "../src/sim/sim";

const inputDir = process.argv[2] ?? "training-output";
const output = process.argv[3] ?? "public/trained-brains.json";
const expectedGenerations = Number(process.argv[4] ?? 1000);
if (!Number.isInteger(expectedGenerations) || expectedGenerations < 1) throw new Error("Número de generaciones no válido");
const requested = process.argv[5]?.split(",") ?? TASKS.map(t => t.id);
if (!requested.includes("walk") || new Set(requested).size !== requested.length || requested.some(id => !TASKS.some(t => t.id === id))) {
  throw new Error("Lista de disciplinas no válida (debe incluir walk)");
}
let result: BrainFile | undefined;
const tasks: BrainFile["tasks"] = {};
for (const t of TASKS) {
  if (!requested.includes(t.id)) continue;
  const data = JSON.parse(readFileSync(`${inputDir}/${t.id}.json`, "utf8")) as {
    task: TaskId; population: number; generations: number; brain: BrainFile;
  };
  const brain = data.brain;
  const entry = brain?.tasks?.[t.id];
  if (data.task !== t.id || data.population !== 100 || data.generations !== expectedGenerations ||
      brain?.format !== "ia-camina" || brain.version !== 2 || brain.genomeSize !== GENOME_SIZE ||
      !entry || entry.gen !== expectedGenerations || entry.elite.length !== GENOME_SIZE || entry.mean.length !== GENOME_SIZE ||
      !entry.elite.every(Number.isFinite) || !entry.mean.every(Number.isFinite)) {
    throw new Error(`Resultado incompleto o incompatible: ${t.id}`);
  }
  tasks[t.id] = entry;
  if (t.id === "walk") result = brain;
}
if (!result) throw new Error("Falta marcha");
result.tasks = tasks;
result.activeTask = "walk";
result.savedAt = new Date().toISOString();
mkdirSync(dirname(output), {recursive: true});
writeFileSync(output, JSON.stringify(result));
console.log(`Combinados ${requested.length} cerebros, ${expectedGenerations} generaciones y 100 candidatos por generación`);
