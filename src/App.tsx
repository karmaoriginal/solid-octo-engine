import { useCallback, useEffect, useRef, useState } from "react";
import { CONFIG, TASKS, TERRAINS } from "./config";
import { BRAIN_KEY, Engine, fetchTrainedBrain, type Snapshot } from "./engine";
import { CAMERA_MODES } from "./render/scene";
import { JOINT_SPECS, N_JOINTS } from "./sim/spec";
import { Chart } from "./ui/Chart";
import { Sheet, Toggle } from "./ui/Sheet";
import type { GenStat } from "./sim/sim";

/**
 * ============================================================
 *  INTERFAZ: HUD, gráfica y controles táctiles
 * ============================================================
 */

const SPEEDS = [1, 5, 20, 100];

const STAGE_COLORS = ["bg-red-500", "bg-orange-500", "bg-amber-400", "bg-lime-400", "bg-emerald-400"];

type SheetKind = null | "terrain" | "menu" | "manual" | "tasks" | "physics" | "muscles";

function Btn({
  children,
  onClick,
  active,
  className = "",
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`min-h-12 select-none rounded-2xl px-2 text-sm font-bold transition active:scale-95 disabled:opacity-40 ${
        active ? "bg-sky-500 text-white shadow-lg shadow-sky-500/30" : "bg-white/10 text-white hover:bg-white/15"
      } ${className}`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-white/5 px-2 py-1">
      <div className="truncate text-[10px] uppercase tracking-wide text-white/50">{label}</div>
      <div className="truncate text-base font-extrabold leading-tight tabular-nums">
        {value}
        {sub && <span className="ml-1 text-[10px] font-medium text-white/50">{sub}</span>}
      </div>
    </div>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const histRef = useRef<GenStat[]>([]);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<GenStat[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const [perf, setPerf] = useState({ fps: 60, quality: 0, agents: 0 });
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [speed, setSpeed] = useState(1);
  const [cam, setCam] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hudOpen, setHudOpen] = useState(true);
  const [manualU, setManualU] = useState<number[]>(() => new Array(N_JOINTS).fill(0));
  const [agentsSlider, setAgentsSlider] = useState(CONFIG.agentsMobile);
  const [assistManual, setAssistManual] = useState(0.5);

  const [confirmReset, setConfirmReset] = useState(false);
  const [background, setBackground] = useState(true);
  const [guidance, setGuidance] = useState(1);
  const [exploration, setExploration] = useState(1);
  const [randomization, setRandomization] = useState(0);
  const [gpu] = useState(() => typeof navigator !== "undefined" && "gpu" in navigator);

  const toast = useCallback((text: string) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-2), { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  // ---------------------------------------------------------------- motor
  useEffect(() => {
    const canvas = canvasRef.current!;
    let eng: Engine;
    try {
      eng = new Engine(canvas, {
        onSnap: (s) => {
          if (s.history) {
            histRef.current = s.history;
            setHistory(s.history);
          }
          setSnap(s);
        },
        onToast: toast,
        onReady: () => setReady(true),
        onPerf: setPerf,
      });
    } catch (e) {
      setError("No se pudo iniciar WebGL: " + (e as Error).message);
      return;
    }
    engineRef.current = eng;
    setAgentsSlider(eng.agentCount);
    eng.scene.resize();
    return () => {
      eng.dispose();
      engineRef.current = null;
    };
  }, [toast]);

  const eng = () => engineRef.current;

  // ---------------------------------------------------------------- acciones
  const changeSpeed = (v: number) => {
    setSpeed(v);
    eng()?.setSpeed(v);
  };
  const changeMode = (m: "train" | "test" | "manual") => {
    eng()?.setMode(m);
    setSheet(m === "manual" ? "manual" : null);
    if (m === "manual") {
      setManualU(new Array(N_JOINTS).fill(0));
      eng()?.send({ t: "manual", u: new Array(N_JOINTS).fill(0) });
      changeSpeed(1);
    }
  };
  const changeCam = () => {
    const e = eng();
    if (!e) return;
    setCam(e.scene.setCameraMode(cam + 1));
  };
  const setJoint = (i: number, v: number) => {
    const u = manualU.slice();
    u[i] = v;
    setManualU(u);
    eng()?.send({ t: "manual", u });
  };
  const setAllJoints = (u: number[]) => {
    setManualU(u);
    eng()?.send({ t: "manual", u });
  };

  const saveBrain = () => {
    eng()?.requestBrain("save", (b) => {
      const json = JSON.stringify(b);
      try {
        localStorage.setItem(BRAIN_KEY, json);

      } catch {
        /* sin espacio */
      }
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `cerebro-gen${(b.tasks[b.activeTask]?.gen ?? 0)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(`💾 Cerebro guardado (gen ${(b.tasks[b.activeTask]?.gen ?? 0)})`);
    });
  };
  const loadTrained = async () => {
    if (!window.confirm("Esto reemplazará los cerebros y ajustes actuales. Guarda primero una copia desde el menú si quieres conservarlos. ¿Continuar?")) return;
    const brain = await fetchTrainedBrain();
    if (!brain) return toast("⏳ El cerebro preentrenado aún no está disponible");
    eng()?.send({ t: "import", data: brain });
  };
  const loadLocal = () => {
    const raw = localStorage.getItem(BRAIN_KEY);
    if (!raw) return toast("No hay cerebro guardado en este dispositivo");
    try {
      eng()?.send({ t: "import", data: JSON.parse(raw) });
    } catch {
      toast("❌ El guardado está dañado");
    }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      eng()?.send({ t: "import", data });
    } catch {
      toast("❌ Archivo no válido");
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const s = snap;
  useEffect(() => {
    if (snap) setRandomization(snap.robotics.randomization);
  }, [snap?.robotics.randomization]);
  const mode = s?.mode ?? "train";
  const last = s?.last;
  const stage = s?.stage ?? { level: 0, label: "Empezando…" };
  const terrainName = TERRAINS[s?.terrainIdx ?? 0].name;
  const assistPct = Math.round((s?.assist ?? 1) * 100);

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-sky-300 font-sans text-white">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* ---------- HUD ---------- */}
      <div className="pointer-events-none absolute left-2 right-2 top-2 flex items-start justify-between gap-2 pt-[env(safe-area-inset-top)]">
        <div className="pointer-events-auto w-full max-w-[22rem] rounded-2xl bg-slate-900/75 p-2 shadow-xl backdrop-blur">
          <button className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setHudOpen(!hudOpen)}>
            <span className="text-sm font-extrabold">
              {mode === "train" ? `🧠 Generación ${s?.gen ?? 1}` : mode === "test" ? "🏃 Probando cerebro" : "🎮 Modo manual"}
              {mode === "train" && s && <span className="ml-2 text-xs font-medium text-white/60">{s.evaluated}/{s.pop}</span>}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold text-slate-900 ${STAGE_COLORS[stage.level]}`}>{stage.label}</span>
          </button>
          {hudOpen && (
            <>
              <div className="mt-1.5 flex gap-1">
                {(s?.stageLabels ?? TASKS[0].stageLabels).map((n, i) => (
                  <div key={n} className="flex-1">
                    <div className={`h-1.5 rounded-full ${i <= stage.level ? STAGE_COLORS[i] : "bg-white/15"}`} />
                    <div className={`mt-0.5 text-center text-[9px] ${i === stage.level ? "font-bold text-white" : "text-white/40"}`}>{n}</div>
                  </div>
                ))}
              </div>
              {mode === "train" ? (
                <div className="mt-1.5 grid grid-cols-3 gap-1">
                  <Stat label={`Mejor ${s?.metricLabel ?? "distancia"}`} value={`${(last?.bestMetric ?? s?.curBest ?? 0).toFixed(1)} ${s?.metricUnit ?? "m"}`} sub={`récord ${(s?.terrainBest ?? 0).toFixed(1)}`} />
                  <Stat label="Recomp. prom." value={(last?.meanFit ?? 0).toFixed(1)} />
                  <Stat label="Mejor recomp." value={(last?.bestFit ?? 0).toFixed(1)} />
                </div>
              ) : (
                <div className="mt-1.5 grid grid-cols-3 gap-1">
                  <Stat label={s?.metricLabel ?? "Distancia"} value={`${(s?.brainMetric ?? 0).toFixed(1)} ${s?.metricUnit ?? "m"}`} />
                  <Stat label="Tiempo" value={`${(s?.brainTime ?? 0).toFixed(1)} s`} />
                  <Stat label="Generación" value={`${(s?.gen ?? 1) - 1}`} />
                </div>
              )}
              {s && <div className="mt-1 grid grid-cols-3 gap-1"><Stat label="Masa / peso" value={`${s.physics.massKg.toFixed(1)} kg`} sub={`${Math.round(s.physics.weightN)} N`} /><Stat label="Velocidad" value={`${s.physics.velocity.toFixed(1)} m/s`} /><Stat label="Fatiga" value={`${Math.round(s.physics.fatigue * 100)}%`} /></div>}
              {s && <div className="mt-1 text-[10px] text-white/60">{s.task === "exercise" ? `🏋️ ${s.taskMetrics.reps} rep · ${Math.round(s.taskMetrics.workJ)} J` : s.task === "climb" ? `🧗 ${s.taskMetrics.holdTouches} agarres · presa ${s.taskMetrics.maxHold}` : s.task === "boxing" ? `🥊 ${s.taskMetrics.hits} golpes · ${Math.round(s.taskMetrics.peakPunchN)} N` : s.task === "parkour" ? `🤸 ${s.taskMetrics.wallsCleared} muros · ${s.taskMetrics.landings} aterrizajes` : `🦵 Rodillas: izq. ${Math.round(s.physics.kneeLeftDeg)}° · der. ${Math.round(s.physics.kneeRightDeg)}°`}</div>}
              <div className="mt-1 flex items-center justify-between px-1 text-[10px] text-white/60">
                <span>{s?.taskIcon} {s?.taskName} {s?.task === "walk" ? `· ${terrainName}` : ""}</span>
                <span title="Arnés de equilibrio">🪢 Arnés {assistPct}%</span>
                <span>σ {(s?.sigma ?? 0).toFixed(2)}</span>
              </div>
              {mode === "train" && (
                <div className="mt-1">
                  <Chart history={history} />
                  <div className="mt-0.5 flex justify-center gap-3 text-[10px] text-white/60">
                    <span><span className="text-emerald-400">━</span> mejor {s?.metricLabel ?? "distancia"}</span>
                    <span><span className="text-sky-400">━</span> recompensa prom.</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="pointer-events-none flex shrink-0 flex-col items-end gap-1 text-[11px] font-semibold">
          <span className="rounded-full bg-slate-900/70 px-2 py-1 tabular-nums">{perf.fps} FPS</span>
          <span className="rounded-full bg-slate-900/70 px-2 py-1 tabular-nums">
            {paused ? "⏸ pausa" : `x${(s?.effSpeed ?? 0) >= 10 ? Math.round(s?.effSpeed ?? 0) : (s?.effSpeed ?? 0).toFixed(1)}`}
          </span>
          {mode === "train" && <span className="rounded-full bg-slate-900/70 px-2 py-1">{s?.slotCount ?? 0} 👤</span>}
        </div>
      </div>

      {/* ---------- avisos ---------- */}
      <div className="pointer-events-none absolute inset-x-0 top-1/3 flex flex-col items-center gap-2 px-6">
        {toasts.map((t) => (
          <div key={t.id} className="rounded-2xl bg-slate-900/85 px-4 py-2 text-center text-sm font-bold shadow-xl backdrop-blur">
            {t.text}
          </div>
        ))}
      </div>

      {/* ---------- controles inferiores ---------- */}
      <div className="absolute inset-x-0 bottom-0 flex justify-center p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-xl space-y-1.5 rounded-3xl bg-slate-900/80 p-2 shadow-2xl backdrop-blur">
          <div className="grid grid-cols-3 gap-1.5">
            <Btn active={mode === "train"} onClick={() => changeMode("train")}>🧠 Entrenar</Btn>
            <Btn active={mode === "test"} onClick={() => changeMode("test")}>🏃 Probar</Btn>
            <Btn active={mode === "manual"} onClick={() => changeMode("manual")}>🎮 Manual</Btn>
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {SPEEDS.map((v) => (
              <Btn key={v} active={speed === v} onClick={() => changeSpeed(v)} disabled={mode === "manual"}>
                x{v}
              </Btn>
            ))}
            <Btn
              active={paused}
              onClick={() => {
                setPaused(!paused);
                eng()?.setPaused(!paused);
              }}
            >
              {paused ? "▶" : "⏸"}
            </Btn>
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            <Btn onClick={() => setSheet("tasks")}>🏅<span className="block text-[10px] font-medium">Actividad</span></Btn>
            <Btn disabled={s?.task !== "walk"} onClick={() => setSheet("terrain")}>🏔️<span className="block text-[10px] font-medium">Terreno</span></Btn>
            <Btn onClick={changeCam}>🎥<span className="block text-[10px] font-medium">{CAMERA_MODES[cam].name}</span></Btn>
            <button
              onClick={() => eng()?.push()}
              className="min-h-12 select-none rounded-2xl bg-orange-500 px-2 text-sm font-extrabold text-white shadow-lg shadow-orange-500/30 transition active:scale-95"
            >
              💥<span className="block text-[10px] font-semibold">Empujar</span>
            </button>
            <Btn onClick={() => (mode === "manual" ? setSheet("manual") : setSheet("muscles"))} active={sheet === "manual"}>
              {mode === "manual" ? "🎚️" : "🧬"}
              <span className="block text-[10px] font-medium">{mode === "manual" ? "Control" : "Músculos"}</span>
            </Btn>
            <Btn onClick={() => setSheet("menu")}>☰<span className="block text-[10px] font-medium">Menú</span></Btn>
          </div>
        </div>
      </div>

      {sheet === "tasks" && (
        <Sheet title="🏅 Elige una disciplina" onClose={() => setSheet(null)}>
          <p className="mb-3 text-xs text-white/60">Cada actividad tiene su propio aprendizaje y escenario. La IA comienza sin dominarla.</p>
          <div className="space-y-2">{TASKS.map(t => <button key={t.id} onClick={() => { eng()?.send({t: "task", task: t.id}); setSheet(null); }} className={`w-full rounded-2xl p-3 text-left ${s?.task === t.id ? "bg-sky-600" : "bg-white/10"}`}><div className="font-bold">{t.icon} {t.name} <span className="float-right text-xs">récord {(s?.taskBest[t.id] ?? 0).toFixed(1)} {t.unit}</span></div><div className="mt-1 text-xs text-white/70">{t.desc}</div></button>)}</div>
        </Sheet>
      )}
      {sheet === "physics" && s && (
        <Sheet title="⚙️ Física" onClose={() => setSheet(null)}>
          <p className="mb-3 text-xs text-white/60">Al cambiar un ajuste se reinician los episodios. Son aproximaciones, no una simulación médica.</p>
          {([ ["gravityScale", "Gravedad", 0.2, 2, 0.1], ["loadScale", "Carga", 0.2, 2, 0.1], ["muscleScale", "Fuerza muscular", 0.4, 1.8, 0.1], ["fatigueScale", "Fatiga", 0, 2.5, 0.1], ["groundFriction", "Fricción", 0.3, 1.8, 0.1] ] as const).map(([key, label, min, max, step]) => {
            const settings = { gravityScale: s.physics.gravityScale, loadScale: s.physics.loadScale, muscleScale: s.physics.muscleScale, fatigueScale: s.physics.fatigueScale, groundFriction: s.physics.friction };
            return <label key={key} className="block rounded-xl bg-white/5 p-2"><span className="text-sm font-bold">{label}: {settings[key].toFixed(1)}×</span><input className="w-full accent-sky-400" type="range" min={min} max={max} step={step} value={settings[key]} onChange={e => eng()?.send({t:"physics", v:{...settings, [key]: Number(e.target.value)}})} /></label>;
          })}
        </Sheet>
      )}
      {sheet === "muscles" && s && <Sheet title="💪 Músculos y esfuerzo" onClose={() => setSheet(null)}>
        <p className="mb-3 text-xs text-white/60">Azul: reposo · rojo: activación · morado: fatiga. Fuerzas y energía estimadas con un modelo simplificado.</p>
        <div className="grid grid-cols-2 gap-2"><Stat label="Fuerza media" value={`${Math.round(s.physics.muscleForceN)} N`} /><Stat label="Fatiga media" value={`${Math.round(s.physics.fatigue * 100)}%`} /><Stat label="Potencia metabólica" value={`${Math.round(s.physics.powerW)} W`} /><Stat label="Energía" value={`${Math.round(s.physics.energyJ)} J`} /></div>
        <div className="mt-3 space-y-1">{s.muscles.map((m,i) => <div key={i} className="rounded-xl bg-white/5 p-2 text-xs"><div className="flex justify-between"><b>{m.name}</b><span>{Math.round(m.forceN)} N · {Math.round(m.fatigue*100)}% fatiga</span></div><div className="mt-1 h-1.5 rounded bg-white/10"><div className="h-full rounded bg-red-400" style={{width:`${Math.round(m.activation*100)}%`}} /></div></div>)}</div>
      </Sheet>}
      {/* ---------- hoja: terreno ---------- */}
      {sheet === "terrain" && (
        <Sheet title="Terreno" onClose={() => setSheet(null)}>
          <div className="grid grid-cols-2 gap-2">
            {TERRAINS.map((t, i) => {
              const unlocked = s ? s.unlockAll || i <= s.unlocked : i === 0;
              const need = CONFIG.unlockDistances[i];
              return (
                <button
                  key={t.id}
                  disabled={!unlocked}
                  onClick={() => {
                    eng()?.send({ t: "terrain", i });
                    setSheet(null);
                  }}
                  className={`min-h-24 rounded-2xl p-3 text-left transition active:scale-95 ${
                    s?.terrainIdx === i ? "bg-sky-500" : unlocked ? "bg-white/10" : "bg-white/5 opacity-60"
                  }`}
                >
                  <div className="text-2xl">{unlocked ? t.icon : "🔒"}</div>
                  <div className="font-bold">{t.name}</div>
                  <div className="text-[11px] text-white/70">
                    {unlocked ? `Récord ${(0 + (s?.terrainIdx === i ? s?.terrainBest ?? 0 : 0)).toFixed(1)} m` : `Llega a ${need} m en ${TERRAINS[i - 1].name.toLowerCase()}`}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-3 space-y-2">
            <Toggle
              label="Currículo automático"
              desc="Al desbloquear un terreno, entrena en él"
              on={s?.autoCurriculum ?? true}
              onChange={(v) => eng()?.send({ t: "autoCurriculum", v })}
            />
            <Toggle
              label="Desbloquear todos"
              desc="Para probar cualquier terreno sin esperar"
              on={s?.unlockAll ?? false}
              onChange={(v) => eng()?.send({ t: "unlockAll", v })}
            />
          </div>
        </Sheet>
      )}

      {/* ---------- hoja: manual ---------- */}
      {sheet === "manual" && mode === "manual" && (
        <Sheet title="🎚️ Controla los músculos" onClose={() => setSheet(null)}>
          <p className="mb-2 text-xs text-white/60">
            Tú controlas al personaje cian; el morado es el cerebro de la IA para comparar. 0 = pose de reposo, ± = hasta el límite de la articulación.
          </p>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <Btn onClick={() => setAllJoints(new Array(N_JOINTS).fill(0))}>Reposo</Btn>
            <Btn onClick={() => setAllJoints(Array.from({ length: N_JOINTS }, () => +(Math.random() * 1.2 - 0.6).toFixed(2)))}>🎲 Azar</Btn>
            <Btn onClick={() => eng()?.send({ t: "resetSlot", i: 0 })}>↺ Levantar</Btn>
          </div>
          <div className="space-y-2">
            {JOINT_SPECS.map((j, i) => (
              <label key={j.name} className="block">
                <div className="flex justify-between text-xs">
                  <span className="font-semibold">{j.name}</span>
                  <span className="tabular-nums text-white/60">{manualU[i].toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.02}
                  value={manualU[i]}
                  onChange={(e) => setJoint(i, parseFloat(e.target.value))}
                  className="h-8 w-full accent-sky-400"
                />
              </label>
            ))}
          </div>
        </Sheet>
      )}

      {/* ---------- hoja: menú ---------- */}
      {sheet === "menu" && (
        <Sheet title="Menú" onClose={() => setSheet(null)}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Btn className="col-span-2" onClick={() => setSheet("physics")}>⚙️ Ajustar física</Btn>
              <Btn className="min-h-14 !bg-emerald-600" onClick={saveBrain}>💾 Guardar cerebro</Btn>
              <Btn className="min-h-14" onClick={() => fileRef.current?.click()}>📂 Cargar archivo</Btn>
              <Btn className="min-h-14 col-span-2" onClick={loadLocal}>📱 Cargar último guardado del dispositivo</Btn>
              <Btn className="min-h-14 col-span-2" onClick={loadTrained}>☁️ Cargar cerebros preentrenados</Btn>
            </div>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />

            <div className="rounded-2xl bg-white/5 p-3">
              <div className="mb-1 flex justify-between text-sm font-semibold">
                <span>Agentes simultáneos</span>
                <span className="tabular-nums">{agentsSlider}</span>
              </div>
              <input
                type="range"
                min={CONFIG.minAgents}
                max={CONFIG.agentsDesktop}
                step={2}
                value={agentsSlider}
                onChange={(e) => {
                  const n = parseInt(e.target.value);
                  setAgentsSlider(n);
                  eng()?.setAgents(n);
                }}
                className="h-8 w-full accent-sky-400"
              />
              <div className="text-[11px] text-white/50">Solo cambia cuando mueves este control. La calidad gráfica puede ajustarse automáticamente ({perf.quality}/3).</div>
            </div>

            <div className="rounded-2xl bg-white/5 p-3 space-y-2">
              <div className="font-bold">🧠 Ajustes de aprendizaje</div>
              <p className="text-xs text-white/60">Se aplican a la generación siguiente; al aplicar se reinician los episodios incompletos, no el cerebro.</p>
              <label className="block text-sm">Guía de marcha y flexión: {guidance.toFixed(1)}×<input type="range" min="0" max="2" step="0.1" value={guidance} onChange={e => setGuidance(Number(e.target.value))} className="w-full accent-sky-400" /></label>
              <label className="block text-sm">Exploración neuronal: {exploration.toFixed(2)}×<input type="range" min="0.25" max="2" step="0.05" value={exploration} onChange={e => setExploration(Number(e.target.value))} className="w-full accent-sky-400" /></label>
              <Btn className="w-full" onClick={() => { eng()?.send({t: "training", guidance, exploration}); toast("🧠 Ajustes aplicados"); }}>Aplicar ajustes</Btn>
              <p className="text-xs text-white/50">Actual: guía {(s?.training.gaitGuidance ?? 1).toFixed(1)}× · exploración {(s?.training.exploration ?? 1).toFixed(2)}×</p>
            </div>
            <div className="rounded-2xl bg-white/5 p-3 space-y-2">
              <div className="font-bold">🤖 Control robótico</div>
              <Toggle label="Estabilización y límites de acción" desc="Retroalimentación limitada en marcha y suavizado de órdenes de la IA. No afecta al modo manual." on={s?.robotics.controller ?? true} onChange={v => eng()?.send({t: "robotics", controller: v, randomization: s?.robotics.randomization ?? 0})} />
              <label className="block text-sm">Variación física por generación: ±{Math.round(randomization * 100)}%<input type="range" min="0" max="0.25" step="0.01" value={randomization} onChange={e => setRandomization(Number(e.target.value))} className="w-full accent-sky-400" /></label>
              <Btn className="w-full" onClick={() => eng()?.send({t: "robotics", controller: s?.robotics.controller ?? true, randomization})}>Aplicar variación</Btn>
              <p className="text-xs text-white/50">Misma gravedad y fricción para todos los candidatos de una generación; en Probar y Manual se usan valores normales. Aplicar reinicia los episodios incompletos, no el aprendizaje. Actual: ±{Math.round((s?.robotics.randomization ?? 0) * 100)}%.</p>
            </div>
            <Toggle label="Intentar entrenar en segundo plano" desc="Solo con la página abierta: el navegador puede reducir la velocidad o suspenderla para ahorrar batería." on={background} onChange={v => { setBackground(v); eng()?.setBackgroundTraining(v); }} />
            <p className="text-xs leading-relaxed text-white/50">Autoguardado local aproximadamente cada 3 segundos cuando hay progreso; se restaura al abrir. La generación en curso puede repetirse. Exporta una copia para no depender del almacenamiento del navegador. GitHub Pages no ejecuta la simulación. WebGPU {gpu ? "está disponible en este navegador, pero esta simulación todavía usa CPU" : "no está disponible aquí"}; Rapier y el entrenamiento actual no usan GPU.</p>
            <Toggle
              label="Retirar el arnés automáticamente"
              desc="Se reduce al lograr el objetivo; puede aumentar si se estanca cayendo"
              on={s?.autoAssist ?? true}
              onChange={(v) => eng()?.send({ t: "assist", auto: v, value: assistManual })}
            />
            {!(s?.autoAssist ?? true) && (
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="mb-1 flex justify-between text-sm font-semibold">
                  <span>Ayuda del arnés</span>
                  <span className="tabular-nums">{Math.round(assistManual * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={assistManual}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setAssistManual(v);
                    eng()?.send({ t: "assist", auto: false, value: v });
                  }}
                  className="h-8 w-full accent-sky-400"
                />
              </div>
            )}

            {!confirmReset ? (
              <Btn className="min-h-14 w-full !bg-red-600/80" onClick={() => setConfirmReset(true)}>🗑️ Reiniciar aprendizaje desde cero</Btn>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Btn className="min-h-14" onClick={() => setConfirmReset(false)}>Cancelar</Btn>
                <Btn
                  className="min-h-14 !bg-red-600"
                  onClick={() => {
                    eng()?.send({ t: "resetBrain" });
                    setConfirmReset(false);
                    setSheet(null);
                    toast("🧠 Cerebro nuevo: empieza sin saber nada");
                  }}
                >
                  Sí, borrar
                </Btn>
              </div>
            )}
            <p className="text-[11px] leading-relaxed text-white/50">
              Banco virtual de 100 M pesos fijos generados por hash; solo los adaptadores y el router se entrenan. No equivale a 100 M pesos entrenables. Arrastra para girar la cámara · pellizca para acercar. Verde = los 3 mejores del momento, dorado = líder, gris = caído. Física Rapier, 19 articulaciones con límites y torque máximo.
            </p>
          </div>
        </Sheet>
      )}

      {/* ---------- carga / error ---------- */}
      {!ready && !error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-slate-900 text-white">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-sky-400" />
          <div className="font-bold">Cargando motor de física…</div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900 p-6 text-center font-semibold">{error}</div>
      )}
    </div>
  );
}
