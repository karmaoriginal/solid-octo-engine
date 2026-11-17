/** Recompensa pequeña por flexionar la rodilla de la pierna libre durante un paso.
 * No impone una trayectoria: la política sigue controlando las articulaciones. */
export function swingKneeBonus(leftContact: boolean, rightContact: boolean, leftAngle: number, rightAngle: number, forwardSpeed: number): number {
  // Requiere un pie de apoyo y avance; no recompensa saltar ni flexionar parado.
  if (leftContact === rightContact) return 0;
  const angle = leftContact ? rightAngle : leftAngle;
  const flex = Math.max(0, 1 - Math.abs(angle - 0.6) / 0.6); // óptimo aproximado: 34°
  return flex * Math.max(0, Math.min(1, forwardSpeed / 0.5));
}
