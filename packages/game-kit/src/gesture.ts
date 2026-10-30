/** Pure tap/drag classifier behind `createInput` (no DOM, unit-tested). Coordinates in CSS px, times in ms. */

export interface PointerSample {
  x: number;
  y: number;
  /** `performance.now()`-based timestamp (DOM `event.timeStamp`). */
  time: number;
}

export interface PressEvent extends PointerSample {
  pointerType: string;
  /** `PointerEvent.pointerId` of the tracked pointer (-1 for the keyboard): match it against window-level events. */
  pointerId: number;
}

export interface DragEvent extends PointerSample {
  startX: number;
  startY: number;
  /** Movement since the previous drag event. */
  dx: number;
  dy: number;
}

export interface GestureHandlers {
  /** Fires on pointer-down, before any tap/drag decision. Use it for one-input arcade games (lowest latency). */
  onPress?: (e: PressEvent) => void;
  /** Fires on release when the pointer stayed within `tapSlop` and released within `tapMaxMs`. */
  onTap?: (e: PressEvent) => void;
  onDragStart?: (e: DragEvent) => void;
  onDrag?: (e: DragEvent) => void;
  onDragEnd?: (e: DragEvent) => void;
}

export interface GestureOptions {
  /** Max movement (px) for a tap. Default 10. */
  tapSlop?: number;
  /** Max press duration (ms) for a tap. Default 400. */
  tapMaxMs?: number;
}

export class GestureTracker {
  private readonly h: GestureHandlers;
  private readonly slop: number;
  private readonly tapMaxMs: number;
  private active: { id: number; type: string; start: PointerSample; last: PointerSample; dragging: boolean } | null =
    null;

  constructor(handlers: GestureHandlers, options: GestureOptions = {}) {
    this.h = handlers;
    this.slop = options.tapSlop ?? 10;
    this.tapMaxMs = options.tapMaxMs ?? 400;
  }

  get isDown(): boolean {
    return this.active !== null;
  }

  /** Returns false when ignored (a second finger while one is down: only the primary pointer is tracked). */
  down(id: number, type: string, s: PointerSample): boolean {
    if (this.active) return false;
    this.active = { id, type, start: s, last: s, dragging: false };
    this.h.onPress?.({ ...s, pointerType: type, pointerId: id });
    return true;
  }

  move(id: number, s: PointerSample): void {
    const a = this.active;
    if (!a || a.id !== id) return;
    if (!a.dragging && Math.hypot(s.x - a.start.x, s.y - a.start.y) > this.slop) {
      a.dragging = true;
      this.h.onDragStart?.(this.drag(a.start, a.start, a.start));
    }
    if (a.dragging) this.h.onDrag?.(this.drag(a.start, a.last, s));
    a.last = s;
  }

  up(id: number, s: PointerSample): void {
    const a = this.active;
    if (!a || a.id !== id) return;
    this.active = null;
    if (a.dragging) {
      this.h.onDragEnd?.(this.drag(a.start, a.last, s));
    } else if (s.time - a.start.time <= this.tapMaxMs && Math.hypot(s.x - a.start.x, s.y - a.start.y) <= this.slop) {
      this.h.onTap?.({ ...s, pointerType: a.type, pointerId: a.id });
    }
  }

  /** Pointer cancelled (system gesture, palm rejection): no tap, but a running drag ends. */
  cancel(id: number): void {
    const a = this.active;
    if (!a || a.id !== id) return;
    this.active = null;
    if (a.dragging) this.h.onDragEnd?.(this.drag(a.start, a.last, a.last));
  }

  private drag(start: PointerSample, prev: PointerSample, s: PointerSample): DragEvent {
    return { ...s, startX: start.x, startY: start.y, dx: s.x - prev.x, dy: s.y - prev.y };
  }
}
