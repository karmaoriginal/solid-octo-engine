import { CONFIG } from "./config";
import { Scene3D, type FrameData } from "./render/scene";
import type { Piece } from "./sim/terrain";
import type { BrainFile } from "./sim/sim";
import SimWorker from "./sim/worker?worker&inline";

/**
 * ============================================================
 *  ENGINE: une el worker de simulación con la escena 3D
 * ============================================================
 *  - Dibuja a ~60 fps el último fotograma recibido del worker.
 *  - Vigila los FPS y ajusta la calidad gráfica sin cambiar el número de agentes.
 *  - Traduce las acciones de la interfaz en mensajes para el worker.
 */

export type Snapshot = ReturnType<import("./sim/sim").Simulation["snapshot"]> & {
  effSpeed: number;
  stepMs: number;
  speed: number;
  autoAssist: boolean;
  autoCurriculum: boolean;
  unlockAll: boolean;
  slotCount: number;
};

export interface EngineEvents {
  onSnap: (s: Snapshot) => void;
  onToast: (t: string) => void;
  onReady: () => void;
  onPerf: (p: { fps: number; quality: number; agents: number }) => void;
}

export const BRAIN_KEY = "ia-camina-brain-v2";

export class Engine {
  private worker: Worker;
  scene: Scene3D;
  private frame: FrameData | null = null;
  private raf = 0;
  private lastT = performance.now();
  private emaDt = 16;
  private quality = 0;
  private lastPerfCheck = performance.now();
  private goodSince = performance.now();
  private lastChange = performance.now();
  private agents: number;
  private brainPurpose = new Map<string, (b: BrainFile) => void>();
  private disposed = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private backgroundTraining = true;
  private saveWarning = false;
  mobile: boolean;
  private onResize: () => void;
  private onVis: () => void;

  constructor(private canvas: HTMLCanvasElement, private ev: EngineEvents) {
    this.mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 1000);
    this.agents = this.mobile ? CONFIG.agentsMobile : CONFIG.agentsDesktop;
    this.scene = new Scene3D(canvas, this.mobile);
    this.worker = new SimWorker();
    this.worker.onmessage = (e) => this.onMessage(e.data);
    let saved: unknown = null;
    try { const raw = localStorage.getItem(BRAIN_KEY); if (raw) saved = JSON.parse(raw); }
    catch { this.ev.onToast("⚠️ No se pudo leer el guardado local"); }
    this.worker.postMessage({ t: "init", agents: this.agents, saved });
    this.applyBudget();
    this.attachInput();
    this.onResize = () => this.scene.resize();
    window.addEventListener("resize", this.onResize);
    this.onVis = () => {
      this.send({ t: "background", v: document.hidden && this.backgroundTraining });
      this.send({ t: "pause", v: this.userPaused || (document.hidden && !this.backgroundTraining) });
    };
    document.addEventListener("visibilitychange", this.onVis);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  private userPaused = false;

  // ------------------------------------------------------------ mensajes del worker
  private onMessage(m: any) {
    switch (m.t) {
      case "ready":
        this.ev.onReady();
        break;
      case "frame":
        this.frame = m as FrameData;
        break;
      case "profile":
        this.scene.setProfile(m.pieces as Piece[], m.structures, m.task, m.bag, m.propKind);
        break;
      case "snap": {
        const s = m.snap as Snapshot;
        this.ev.onSnap(s);
        for (const t of m.events as string[]) this.ev.onToast(t);
        break;
      }
      case "checkpoint":
        try {
          localStorage.setItem(BRAIN_KEY, JSON.stringify(m.data));
          this.saveWarning = false;
        } catch {
          if (!this.saveWarning) this.ev.onToast("⚠️ No se pudo autoguardar: revisa el espacio del navegador y descarga una copia");
          this.saveWarning = true;
        }
        break;
      case "brain": {
        const cb = this.brainPurpose.get(m.purpose);
        if (cb) {
          this.brainPurpose.delete(m.purpose);
          cb(m.data as BrainFile);
        }
        break;
      }
      case "toast":
        this.ev.onToast(m.text);
        break;
    }
  }

  // ------------------------------------------------------------ comandos
  send(msg: Record<string, unknown>) {
    this.worker.postMessage(msg);
  }
  setSpeed(v: number) {
    this.send({ t: "speed", v });
  }
  setMode(mode: Snapshot["mode"]) {
    this.send({ t: "mode", mode });
  }
  setPaused(p: boolean) {
    this.userPaused = p;
    this.onVis();
  }
  setBackgroundTraining(enabled: boolean) {
    this.backgroundTraining = enabled;
    this.onVis();
  }
  push() {
    this.send({ t: "push", slot: 0 });
    this.scene.kick();
  }
  setAgents(n: number) {
    this.agents = n;
    this.send({ t: "agents", n });
  }
  get agentCount() {
    return this.agents;
  }
  requestBrain(purpose: string, cb: (b: BrainFile) => void) {
    this.brainPurpose.set(purpose, cb);
    this.send({ t: "export", purpose });
  }

  // ------------------------------------------------------------ rendimiento adaptable
  private applyBudget() {
    this.send({ t: "budget", v: [12, 10, 8, 6][Math.min(this.quality, 3)] });
  }
  private adapt(now: number) {
    if (now - this.lastPerfCheck < 2000) return;
    this.lastPerfCheck = now;
    const fps = 1000 / this.emaDt;
    if (fps < 38 && now - this.lastChange > 2500) {
      this.lastChange = now;
      this.goodSince = now;
      if (this.quality < 3) {
        this.quality++;
        this.scene.setQuality(this.quality);
        this.applyBudget();
      }
    } else if (fps > 55) {
      if (now - this.goodSince > 25000 && this.quality > 0 && now - this.lastChange > 25000) {
        this.quality--;
        this.scene.setQuality(this.quality);
        this.applyBudget();
        this.lastChange = now;
        this.goodSince = now;
      }
    } else this.goodSince = now;
    this.ev.onPerf({ fps: Math.round(fps), quality: this.quality, agents: this.agents });
  }

  // ------------------------------------------------------------ bucle de dibujo
  private loop(now: number) {
    if (this.disposed) return;
    const dt = Math.min((now - this.lastT) / 1000, 0.1);
    this.lastT = now;
    this.emaDt = this.emaDt * 0.92 + dt * 1000 * 0.08;
    this.scene.render(this.frame, dt);
    this.adapt(now);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------ entrada táctil / ratón
  private attachInput() {
    const c = this.canvas;
    c.style.touchAction = "none";
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    c.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 1) this.scene.orbit(dx, dy);
      else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0) this.scene.zoom(this.pinchDist / d);
        this.pinchDist = d;
      }
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.pinchDist = 0;
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.scene.zoom(e.deltaY > 0 ? 1.1 : 0.9);
      },
      { passive: false },
    );
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVis);
    this.worker.terminate();
    this.scene.dispose();
  }
}
