/** Held-direction keys → a stick vector, for desktop play and testing in the dev harness. */

export interface Stick {
  /** -1 (left) … 1 (right). */
  x: number;
  /** -1 (up) … 1 (down): screen axes. */
  y: number;
}

export interface DirectionKeysOptions {
  /** Where to listen. Default `window`. */
  target?: Window | HTMLElement;
  /** Called whenever the vector changes (key down/up, blur). */
  onChange?: (stick: Stick) => void;
  /** Also map WASD (by physical key position, so AZERTY's ZQSD works too). Default true. */
  wasd?: boolean;
}

export interface DirectionKeysHandle {
  /** Current vector; zero when nothing is held. Diagonals are normalized to length 1. */
  readonly stick: Stick;
  /** Ignore keys while false (paused); disabling releases everything. Default true. */
  enabled: boolean;
  destroy(): void;
}

type Dir = 'left' | 'right' | 'up' | 'down';

const ARROWS: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const WASD: Record<string, Dir> = { KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down' };

/** Pure: the stick for a set of held directions. */
export function stickFromDirections(held: ReadonlySet<Dir>): Stick {
  const x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
  const y = (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0);
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  const len = Math.hypot(x, y);
  return { x: x / len, y: y / len };
}

/**
 * Arrow keys (and WASD) as an analog-style stick. Keys are tracked by `KeyboardEvent.code`, so a key released
 * while another is held still clears correctly; everything is released on window blur (alt-tab would otherwise
 * leave a key "stuck"). Typing in inputs/textareas is ignored.
 */
export function createDirectionKeys(options: DirectionKeysOptions = {}): DirectionKeysHandle {
  const target = options.target ?? window;
  const map: Record<string, Dir> = { ...ARROWS, ...(options.wasd === false ? {} : WASD) };
  const pressed = new Map<string, Dir>();
  let stick: Stick = { x: 0, y: 0 };
  let enabled = true;

  const update = () => {
    const next = stickFromDirections(new Set(pressed.values()));
    if (next.x === stick.x && next.y === stick.y) return;
    stick = next;
    options.onChange?.(stick);
  };
  const typing = (ev: Event) => {
    const t = (ev.target as HTMLElement | null)?.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  };
  const onDown = (ev: Event) => {
    const e = ev as KeyboardEvent;
    const dir = map[e.code] ?? ARROWS[e.key];
    if (!enabled || !dir || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    pressed.set(e.code || e.key, dir);
    update();
  };
  const onUp = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (pressed.delete(e.code || e.key)) update();
  };
  const releaseAll = () => {
    if (pressed.size === 0) return;
    pressed.clear();
    update();
  };

  target.addEventListener('keydown', onDown);
  target.addEventListener('keyup', onUp);
  window.addEventListener('blur', releaseAll);

  return {
    get stick() {
      return stick;
    },
    get enabled() {
      return enabled;
    },
    set enabled(on: boolean) {
      enabled = on;
      if (!on) releaseAll();
    },
    destroy() {
      target.removeEventListener('keydown', onDown);
      target.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', releaseAll);
      pressed.clear();
    },
  };
}
