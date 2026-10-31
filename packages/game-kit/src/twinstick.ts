/**
 * Twin-stick touch controls: the left part of the screen is a move stick, the right part an aim stick, each driven by
 * its own finger at the same time. A stick is anchored where its finger went down and follows the drag.
 *
 * Pointer ids are tracked per stick, so only a stick's own finger moves or releases it: a second finger landing
 * on the same side is ignored, and a finger lifting elsewhere never ends the other stick's drag (the bug a
 * single-pointer joystick has when a second finger touches the screen).
 */

export interface TwinStickVector {
  x: number;
  y: number;
}

export interface TwinStickOptions {
  /** Finger travel (CSS px) for a full move deflection. Default 56. */
  radius?: number;
  /** Fraction of the width (from the left) that belongs to the move stick. Default 0.5. */
  split?: number;
  /** An aim drag shorter than this (px) keeps the previous aim direction. Default 10. */
  aimDeadzonePx?: number;
  /** Move drags shorter than this fraction of `radius` count as zero. Default 0.08. */
  moveDeadzone?: number;
}

/** One stick's finger: where it went down and where it is now (CSS px, relative to the target). */
export interface TwinStickTouch {
  id: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
}

/** Pure tracker behind {@link createTwinStick} (no DOM; unit-tested). */
export class TwinStickTracker {
  readonly radius: number;
  readonly split: number;
  readonly aimDeadzonePx: number;
  readonly moveDeadzone: number;
  private moveTouch: TwinStickTouch | null = null;
  private aimTouch: TwinStickTouch | null = null;
  private lastAim: TwinStickVector | null = null;

  constructor(options: TwinStickOptions = {}) {
    this.radius = options.radius ?? 56;
    this.split = options.split ?? 0.5;
    this.aimDeadzonePx = options.aimDeadzonePx ?? 10;
    this.moveDeadzone = options.moveDeadzone ?? 0.08;
  }

  /**
   * A finger went down at (x, y) on a target `width` px wide. Returns the stick it now drives, or null when that
   * side already has a finger (ignored).
   */
  down(id: number, x: number, y: number, width: number): 'move' | 'aim' | null {
    if (this.owns(id)) return null;
    const side = x < width * this.split ? 'move' : 'aim';
    const touch = { id, originX: x, originY: y, x, y };
    if (side === 'move') {
      if (this.moveTouch) return null;
      this.moveTouch = touch;
    } else {
      if (this.aimTouch) return null;
      this.aimTouch = touch;
    }
    return side;
  }

  /** A finger moved; only its own stick follows. */
  drag(id: number, x: number, y: number): void {
    const t = this.moveTouch?.id === id ? this.moveTouch : this.aimTouch?.id === id ? this.aimTouch : null;
    if (!t) return;
    t.x = x;
    t.y = y;
    if (t === this.aimTouch) {
      const dx = x - t.originX;
      const dy = y - t.originY;
      const len = Math.hypot(dx, dy);
      if (len >= this.aimDeadzonePx) this.lastAim = { x: dx / len, y: dy / len };
    }
  }

  /** A finger lifted (or was cancelled). Returns which stick it released, if any. */
  up(id: number): 'move' | 'aim' | null {
    if (this.moveTouch?.id === id) {
      this.moveTouch = null;
      return 'move';
    }
    if (this.aimTouch?.id === id) {
      this.aimTouch = null;
      return 'aim';
    }
    return null;
  }

  /** Drop both sticks (blur, pause). The last aim direction is kept. */
  releaseAll(): void {
    this.moveTouch = null;
    this.aimTouch = null;
  }

  /** Whether `id` drives a stick. */
  owns(id: number): boolean {
    return this.moveTouch?.id === id || this.aimTouch?.id === id;
  }

  /** Move stick, |v| ≤ 1 (screen axes: x right, y down); zero without a finger or inside the dead zone. */
  get move(): TwinStickVector {
    const t = this.moveTouch;
    if (!t) return { x: 0, y: 0 };
    let x = (t.x - t.originX) / this.radius;
    let y = (t.y - t.originY) / this.radius;
    const len = Math.hypot(x, y);
    if (len < this.moveDeadzone) return { x: 0, y: 0 };
    if (len > 1) [x, y] = [x / len, y / len];
    return { x, y };
  }

  /** Aim direction (unit, screen axes): the current aim drag, else the last one; null before the first. */
  get aim(): TwinStickVector | null {
    return this.lastAim ? { ...this.lastAim } : null;
  }

  /** True while the aim finger is down (twin-stick shooters fire while it is held). */
  get aiming(): boolean {
    return this.aimTouch !== null;
  }

  get moveFinger(): Readonly<TwinStickTouch> | null {
    return this.moveTouch;
  }

  get aimFinger(): Readonly<TwinStickTouch> | null {
    return this.aimTouch;
  }
}

export interface TwinStickHandle {
  readonly tracker: TwinStickTracker;
  /** Ignore new fingers while false; disabling releases both sticks. Default true. */
  enabled: boolean;
  /** Release both sticks (blur, pause). */
  release(): void;
  destroy(): void;
}

/**
 * DOM wiring for {@link TwinStickTracker} on `target`: pointer-down on the target picks a stick by side; moves,
 * lifts and cancels are read on `window` (filtered by pointer id), so a finger that slides off the canvas keeps its
 * stick. Mouse pointers are ignored unless `mouse: true` (desktop games usually aim with the cursor instead).
 */
export function createTwinStick(
  target: HTMLElement,
  options: TwinStickOptions & { mouse?: boolean; onChange?: () => void } = {},
): TwinStickHandle {
  const tracker = new TwinStickTracker(options);
  let enabled = true;
  target.style.touchAction = 'none';
  const local = (ev: PointerEvent) => {
    const r = target.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top, width: r.width };
  };
  const onDown = (ev: PointerEvent) => {
    if (!enabled || (ev.pointerType === 'mouse' && !options.mouse)) return;
    const p = local(ev);
    if (!tracker.down(ev.pointerId, p.x, p.y, p.width)) return;
    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      /* not capturable (synthetic event) */
    }
    ev.preventDefault();
    options.onChange?.();
  };
  const onMove = (ev: PointerEvent) => {
    if (!tracker.owns(ev.pointerId)) return;
    const p = local(ev);
    tracker.drag(ev.pointerId, p.x, p.y);
    options.onChange?.();
  };
  const onUp = (ev: PointerEvent) => {
    if (tracker.up(ev.pointerId)) options.onChange?.();
  };
  const preventTouch = (ev: TouchEvent) => {
    if (ev.cancelable) ev.preventDefault();
  };
  target.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  target.addEventListener('touchstart', preventTouch, { passive: false });
  target.addEventListener('touchend', preventTouch, { passive: false });
  return {
    tracker,
    get enabled() {
      return enabled;
    },
    set enabled(on: boolean) {
      enabled = on;
      if (!on) tracker.releaseAll();
    },
    release() {
      tracker.releaseAll();
      options.onChange?.();
    },
    destroy() {
      target.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      target.removeEventListener('touchstart', preventTouch);
      target.removeEventListener('touchend', preventTouch);
    },
  };
}
