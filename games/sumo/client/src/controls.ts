import { createDirectionKeys, createInput, type DirectionKeysHandle, type InputHandle } from '@rally/game-kit';
import { stickFromDrag, type Vec2 } from '@rally/game-sumo-server';

/** Finger travel (CSS px) for a full push: small enough for thumbs, big enough to steer gently. */
const STICK_RADIUS = 56;

export interface Controls {
  /** Current stick: the drag if a finger/mouse is down, else the keys. */
  readonly stick: Vec2;
  /** True once the player has used any control (hides the hint). */
  readonly used: boolean;
  enabled: boolean;
  destroy(): void;
}

/**
 * Virtual joystick anywhere on the canvas (touch or mouse: the stick is anchored where the finger went down and
 * follows the drag) plus arrow keys / WASD from @rally/game-kit for desktop and the dev harness.
 */
export function createControls(canvas: HTMLCanvasElement, stickEl: HTMLElement): Controls {
  let drag: Vec2 | null = null;
  let used = false;
  const knob = stickEl.firstElementChild as HTMLElement | null;

  const show = (x: number, y: number) => {
    stickEl.hidden = false;
    stickEl.style.transform = `translate(${x}px, ${y}px)`;
  };
  const moveKnob = (v: Vec2) => {
    if (knob) knob.style.transform = `translate(${v.x * STICK_RADIUS * 0.6}px, ${v.y * STICK_RADIUS * 0.6}px)`;
  };
  const release = () => {
    drag = null;
    stickEl.hidden = true;
    moveKnob({ x: 0, y: 0 });
  };

  const input: InputHandle = createInput(
    canvas,
    {
      onPress: (e) => {
        used = true;
        drag = { x: 0, y: 0 };
        const r = canvas.getBoundingClientRect();
        show(e.x + r.left, e.y + r.top);
      },
      onDrag: (e) => {
        drag = stickFromDrag(e.x - e.startX, e.y - e.startY, STICK_RADIUS);
        moveKnob(drag);
      },
      onDragEnd: release,
      onTap: release,
    },
    { keyboard: false, tapSlop: 4, tapMaxMs: 10_000 },
  );
  // A press that ends without a drag or tap (long hold, system cancel) must still release the stick.
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  const keys: DirectionKeysHandle = createDirectionKeys({
    onChange: () => {
      used = true;
    },
  });

  return {
    get stick() {
      return drag ?? keys.stick;
    },
    get used() {
      return used;
    },
    get enabled() {
      return input.enabled;
    },
    set enabled(on: boolean) {
      input.enabled = on;
      keys.enabled = on;
      if (!on) release();
    },
    destroy() {
      input.destroy();
      keys.destroy();
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    },
  };
}
