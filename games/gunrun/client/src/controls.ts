import { createDirectionKeys, createTwinStick, type DirectionKeysHandle, type TwinStickHandle } from '@rally/game-kit';
import type { Vec2 } from '@rally/game-gunrun-server';

/** Finger travel (CSS px) for a full move: small enough for thumbs. */
export const STICK_RADIUS = 56;
/** A knife button tap (or key press) stabs for at least this long, so a quick tap is never lost between frames. */
const KNIFE_HOLD_MS = 120;

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
  /** Knife: the knife button, the right mouse button, F or Shift. */
  readonly melee: boolean;
  /** The device used last (decides how aim is computed). */
  readonly device: Device;
  /** True once the player used any control (hides the hint). */
  readonly used: boolean;
  enabled: boolean;
  /** Drop every held control (blur, pause). */
  release(): void;
  /** Position the on-screen stick rings (once per frame). */
  draw(): void;
  destroy(): void;
}

/**
 * Twin-stick touch controls (game-kit `createTwinStick`: left half moves, right half aims and fires while held, each
 * finger tracked by pointer id) and a knife button, plus desktop controls: WASD / arrows (game-kit
 * `createDirectionKeys`), mouse aim, hold the left button (or Space) to fire, the right button (or F / Shift) to stab.
 */
export function createControls(
  canvas: HTMLCanvasElement,
  moveEl: HTMLElement,
  aimEl: HTMLElement,
  knifeEl: HTMLElement,
): Controls {
  let used = false;
  let device: Device = 'keys';
  let mouse: Vec2 | null = null;
  let mouseDown = false;
  let rightDown = false;
  let spaceDown = false;
  let knifeKey = false;
  let knifeFinger: number | null = null;
  let knifeUntil = 0;
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

  const local = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const onMouseMove = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse' || !twin.enabled) return;
    mouse = local(ev);
    device = 'mouse';
  };
  const onMouseDown = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse' || !twin.enabled) return;
    mouse = local(ev);
    if (ev.button === 0) mouseDown = true;
    else if (ev.button === 2) {
      rightDown = true;
      knifeUntil = performance.now() + KNIFE_HOLD_MS;
    }
    used = true;
    device = 'mouse';
    ev.preventDefault();
  };
  const onMouseUp = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse') return;
    if (ev.button === 0) mouseDown = false;
    if (ev.button === 2) rightDown = false;
  };
  const typing = (ev: KeyboardEvent) => {
    const t = (ev.target as HTMLElement | null)?.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  };
  const isKnifeKey = (code: string) => code === 'KeyF' || code === 'ShiftLeft' || code === 'ShiftRight';
  const onKeyDown = (ev: KeyboardEvent) => {
    if (!twin.enabled || typing(ev) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.code === 'Space') {
      spaceDown = true;
      used = true;
      ev.preventDefault();
    } else if (isKnifeKey(ev.code)) {
      if (!knifeKey) knifeUntil = performance.now() + KNIFE_HOLD_MS;
      knifeKey = true;
      used = true;
    }
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.code === 'Space') spaceDown = false;
    if (isKnifeKey(ev.code)) knifeKey = false;
  };
  // The knife button: its own finger (a second thumb on it never disturbs the sticks).
  const onKnifeDown = (ev: PointerEvent) => {
    if (!twin.enabled) return;
    knifeFinger = ev.pointerId;
    knifeUntil = performance.now() + KNIFE_HOLD_MS;
    used = true;
    knifeEl.classList.add('down');
    ev.preventDefault();
    ev.stopPropagation();
  };
  const onKnifeUp = (ev: PointerEvent) => {
    if (ev.pointerId !== knifeFinger) return;
    knifeFinger = null;
    knifeEl.classList.remove('down');
  };
  const onBlur = () => release();
  const onContext = (ev: Event) => ev.preventDefault();

  canvas.addEventListener('pointermove', onMouseMove);
  canvas.addEventListener('pointerdown', onMouseDown);
  window.addEventListener('pointerup', onMouseUp);
  canvas.addEventListener('contextmenu', onContext);
  knifeEl.addEventListener('pointerdown', onKnifeDown);
  knifeEl.addEventListener('contextmenu', onContext);
  window.addEventListener('pointerup', onKnifeUp);
  window.addEventListener('pointercancel', onKnifeUp);
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
    rightDown = false;
    spaceDown = false;
    knifeKey = false;
    knifeFinger = null;
    knifeUntil = 0;
    knifeEl.classList.remove('down');
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
    get melee() {
      return rightDown || knifeKey || knifeFinger !== null || performance.now() < knifeUntil;
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
      canvas.removeEventListener('contextmenu', onContext);
      knifeEl.removeEventListener('pointerdown', onKnifeDown);
      knifeEl.removeEventListener('contextmenu', onContext);
      window.removeEventListener('pointerup', onKnifeUp);
      window.removeEventListener('pointercancel', onKnifeUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
