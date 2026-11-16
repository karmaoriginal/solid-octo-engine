import { useEffect, useRef } from "react";
import type { GenStat } from "../sim/sim";

/** Gráfica de progreso: mejor distancia (verde) y recompensa promedio (azul), por generación. */
export function Chart({ history, height = 78 }: { history: GenStat[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = height;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,0.05)";
    g.fillRect(0, 0, w, h);
    if (history.length < 2) {
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.font = "11px sans-serif";
      g.fillText("La gráfica aparece tras 2 generaciones…", 8, h / 2 + 4);
      return;
    }
    const n = history.length;
    const pad = 4;
    const xs = (i: number) => pad + (i / (n - 1)) * (w - pad * 2);
    // marcas de cambio de terreno
    g.strokeStyle = "rgba(255,255,255,0.25)";
    g.setLineDash([3, 3]);
    for (let i = 1; i < n; i++) {
      if (history[i].terrain !== history[i - 1].terrain) {
        g.beginPath();
        g.moveTo(xs(i), 0);
        g.lineTo(xs(i), h);
        g.stroke();
      }
    }
    g.setLineDash([]);
    const series = (get: (s: GenStat) => number, color: string, smooth: number) => {
      const vals = history.map(get);
      const sm: number[] = [];
      let acc = vals[0];
      for (const v of vals) {
        acc = acc + (v - acc) * smooth;
        sm.push(acc);
      }
      const lo = Math.min(0, ...sm);
      const hi = Math.max(1e-6, ...sm);
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      sm.forEach((v, i) => {
        const y = h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);
        if (i === 0) g.moveTo(xs(i), y);
        else g.lineTo(xs(i), y);
      });
      g.stroke();
    };
    series((s) => s.meanFit, "#60a5fa", 0.25);
    series((s) => s.bestMetric, "#4ade80", 0.5);
  }, [history, height]);
  return <canvas ref={ref} className="w-full rounded-lg" style={{ height }} />;
}
