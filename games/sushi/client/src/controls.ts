import { createDirectionKeys, createTwinStick, type DirectionKeysHandle, type TwinStickHandle } from '@rally/game-kit';
import type { Vec2 } from '@rally/game-sushi-server';

/** Finger travel (CSS px) for a full move: small enough for thumbs. */
export const STICK_RADIUS = 52;

export interface Controls {
  /** Move stick (screen axes: x right, y down = toward the camera; |v| ≤ 1): a thumb anywhere on the game, or keys. */
  readonly move: Vec2;
  /** The context button is down (the big button, Space, E or Enter). */
  readonly button: boolean;
  /** Presses so far: the server tells a tap from a hold, and a quick tap between two sends still arrives. */
  readonly presses: number;
  /** True once the player used any control (hides the hint). */
  readonly used: boolean;
  enabled: boolean;
  /**
   * The host's shared touch settings: `swap` puts the button on the left (and the thumb stick, which follows the thumb
   * anywhere, naturally on the right); `size` scales the stick's travel and ring, `opacity` fades the ring.
   */
  setLayout(o: { swap: boolean; size: number; opacity: number }): void;
  /** Drop every held control (blur, pause, the host's menu). */
  release(): void;
  /** Position the on-screen stick (once per frame). */
  draw(): void;
  destroy(): void;
}

/**
 * One joystick and one button. The joystick is game-kit's twin-stick tracker with the whole canvas as its move side
 * (anchored where the thumb lands, each finger tracked by pointer id); the button is its own element with its own
 * finger, so pressing it never disturbs the stick. On a keyboard: WASD / arrows and Space / E / Enter.
 */
export function createControls(canvas: HTMLCanvasElement, stickEl: HTMLElement, buttonEl: HTMLElement): Controls {
  let used = false;
  let presses = 0;
  let finger: number | null = null;
  let keyDown = false;
  let size = 1;
  const twin: TwinStickHandle = createTwinStick(canvas, {
    radius: STICK_RADIUS,
    split: 1,
    mouse: true,
    onChange: () => {
      used = true;
    },
  });
  const keys: DirectionKeysHandle = createDirectionKeys({
    onChange: () => {
      used = true;
    },
  });

  const press = () => {
    presses++;
    used = true;
    buttonEl.classList.add('down');
  };
  const onDown = (ev: PointerEvent) => {
    if (!twin.enabled || finger !== null) return;
    finger = ev.pointerId;
    press();
    try {
      buttonEl.setPointerCapture(ev.pointerId);
    } catch {
      /* synthetic */
    }
    ev.preventDefault();
    ev.stopPropagation();
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== finger) return;
    finger = null;
    if (!keyDown) buttonEl.classList.remove('down');
  };
  const isAction = (code: string) => code === 'Space' || code === 'KeyE' || code === 'Enter' || code === 'KeyJ';
  const typing = (ev: KeyboardEvent) => {
    const t = (ev.target as HTMLElement | null)?.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    if (!twin.enabled || typing(ev) || ev.metaKey || ev.ctrlKey || ev.altKey || !isAction(ev.code)) return;
    ev.preventDefault();
    if (ev.repeat || keyDown) return;
    keyDown = true;
    press();
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (!isAction(ev.code)) return;
    keyDown = false;
    if (finger === null) buttonEl.classList.remove('down');
  };
  const onContext = (ev: Event) => ev.preventDefault();
  buttonEl.addEventListener('pointerdown', onDown);
  buttonEl.addEventListener('contextmenu', onContext);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  function release() {
    twin.release();
    finger = null;
    keyDown = false;
    buttonEl.classList.remove('down');
  }

  return {
    get move() {
      const f = twin.tracker.moveFinger;
      if (!f) return keys.stick;
      // The stick's travel scales with the host's stick size (the tracker's own radius is fixed).
      const r = STICK_RADIUS * size;
      const x = (f.x - f.originX) / r;
      const y = (f.y - f.originY) / r;
      const len = Math.hypot(x, y);
      if (len < 0.08) return { x: 0, y: 0 };
      return len > 1 ? { x: x / len, y: y / len } : { x, y };
    },
    get button() {
      return finger !== null || keyDown;
    },
    get presses() {
      return presses;
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
    setLayout(o) {
      size = Math.max(0.75, Math.min(1.5, o.size));
      document.body.classList.toggle('swapped', o.swap);
      stickEl.style.setProperty('--stick-scale', String(size));
      stickEl.style.opacity = String(Math.max(0.2, Math.min(1, o.opacity)));
    },
    release,
    draw() {
      const f = twin.tracker.moveFinger;
      if (!f) {
        stickEl.hidden = true;
        return;
      }
      const r = canvas.getBoundingClientRect();
      stickEl.hidden = false;
      stickEl.style.transform = `translate(${f.originX + r.left}px, ${f.originY + r.top}px) scale(${size})`;
      let dx = (f.x - f.originX) / size;
      let dy = (f.y - f.originY) / size;
      const len = Math.hypot(dx, dy);
      const clamp = STICK_RADIUS * 0.7;
      if (len > clamp) [dx, dy] = [(dx / len) * clamp, (dy / len) * clamp];
      const k = stickEl.firstElementChild as HTMLElement | null;
      if (k) k.style.transform = `translate(${dx}px, ${dy}px)`;
    },
    destroy() {
      twin.destroy();
      keys.destroy();
      buttonEl.removeEventListener('pointerdown', onDown);
      buttonEl.removeEventListener('contextmenu', onContext);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
  };
}
