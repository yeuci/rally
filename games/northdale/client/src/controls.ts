import { TwinStickTracker, createDirectionKeys, type DirectionKeysHandle } from '@rally/game-kit';
import type { Vec2 } from '@rally/game-northdale-server';

/** Finger travel (CSS px) for a full move at stick size 1: small enough for thumbs. */
export const STICK_RADIUS = 56;
/** A melee tap swings for at least this long, so a quick tap is never lost between frames. */
const TAP_HOLD_MS = 120;

export type Device = 'touch' | 'mouse' | 'keys';

export interface Controls {
  /** Move stick (screen axes, |v| ≤ 1): the move thumb, else WASD / arrows. */
  readonly move: Vec2;
  /** Aim direction from the aim thumb (screen axes, unit), null before the first aim drag. */
  readonly touchAim: Vec2 | null;
  /** The aim thumb is down right now. */
  readonly touchAiming: boolean;
  /** Mouse position on the canvas (CSS px) while the mouse is the aiming device. */
  readonly mouse: Vec2 | null;
  /** Guns fire while this is held: the aim thumb, the left mouse button or Space. */
  readonly fire: boolean;
  /** The melee button, the right mouse button, F or Shift. */
  readonly melee: boolean;
  /** The context button (hold), or E. */
  readonly act: boolean;
  /** Item slot taps: a counter (mod 256) and the slot of the last tap. */
  readonly use: number;
  readonly slot: number;
  readonly device: Device;
  readonly used: boolean;
  enabled: boolean;
  /**
   * The host's shared control settings: `swap` puts the move stick on the right and aim on the left (the melee and
   * context buttons trade sides too), `size` scales the sticks (0.75–1.5), `opacity` fades them (0.2–1).
   */
  configure(opts: { swap: boolean; size: number; opacity: number }): void;
  release(): void;
  draw(): void;
  destroy(): void;
}

/** Mirror a stick vector or finger across the vertical axis (swapped sticks). Pure; tested. */
export function mirrorX<T extends { x: number }>(v: T, on: boolean): T {
  return on ? { ...v, x: -v.x } : v;
}

/**
 * Twin-stick touch controls on game-kit's `TwinStickTracker` (the left half moves, the right half aims and auto-fires
 * guns while held, each finger tracked by pointer id; with the host's "swap sticks" the tracker sees the screen
 * mirrored and the vectors are mirrored back), a melee button, a context button held for most actions, two item-slot
 * buttons, and desktop controls: WASD / arrows, mouse aim, the left button (or Space) fires, the right button (or
 * F / Shift) swings, E holds the context button, 1 / 2 use an item.
 */
export function createControls(
  canvas: HTMLCanvasElement,
  els: { moveStick: HTMLElement; aimStick: HTMLElement; melee: HTMLElement; act: HTMLElement; slots: HTMLElement[] },
): Controls {
  let used = false;
  let device: Device = 'keys';
  let mouse: Vec2 | null = null;
  let mouseDown = false;
  let rightDown = false;
  let spaceDown = false;
  let meleeKey = false;
  let actKey = false;
  let meleeFinger: number | null = null;
  let actFinger: number | null = null;
  let meleeUntil = 0;
  let use = 0;
  let slot = 0;
  let enabled = true;
  let swap = false;
  let size = 1;
  let tracker = new TwinStickTracker({ radius: STICK_RADIUS });

  const keys: DirectionKeysHandle = createDirectionKeys({
    onChange: () => {
      used = true;
      if (device !== 'mouse') device = 'keys';
    },
  });

  // --- the sticks ---
  const touchAt = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    return { x: swap ? r.width - x : x, y: ev.clientY - r.top, width: r.width };
  };
  const onTwinDown = (ev: PointerEvent) => {
    if (!enabled || ev.pointerType === 'mouse') return;
    const p = touchAt(ev);
    if (!tracker.down(ev.pointerId, p.x, p.y, p.width)) return;
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* not capturable (synthetic event) */
    }
    ev.preventDefault();
    used = true;
    device = 'touch';
  };
  const onTwinMove = (ev: PointerEvent) => {
    if (!tracker.owns(ev.pointerId)) return;
    const p = touchAt(ev);
    tracker.drag(ev.pointerId, p.x, p.y);
    used = true;
    device = 'touch';
  };
  const onTwinUp = (ev: PointerEvent) => {
    tracker.up(ev.pointerId);
  };
  const preventTouch = (ev: TouchEvent) => {
    if (ev.cancelable) ev.preventDefault();
  };
  canvas.style.touchAction = 'none';

  // --- the mouse and keys ---
  const local = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const onMouseMove = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse' || !enabled) return;
    mouse = local(ev);
    device = 'mouse';
  };
  const onMouseDown = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse' || !enabled) return;
    mouse = local(ev);
    if (ev.button === 0) mouseDown = true;
    else if (ev.button === 2) {
      rightDown = true;
      meleeUntil = performance.now() + TAP_HOLD_MS;
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
  const isMeleeKey = (code: string) => code === 'KeyF' || code === 'ShiftLeft' || code === 'ShiftRight';
  const tapSlot = (s: number) => {
    slot = s;
    use = (use + 1) & 255;
    used = true;
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    if (!enabled || typing(ev) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.code === 'Space') {
      spaceDown = true;
      used = true;
      ev.preventDefault();
    } else if (isMeleeKey(ev.code)) {
      if (!meleeKey) meleeUntil = performance.now() + TAP_HOLD_MS;
      meleeKey = true;
      used = true;
    } else if (ev.code === 'KeyE') {
      actKey = true;
      used = true;
    } else if ((ev.code === 'Digit1' || ev.code === 'Digit2') && !ev.repeat) {
      tapSlot(ev.code === 'Digit1' ? 0 : 1);
    }
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.code === 'Space') spaceDown = false;
    if (isMeleeKey(ev.code)) meleeKey = false;
    if (ev.code === 'KeyE') actKey = false;
  };

  // --- buttons: each its own finger (a thumb on one never disturbs the sticks) ---
  const onMeleeDown = (ev: PointerEvent) => {
    if (!enabled) return;
    meleeFinger = ev.pointerId;
    meleeUntil = performance.now() + TAP_HOLD_MS;
    used = true;
    els.melee.classList.add('down');
    ev.preventDefault();
    ev.stopPropagation();
  };
  const onActDown = (ev: PointerEvent) => {
    if (!enabled) return;
    actFinger = ev.pointerId;
    used = true;
    els.act.classList.add('down');
    ev.preventDefault();
    ev.stopPropagation();
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId === meleeFinger) {
      meleeFinger = null;
      els.melee.classList.remove('down');
    }
    if (ev.pointerId === actFinger) {
      actFinger = null;
      els.act.classList.remove('down');
    }
  };
  const slotHandlers = els.slots.map((el, i) => {
    const fn = (ev: PointerEvent) => {
      if (!enabled) return;
      tapSlot(i);
      ev.preventDefault();
      ev.stopPropagation();
    };
    el.addEventListener('pointerdown', fn);
    return fn;
  });
  const onBlur = () => release();
  const onContext = (ev: Event) => ev.preventDefault();

  canvas.addEventListener('pointerdown', onTwinDown);
  window.addEventListener('pointermove', onTwinMove);
  window.addEventListener('pointerup', onTwinUp);
  window.addEventListener('pointercancel', onTwinUp);
  canvas.addEventListener('touchstart', preventTouch, { passive: false });
  canvas.addEventListener('touchend', preventTouch, { passive: false });
  canvas.addEventListener('pointermove', onMouseMove);
  canvas.addEventListener('pointerdown', onMouseDown);
  window.addEventListener('pointerup', onMouseUp);
  canvas.addEventListener('contextmenu', onContext);
  els.melee.addEventListener('pointerdown', onMeleeDown);
  els.act.addEventListener('pointerdown', onActDown);
  for (const el of [els.melee, els.act, ...els.slots]) el.addEventListener('contextmenu', onContext);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
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
    // The tracker's fingers are in its (possibly mirrored) space.
    const ox = swap ? r.width - f.originX : f.originX;
    const fx = swap ? r.width - f.x : f.x;
    el.hidden = false;
    el.style.transform = `translate(${ox + r.left}px, ${f.originY + r.top}px) scale(${size})`;
    let dx = fx - ox;
    let dy = f.y - f.originY;
    const len = Math.hypot(dx, dy);
    if (len > clamp) [dx, dy] = [(dx / len) * clamp, (dy / len) * clamp];
    const k = knob(el);
    if (k) k.style.transform = `translate(${dx / size}px, ${dy / size}px)`;
  };

  function release() {
    tracker.releaseAll();
    mouseDown = false;
    rightDown = false;
    spaceDown = false;
    meleeKey = false;
    actKey = false;
    meleeFinger = null;
    actFinger = null;
    meleeUntil = 0;
    els.melee.classList.remove('down');
    els.act.classList.remove('down');
  }

  return {
    get move() {
      const m = mirrorX(tracker.move, swap);
      return m.x !== 0 || m.y !== 0 || tracker.moveFinger ? m : keys.stick;
    },
    get touchAim() {
      const a = tracker.aim;
      return a ? mirrorX(a, swap) : null;
    },
    get touchAiming() {
      return tracker.aiming;
    },
    get mouse() {
      return device === 'mouse' ? mouse : null;
    },
    get fire() {
      return tracker.aiming || mouseDown || spaceDown;
    },
    get melee() {
      return rightDown || meleeKey || meleeFinger !== null || performance.now() < meleeUntil;
    },
    get act() {
      return actKey || actFinger !== null;
    },
    get use() {
      return use;
    },
    get slot() {
      return slot;
    },
    get device() {
      return device;
    },
    get used() {
      return used;
    },
    get enabled() {
      return enabled;
    },
    set enabled(on: boolean) {
      enabled = on;
      keys.enabled = on;
      if (!on) release();
    },
    configure(opts) {
      const nextSize = Math.max(0.75, Math.min(1.5, opts.size));
      if (opts.swap !== swap || nextSize !== size) {
        // A new geometry: let go of the sticks (the next touch picks them up again).
        tracker.releaseAll();
        swap = opts.swap;
        size = nextSize;
        tracker = new TwinStickTracker({ radius: STICK_RADIUS * size });
      }
      document.body.classList.toggle('swap-sticks', swap);
      for (const el of [els.moveStick, els.aimStick])
        el.style.opacity = String(Math.max(0.2, Math.min(1, opts.opacity)));
    },
    release,
    draw() {
      place(els.moveStick, tracker.moveFinger, STICK_RADIUS * 0.6 * size);
      place(els.aimStick, tracker.aimFinger, STICK_RADIUS * 0.6 * size);
    },
    destroy() {
      keys.destroy();
      canvas.removeEventListener('pointerdown', onTwinDown);
      window.removeEventListener('pointermove', onTwinMove);
      window.removeEventListener('pointerup', onTwinUp);
      window.removeEventListener('pointercancel', onTwinUp);
      canvas.removeEventListener('touchstart', preventTouch);
      canvas.removeEventListener('touchend', preventTouch);
      canvas.removeEventListener('pointermove', onMouseMove);
      canvas.removeEventListener('pointerdown', onMouseDown);
      window.removeEventListener('pointerup', onMouseUp);
      canvas.removeEventListener('contextmenu', onContext);
      els.melee.removeEventListener('pointerdown', onMeleeDown);
      els.act.removeEventListener('pointerdown', onActDown);
      els.slots.forEach((el, i) => el.removeEventListener('pointerdown', slotHandlers[i]!));
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
