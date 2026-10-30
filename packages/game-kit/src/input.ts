import { GestureTracker, type GestureHandlers, type GestureOptions } from './gesture.ts';

export type { DragEvent, GestureHandlers, GestureOptions, PointerSample, PressEvent } from './gesture.ts';

export interface InputHandle {
  /** Ignore input while false (e.g. paused). Default true. */
  enabled: boolean;
  destroy(): void;
}

/**
 * Unified pointer/touch/mouse input on `target`: press (pointer-down), tap and drag, primary pointer only.
 *
 * - `touch-action: none` on the target, so there is no 300 ms click delay, no double-tap zoom and no scrolling.
 * - `touchstart` / `touchend` default actions are prevented (iOS magnifier, callout, synthetic mouse events).
 * - Events carry `event.timeStamp` (same clock as `performance.now()`), so games can rewind to the exact press
 *   time instead of the next frame's time — important when iOS Low Power Mode drops rAF to 30 Hz.
 * - Space / Enter count as a press + tap for desktop testing (`keyboard: false` to disable).
 */
export function createInput(
  target: HTMLElement,
  handlers: GestureHandlers,
  options: GestureOptions & { keyboard?: boolean } = {},
): InputHandle {
  const tracker = new GestureTracker(handlers, options);
  const handle: InputHandle = { enabled: true, destroy };
  target.style.touchAction = 'none';

  const local = (ev: PointerEvent) => {
    const r = target.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top, time: ev.timeStamp };
  };
  const onDown = (ev: PointerEvent) => {
    if (!handle.enabled || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    if (!tracker.down(ev.pointerId, ev.pointerType, local(ev))) return;
    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      /* not capturable (synthetic event) */
    }
    ev.preventDefault();
  };
  const onMove = (ev: PointerEvent) => {
    if (tracker.isDown) tracker.move(ev.pointerId, local(ev));
  };
  const onUp = (ev: PointerEvent) => {
    if (!tracker.isDown) return;
    tracker.up(ev.pointerId, local(ev));
    ev.preventDefault();
  };
  const onCancel = (ev: PointerEvent) => tracker.cancel(ev.pointerId);
  const preventTouch = (ev: TouchEvent) => {
    if (ev.cancelable) ev.preventDefault();
  };
  const onContextMenu = (ev: Event) => ev.preventDefault();
  const onKey = (ev: KeyboardEvent) => {
    if (!handle.enabled || ev.repeat || (ev.key !== ' ' && ev.key !== 'Enter')) return;
    const t = (ev.target as HTMLElement | null)?.tagName;
    if (t === 'BUTTON' || t === 'INPUT' || t === 'TEXTAREA') return;
    ev.preventDefault();
    const r = target.getBoundingClientRect();
    const s = { x: r.width / 2, y: r.height / 2, time: ev.timeStamp };
    if (tracker.down(-1, 'keyboard', s)) tracker.up(-1, s);
  };

  target.addEventListener('pointerdown', onDown);
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onCancel);
  target.addEventListener('lostpointercapture', onCancel);
  target.addEventListener('touchstart', preventTouch, { passive: false });
  target.addEventListener('touchend', preventTouch, { passive: false });
  target.addEventListener('contextmenu', onContextMenu);
  if (options.keyboard !== false) window.addEventListener('keydown', onKey);

  function destroy() {
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onCancel);
    target.removeEventListener('lostpointercapture', onCancel);
    target.removeEventListener('touchstart', preventTouch);
    target.removeEventListener('touchend', preventTouch);
    target.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKey);
  }
  return handle;
}
