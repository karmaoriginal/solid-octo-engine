import { CONFIG, type TerrainId } from "../config";

/**
 * El terreno es un perfil 2D (x, altura) formado por tramos rectos ("piezas").
 * Entre piezas puede haber saltos verticales (escalones, obstáculos).
 * El mismo perfil sirve para: colisiones (cajas), render y altura del suelo (terrainY).
 */
export interface Piece {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Un hueco no tiene colisionador: se usa en parkour. */
  hole?: boolean;
}

const START_FLAT = 6; // metros planos al inicio, siempre

/** Construye el perfil del terreno pedido. */
export function buildProfile(id: TerrainId): Piece[] {
  const L = CONFIG.terrainLength;
  const p: Piece[] = [];
  let x = -30;
  let y = 0;
  const flat = (len: number) => {
    p.push({ x0: x, x1: x + len, y0: y, y1: y });
    x += len;
  };
  const slope = (len: number, rise: number) => {
    p.push({ x0: x, x1: x + len, y0: y, y1: y + rise });
    x += len;
    y += rise;
  };
  const jump = (dy: number) => {
    y += dy;
  };

  flat(START_FLAT + 30);

  if (id === "slopes") {
    const degs = [3, 5, 7, 9, 6, 8, 10, 7, 9, 10];
    let i = 0;
    while (x < L) {
      const d = (degs[i % degs.length] * Math.PI) / 180;
      const len = 7;
      const rise = Math.tan(d) * len;
      slope(len, rise);
      flat(2.5);
      slope(len, -rise);
      flat(3);
      i++;
    }
  } else if (id === "stairs") {
    const heights = [0.05, 0.06, 0.07, 0.08, 0.09, 0.1];
    let i = 0;
    while (x < L) {
      const h = heights[i % heights.length];
      for (let k = 0; k < 4; k++) {
        jump(h);
        flat(1.4);
      }
      flat(2.5);
      for (let k = 0; k < 4; k++) {
        jump(-h);
        flat(1.4);
      }
      flat(3);
      i++;
    }
  } else if (id === "obstacles") {
    const hs = [0.05, 0.07, 0.09, 0.06, 0.11, 0.08, 0.13, 0.1];
    let i = 0;
    while (x < L) {
      flat(3.2);
      const h = hs[i % hs.length];
      jump(h);
      flat(0.28);
      jump(-h);
      if (i % 3 === 2) {
        flat(0.9);
        jump(h * 0.8);
        flat(0.28);
        jump(-h * 0.8);
      }
      i++;
    }
  } else {
    flat(L);
  }
  // pieza final larga para que no haya borde
  flat(60);
  return merge(p);
}

/** Une piezas consecutivas planas con la misma altura (evita costuras que "enganchan" los pies). */
function merge(p: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const a of p) {
    const last = out[out.length - 1];
    if (
      last && !last.hole && !a.hole &&
      last.y0 === last.y1 && a.y0 === a.y1 &&
      Math.abs(last.y1 - a.y0) < 1e-9 && Math.abs(last.x1 - a.x0) < 1e-6
    ) {
      last.x1 = a.x1;
    } else out.push({ ...a });
  }
  return out;
}

/** Altura del suelo en la coordenada x (búsqueda binaria). */
export function terrainY(p: Piece[], x: number): number {
  let lo = 0;
  let hi = p.length - 1;
  if (x <= p[0].x0) return p[0].y0;
  if (x >= p[hi].x1) return p[hi].y1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p[mid].x0 <= x) lo = mid;
    else hi = mid - 1;
  }
  const a = p[lo];
  const t = (x - a.x0) / (a.x1 - a.x0);
  return a.y0 + (a.y1 - a.y0) * t;
}

/** Caja rotada que representa la pieza (superficie superior = segmento). */
export function pieceBox(a: Piece, thickness = 1.2) {
  const dx = a.x1 - a.x0;
  const dy = a.y1 - a.y0;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  const mx = (a.x0 + a.x1) / 2 - nx * (thickness / 2);
  const my = (a.y0 + a.y1) / 2 - ny * (thickness / 2);
  const ang = Math.atan2(dy, dx);
  return { cx: mx, cy: my, halfLen: len / 2, halfThick: thickness / 2, angle: ang };
}
