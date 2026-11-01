/**
 * Aim assist for touch aiming (`settings.controls.aimAssist`): a gentle snap. When a target lies within a narrow cone
 * around the player's aim and within range, the aim turns to it; otherwise it is left alone. Pure; unit-tested.
 */

export interface AimPoint {
  x: number;
  y: number;
}

export interface AimAssistOptions {
  /** Half-angle of the snap cone, radians. Default 12°. */
  cone?: number;
  /** Farthest target considered. Default Infinity. */
  range?: number;
  /** Nearest target considered (point-blank needs no help). Default 0. */
  minRange?: number;
}

/**
 * `aim` (a unit direction from `from`) snapped toward the best target in the cone: the smallest angle wins, then the
 * nearest. Returns the new unit direction, or `aim` unchanged when no target qualifies.
 */
export function assistAim(
  aim: AimPoint,
  from: AimPoint,
  targets: Iterable<AimPoint>,
  options: AimAssistOptions = {},
): AimPoint {
  const cone = options.cone ?? (12 * Math.PI) / 180;
  const range = options.range ?? Infinity;
  const minRange = options.minRange ?? 0;
  const len = Math.hypot(aim.x, aim.y);
  if (len === 0) return aim;
  const ax = aim.x / len;
  const ay = aim.y / len;
  let best: { x: number; y: number; angle: number; dist: number } | null = null;
  for (const t of targets) {
    const dx = t.x - from.x;
    const dy = t.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= minRange || dist > range) continue;
    const cos = (dx * ax + dy * ay) / dist;
    const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
    if (angle > cone) continue;
    if (!best || angle < best.angle - 1e-6 || (Math.abs(angle - best.angle) <= 1e-6 && dist < best.dist)) {
      best = { x: dx / dist, y: dy / dist, angle, dist };
    }
  }
  return best ? { x: best.x, y: best.y } : aim;
}
