import { ARENA_HALF_H, ARENA_HALF_W } from './constants.ts';
import type { Vec2 } from './vec.ts';

/**
 * The client camera's framing, shared so the rules know what a player can see (bots never fire from off someone's
 * screen): client/src/scene.ts frames the yard with exactly these numbers and functions.
 *
 * The camera looks down at `CAMERA_PITCH_DEG` from the +y side (south) with a vertical field of view of
 * `CAMERA_FOV_DEG`, at the distance that shows at least `VIEW_HALF_W` units either side of its focus and
 * `VIEW_HALF_H` up and down; its focus is the player, led toward the aim, kept inside the yard.
 */
export const CAMERA_PITCH_DEG = 60;
export const CAMERA_FOV_DEG = 30;
export const VIEW_HALF_W = 10;
export const VIEW_HALF_H = 5.8;
/** Camera lead toward the aim, units (across; 70 % of it up and down the screen). */
export const CAMERA_LEAD = 2;
/** Landscape phone screens, narrowest to widest (16:9 … 19.5:9): a gate that holds on both holds on every phone. */
export const PHONE_ASPECTS = [16 / 9, 19.5 / 9] as const;

const PITCH = (CAMERA_PITCH_DEG * Math.PI) / 180;
const TAN_V = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);

/** Camera distance from its focus for a viewport `aspect` (width / height). */
export function cameraDistance(aspect: number): number {
  return Math.max(VIEW_HALF_W / (TAN_V * aspect), (VIEW_HALF_H * Math.sin(PITCH)) / TAN_V);
}

/** The lead toward an aim angle (sim axes). */
export function aimLead(aim: number): Vec2 {
  return { x: Math.cos(aim) * CAMERA_LEAD, y: Math.sin(aim) * CAMERA_LEAD * 0.7 };
}

/**
 * Where the camera looks for a player at (x, y) with `lead` (aspect and zoom as drawn): the lead added, then kept
 * inside the yard plus a margin when the yard is bigger than the screen.
 */
export function cameraFocus(x: number, y: number, lead: Vec2, aspect: number, zoom = 1): Vec2 {
  const dist = cameraDistance(aspect) * zoom;
  const halfW = dist * TAN_V * aspect;
  const halfH = (dist * TAN_V) / Math.sin(PITCH);
  const mx = Math.max(0, ARENA_HALF_W + 2 - halfW);
  const my = Math.max(0, ARENA_HALF_H + 1.5 - halfH);
  return { x: Math.max(-mx, Math.min(mx, x + lead.x)), y: Math.max(-my, Math.min(my, y + lead.y)) };
}

/**
 * Whether the ground point (dx, dy) from the camera's focus is on a screen of `aspect`, at least `margin` units
 * inside its edges: the exact perspective frustum (the far side of the screen shows more ground than the near side).
 */
export function onScreen(dx: number, dy: number, aspect: number, margin = 0): boolean {
  const dist = cameraDistance(aspect);
  const sin = Math.sin(PITCH);
  const cos = Math.cos(PITCH);
  // Camera at (0, h, back) in (x, height, y); the point is (dx, 0, dy).
  const h = dist * sin;
  const back = dist * cos;
  const vy = -h;
  const vz = dy - back;
  const depth = -vy * sin - vz * cos;
  if (depth <= 0) return false;
  const up = vy * cos - vz * sin;
  return Math.abs(dx) + margin <= depth * TAN_V * aspect && Math.abs(up) + margin * sin <= depth * TAN_V;
}

/** How far inside a screen's edges someone must stand to count as seen (their feet; the body is drawn above them). */
export const SEEN_MARGIN = 0.6;

/**
 * Whether a player at `target` (aiming at `aim`) has `p` on their screen, on every phone shape (`PHONE_ASPECTS`):
 * the rule for bots firing at them.
 */
export function onTheirScreen(target: { x: number; y: number; aim: number }, p: Vec2): boolean {
  for (const aspect of PHONE_ASPECTS) {
    const f = cameraFocus(target.x, target.y, aimLead(target.aim), aspect);
    if (!onScreen(p.x - f.x, p.y - f.y, aspect, SEEN_MARGIN)) return false;
  }
  return true;
}
