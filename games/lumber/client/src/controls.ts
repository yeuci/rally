import { createDirectionKeys, createInput, type DirectionKeysHandle, type InputHandle } from '@rally/game-kit';
import { clampStick, type Vec2 } from './sim.ts';

/** Finger travel (CSS px) for full speed: small enough for thumbs, big enough to walk slowly. */
const STICK_RADIUS = 52;

/** Screen drag (CSS px) → stick (x right, z down the screen), clamped to the unit circle. */
export function stickFromDrag(dx: number, dy: number, radius = STICK_RADIUS): Vec2 {
  return clampStick(dx / radius, dy / radius) ?? { x: 0, z: 0 };
}

export interface Controls {
  /** Current stick: the drag if a finger/mouse is down, else the keys. */
  readonly stick: Vec2;
  /** True once the player has used any control. */
  readonly used: boolean;
  enabled: boolean;
  /** Drop the current drag (pause, focus loss). Keys release themselves on blur. */
  release(): void;
  destroy(): void;
}

/**
 * Floating joystick anywhere on the canvas (anchored where the finger went down, follows the drag) plus arrow keys /
 * WASD from @rally/game-kit for desktop and the dev harness. Same shape as Sumo's controls.
 */
export function createControls(canvas: HTMLCanvasElement, stickEl: HTMLElement): Controls {
  let drag: Vec2 | null = null;
  /** pointerId of the finger/mouse driving the stick; other pointers never end its drag. */
  let activeId: number | null = null;
  let used = false;
  const knob = stickEl.firstElementChild as HTMLElement | null;

  const moveKnob = (v: Vec2) => {
    if (knob) knob.style.transform = `translate(${v.x * STICK_RADIUS * 0.6}px, ${v.z * STICK_RADIUS * 0.6}px)`;
  };
  const release = () => {
    drag = null;
    activeId = null;
    stickEl.hidden = true;
    moveKnob({ x: 0, z: 0 });
  };

  const input: InputHandle = createInput(
    canvas,
    {
      onPress: (e) => {
        used = true;
        activeId = e.pointerId;
        drag = { x: 0, z: 0 };
        const r = canvas.getBoundingClientRect();
        stickEl.hidden = false;
        stickEl.style.transform = `translate(${e.x + r.left}px, ${e.y + r.top}px)`;
      },
      onDrag: (e) => {
        drag = stickFromDrag(e.x - e.startX, e.y - e.startY);
        moveKnob(drag);
      },
      onDragEnd: release,
      onTap: release,
    },
    { keyboard: false, tapSlop: 4, tapMaxMs: 10_000 },
  );
  // A press that ends without a drag or tap (long hold, system cancel) must still release the stick, but only for
  // that pointer: a second finger lifting elsewhere must not end the joystick drag.
  const onWindowUp = (ev: PointerEvent) => {
    if (ev.pointerId === activeId) release();
  };
  window.addEventListener('pointerup', onWindowUp);
  window.addEventListener('pointercancel', onWindowUp);
  const keys: DirectionKeysHandle = createDirectionKeys({
    onChange: () => {
      used = true;
    },
  });

  return {
    get stick() {
      return drag ?? { x: keys.stick.x, z: keys.stick.y };
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
    release,
    destroy() {
      input.destroy();
      keys.destroy();
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('pointercancel', onWindowUp);
    },
  };
}
