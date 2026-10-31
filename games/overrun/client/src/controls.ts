import { createDirectionKeys, createTwinStick, type DirectionKeysHandle, type TwinStickHandle } from '@rally/game-kit';
import type { Vec2 } from '@rally/game-overrun-server';

/** Finger travel (CSS px) for a full move: small enough for thumbs. */
export const STICK_RADIUS = 56;

export type Device = 'touch' | 'mouse' | 'keys';

export interface Controls {
  /** Move stick (screen axes, |v| ≤ 1): the left thumb, else WASD / arrows. */
  readonly move: Vec2;
  /** Aim direction from the right thumb (screen axes, unit), null before the first aim drag. */
  readonly touchAim: Vec2 | null;
  /** Mouse position on the canvas (CSS px) while the mouse is the aiming device. */
  readonly mouse: Vec2 | null;
  /** Trigger held: the right thumb is down, the left mouse button or Space is held. */
  readonly fire: boolean;
  /** The device used last (decides how aim is computed). */
  readonly device: Device;
  /** True once the player used any control (hides the hint). */
  readonly used: boolean;
  enabled: boolean;
  /** Weapon steps requested since the last call (mouse wheel: +1 next, -1 previous). */
  takeWeaponStep(): number;
  /** A weapon picked with the number keys 1–5 since the last call (index), or null. */
  takeWeaponPick(): number | null;
  /** Drop every held control (blur, pause). */
  release(): void;
  /** Position the on-screen stick rings (once per frame). */
  draw(): void;
  destroy(): void;
}

/**
 * Twin-stick touch controls (game-kit `createTwinStick`: left half moves, right half aims and fires while held,
 * each finger tracked by pointer id) plus desktop controls: WASD / arrows (game-kit `createDirectionKeys`), mouse
 * aim, hold the left button (or Space) to fire, 1–5 or the wheel to switch weapons.
 */
export function createControls(canvas: HTMLCanvasElement, moveEl: HTMLElement, aimEl: HTMLElement): Controls {
  let used = false;
  let device: Device = 'keys';
  let mouse: Vec2 | null = null;
  let mouseDown = false;
  let spaceDown = false;
  let step = 0;
  let pick: number | null = null;
  const twin: TwinStickHandle = createTwinStick(canvas, {
    radius: STICK_RADIUS,
    onChange: () => {
      used = true;
      device = 'touch';
    },
  });
  const keys: DirectionKeysHandle = createDirectionKeys({
    onChange: () => {
      used = true;
      if (device !== 'mouse') device = 'keys';
    },
  });

  const local = (ev: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const onMouseMove = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse' || !twin.enabled) return;
    mouse = local(ev);
    device = 'mouse';
  };
  const onMouseDown = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0 || !twin.enabled) return;
    mouse = local(ev);
    mouseDown = true;
    used = true;
    device = 'mouse';
    ev.preventDefault();
  };
  const onMouseUp = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse' && ev.button === 0) mouseDown = false;
  };
  const onWheel = (ev: WheelEvent) => {
    if (!twin.enabled || Math.abs(ev.deltaY) < 1) return;
    step += ev.deltaY > 0 ? 1 : -1;
    used = true;
    ev.preventDefault();
  };
  const typing = (ev: KeyboardEvent) => {
    const t = (ev.target as HTMLElement | null)?.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    if (!twin.enabled || typing(ev) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.code === 'Space') {
      spaceDown = true;
      used = true;
      ev.preventDefault();
      return;
    }
    const n = /^Digit([1-5])$/.exec(ev.code)?.[1] ?? /^Numpad([1-5])$/.exec(ev.code)?.[1];
    if (n) {
      pick = Number(n) - 1;
      used = true;
    } else if (ev.code === 'KeyQ' || ev.code === 'KeyE') {
      step += ev.code === 'KeyE' ? 1 : -1;
      used = true;
    }
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.code === 'Space') spaceDown = false;
  };
  const onBlur = () => release();
  const onContext = (ev: Event) => ev.preventDefault();

  canvas.addEventListener('pointermove', onMouseMove);
  canvas.addEventListener('pointerdown', onMouseDown);
  window.addEventListener('pointerup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const knob = (el: HTMLElement) => el.firstElementChild as HTMLElement | null;
  const place = (
    el: HTMLElement,
    f: { originX: number; originY: number; x: number; y: number } | null,
    clamp: number,
  ) => {
    if (!f) {
      el.hidden = true;
      return;
    }
    const r = canvas.getBoundingClientRect();
    el.hidden = false;
    el.style.transform = `translate(${f.originX + r.left}px, ${f.originY + r.top}px)`;
    let dx = f.x - f.originX;
    let dy = f.y - f.originY;
    const len = Math.hypot(dx, dy);
    if (len > clamp) [dx, dy] = [(dx / len) * clamp, (dy / len) * clamp];
    const k = knob(el);
    if (k) k.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  function release() {
    twin.release();
    mouseDown = false;
    spaceDown = false;
  }

  return {
    get move() {
      const m = twin.tracker.move;
      return m.x !== 0 || m.y !== 0 || twin.tracker.moveFinger ? m : keys.stick;
    },
    get touchAim() {
      return twin.tracker.aim;
    },
    get mouse() {
      return device === 'mouse' ? mouse : null;
    },
    get fire() {
      return twin.tracker.aiming || mouseDown || spaceDown;
    },
    get device() {
      return device;
    },
    get used() {
      return used;
    },
    get enabled() {
      return twin.enabled;
    },
    set enabled(on: boolean) {
      twin.enabled = on;
      keys.enabled = on;
      if (!on) release();
    },
    takeWeaponStep() {
      const s = step;
      step = 0;
      return s;
    },
    takeWeaponPick() {
      const p = pick;
      pick = null;
      return p;
    },
    release,
    draw() {
      place(moveEl, twin.tracker.moveFinger, STICK_RADIUS * 0.6);
      place(aimEl, twin.tracker.aimFinger, STICK_RADIUS * 0.6);
    },
    destroy() {
      twin.destroy();
      keys.destroy();
      canvas.removeEventListener('pointermove', onMouseMove);
      canvas.removeEventListener('pointerdown', onMouseDown);
      window.removeEventListener('pointerup', onMouseUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}

/** The next weapon in `step` direction that is unlocked and loaded (`ammo[i] > 0`, the pistol always). */
export function cycleWeapon(current: number, step: number, unlocked: number, ammo: readonly number[]): number {
  if (step === 0 || unlocked <= 1) return current;
  const dir = step > 0 ? 1 : -1;
  let w = current;
  for (let i = 0; i < unlocked; i++) {
    w = (w + dir + unlocked) % unlocked;
    if (w === 0 || (ammo[w] ?? 0) > 0) return w;
  }
  return current;
}
