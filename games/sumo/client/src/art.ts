import type { Room } from '@colyseus/sdk';
import type { Application, Entity, Vec3 } from 'playcanvas';
import {
  DT,
  PUCK_RADIUS,
  SumoMatch,
  clampStick,
  type MatchPlayer,
  type ResultMessage,
  type SumoPlayerView,
  type SumoStateView,
} from '@rally/game-sumo-server';
import type { Hud } from './hud.ts';
import type { Net } from './net.ts';
import type { SumoScene } from './scene.ts';

/**
 * Dev-only `?art=<shot>` mode (docs/m3-phase2.md §7): stages one deterministic scene with the game's own renderer,
 * HUD and frame loop, for the store art that games/sumo/scripts/art.ts captures. main.ts imports this module only
 * behind `import.meta.env.DEV`, so it is never part of a published build.
 *
 * - `icon`, `cover`: hand-posed pucks mid-collision on the platform (on the cover one tumbles off the edge),
 *   time frozen, no HUD or name labels.
 * - `countdown`, `match`, `result`: a real match of the shared rules (`SumoMatch`, the code the server runs) between
 *   six scripted players, frozen at the last round's 3-2-1, at a hard hit early in round 3, and on the match-over
 *   screen. "You" are the match winner, signed in (the result line is a recorded one).
 */
export const ART_SHOTS = ['icon', 'cover', 'countdown', 'match', 'result'] as const;
export type ArtShot = (typeof ART_SHOTS)[number];

export const isArtShot = (s: string | null): s is ArtShot => ART_SHOTS.includes(s as ArtShot);

const NAMES = ['mika', 'kenta', 'yuki', 'sora', 'haru', 'rin'];
const RTT_MS = 38;

/** A frozen copy of the synced state, as the client reads it from Colyseus. */
export interface ArtPose {
  state: SumoStateView;
  me: string;
  /** Puck ids caught mid-fall: drawn tumbling off the edge. */
  falling: { id: string; vx: number; vy: number }[];
  result: ResultMessage | null;
}

function view(m: SumoMatch, still: boolean): SumoStateView {
  const players = new Map<string, SumoPlayerView>();
  for (const p of m.players.values()) {
    players.set(p.id, {
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      // Frozen: the client's own-puck prediction would otherwise replay the velocity every frame.
      vx: still ? 0 : p.vx,
      vy: still ? 0 : p.vy,
      alive: p.alive,
      score: p.score,
      connected: p.connected,
      guest: false,
      inRound: p.inRound,
      ack: 0,
    });
  }
  return {
    phase: m.phase,
    timer: m.timer,
    round: m.round,
    matchTime: m.matchTime,
    radius: m.radius,
    roundWinner: m.roundWinner ?? '',
    matchWinner: m.matchWinner ?? '',
    code: '',
    isPrivate: false,
    maxPlayers: 8,
    tick: m.tick,
    players,
  };
}

/** Who wins each round: one scripted player per round pushes at full strength, the rest at half. */
const ROUND_CHAMPIONS = [2, 0, 2, 2];
const WEAK = 0.5;

/**
 * Scripted players: each picks the nearest opponent, circles round to its centre side and shoves it outwards,
 * backing off the edge. The round's champion is twice as strong, so the match plays out the same way (yuki 3,
 * mika 1, under the 90 s limit) even if another JS engine rounds the physics slightly differently.
 */
function steer(m: SumoMatch) {
  const alive = [...m.players.values()].filter((p) => p.alive && p.inRound);
  const champion = ROUND_CHAMPIONS[(m.round - 1) % ROUND_CHAMPIONS.length];
  for (const p of alive) {
    let target: MatchPlayer | null = null;
    let best = Infinity;
    for (const q of alive) {
      const d = q === p ? Infinity : Math.hypot(q.x - p.x, q.y - p.y);
      if (d < best) [best, target] = [d, q];
    }
    let sx = 0;
    let sy = 0;
    if (target) {
      const tr = Math.hypot(target.x, target.y) || 1;
      const ax = target.x - (target.x / tr) * 2.2;
      const ay = target.y - (target.y / tr) * 2.2;
      const ad = Math.hypot(ax - p.x, ay - p.y);
      if (ad > 1.2 && best > 2.3) [sx, sy] = [(ax - p.x) / ad, (ay - p.y) / ad];
      else [sx, sy] = [(target.x - p.x) / best, (target.y - p.y) / best];
    }
    const strong = p.order === champion;
    const r = Math.hypot(p.x, p.y);
    const k = Math.max(0, (r - (m.radius - 2)) / 2) * (strong ? 1.2 : 0.8);
    if (r > 0) [sx, sy] = [sx - (p.x / r) * k, sy - (p.y / r) * k];
    const s = clampStick(sx * 3, sy * 3) ?? { x: 0, y: 0 };
    const g = strong ? 1 : WEAK;
    m.setInput(p.id, { x: s.x * g, y: s.y * g });
  }
}

/**
 * Plays the first match to its end and returns the three screenshot poses. Pure and deterministic, so the
 * screenshots only change when the rules or the scripted players do.
 */
export function playArtMatch(): Record<'countdown' | 'match' | 'result', ArtPose> {
  const m = new SumoMatch();
  NAMES.forEach((name, i) => m.addPlayer(`p${i}`, name));
  const states: Partial<Record<'match' | 'result', SumoStateView>> = {};
  const countdowns: SumoStateView[] = [];
  let countdownRound = 0;
  let winner = '';
  let kos = 0;
  for (let tick = 0; tick < 30 * 600 && !states.result; tick++) {
    steer(m);
    const events = m.step(DT);
    // The "3" of every countdown after the first (scores on the board); the last one is used.
    if (m.phase === 'countdown' && m.round >= 2 && m.timer <= 2.85 && countdownRound !== m.round) {
      countdownRound = m.round;
      countdowns.push(view(m, true));
    }
    // Round 3 (one win each for yuki and mika): the first hard hit with at least five pucks still on.
    if (!states.match && m.phase === 'playing' && m.round === 3 && m.roundTime >= 1.5) {
      const hit = events.some((e) => e.type === 'hit' && e.impulse >= 6);
      if (hit && m.participants().filter((p) => p.alive).length >= 5) states.match = view(m, true);
    }
    for (const e of events) {
      if (e.type === 'matchOver') {
        winner = e.summary.winner ?? '';
        kos = e.summary.standings.find((s) => s.id === winner)?.kos ?? 0;
      }
    }
    if (m.phase === 'matchOver' && m.timer <= 4) states.result = view(m, true);
  }
  const countdown = countdowns[countdowns.length - 1];
  if (!states.match || !states.result || !countdown || !winner) throw new Error('art match never reached its poses');
  // The winner's line on a signed-in account (the server's `result` message; numbers are made up).
  const result: ResultMessage = {
    matchId: 'art:1',
    recorded: true,
    wins: 14,
    losses: 23,
    rank: 3,
    boards: { wins: { score: 14, rank: 3 } },
    unlocked: kos >= 3 ? [{ key: 'ring_out', title: 'Ring Out', icon: '💥' }] : [],
  };
  const pose = (state: SumoStateView, r: ResultMessage | null = null): ArtPose => ({
    state,
    me: winner,
    falling: [],
    result: r,
  });
  return { countdown: pose(countdown), match: pose(states.match), result: pose(states.result, result) };
}

/** Hand-posed key art: [palette colour, x, y] per puck (sim units: x right, y towards the camera). */
function posed(radius: number, pucks: [number, number, number][], extra: Omit<ArtPose, 'state' | 'me'>): ArtPose {
  const m = new SumoMatch();
  pucks.forEach(([color, x, y], i) => {
    const p = m.addPlayer(`p${color}`, NAMES[i % NAMES.length]!);
    Object.assign(p, { color, x, y, vx: 0, vy: 0, alive: true, inRound: true });
  });
  const state = view(m, true);
  return { ...extra, state: { ...state, phase: 'playing', round: 2, radius }, me: '' };
}

export function artPose(shot: ArtShot): ArtPose {
  switch (shot) {
    case 'icon':
      // Red and blue collide in the middle of a shrunken ring; yellow and green close in.
      return posed(
        4.3,
        [
          [0, -1.02, 0.35],
          [1, 0.98, 0.05],
          [2, -0.55, -2.35],
          [3, 2.15, 1.85],
        ],
        { falling: [], result: null },
      );
    case 'cover':
      return posed(
        7.4,
        [
          [0, -1.0, 0.45],
          [1, 1.0, 0.1],
          [4, -3.7, -2.7],
          [2, 3.3, -3.2],
          [6, 3.9, 3.1],
          [5, -5.2, 5.35],
        ],
        // Orange tumbles off the front-left edge (the way the fall animation tips a puck).
        { falling: [{ id: 'p5', vx: -2, vy: 2 }], result: null },
      );
    default:
      return playArtMatch()[shot];
  }
}

// --- staging in the page ---------------------------------------------------------------------------------

export interface ArtProbe {
  shot: ArtShot;
  /** True once the pose is on screen and time is frozen. */
  ready: boolean;
  /** Screen box (CSS px) of the platform and everything on it. */
  bounds(): { x: number; y: number; w: number; h: number };
}

const CLEAN_CSS = '#hud, #labels, #stick { display: none !important; }';

/**
 * Builds a `Net` look-alike that serves the frozen pose to main.ts' normal frame loop (interpolation, prediction,
 * labels, HUD, result line), then freezes time and poses the effects. Sets `window.__sumoArt` for the capture script.
 */
export function stageArt(shot: ArtShot, deps: { app: Application; scene: SumoScene; hud: Hud }): Net {
  const { app, scene, hud } = deps;
  const pose = artPose(shot);
  const state = pose.state;
  const clean = shot === 'icon' || shot === 'cover';
  if (clean) {
    const style = document.createElement('style');
    style.textContent = CLEAN_CSS;
    document.head.appendChild(style);
  }
  hud.hideHint();

  const patchHandlers: ((t: number) => void)[] = [];
  const resultHandlers: ((r: ResultMessage) => void)[] = [];
  const patch = () => patchHandlers.forEach((fn) => fn(performance.now()));
  setInterval(patch, 50);

  const probe: ArtProbe = {
    shot,
    ready: false,
    bounds() {
      const camera = app.root.findByName('camera') as Entity;
      const pts: [number, number, number][] = [];
      for (let a = 0; a < 96; a++) {
        const c = Math.cos((a / 96) * Math.PI * 2);
        const s = Math.sin((a / 96) * Math.PI * 2);
        const r = state.radius + 0.25;
        pts.push([c * r, 0, s * r], [c * r, -0.95, s * r]);
      }
      for (const e of app.root.children) {
        const puck = e as Entity;
        if (!puck.name.startsWith('puck-') || !puck.enabled) continue;
        const p = puck.getPosition();
        for (let a = 0; a < 16; a++) {
          const c = Math.cos((a / 16) * Math.PI * 2) * PUCK_RADIUS;
          const s = Math.sin((a / 16) * Math.PI * 2) * PUCK_RADIUS;
          pts.push([p.x + c, p.y, p.z + s], [p.x + c, p.y + 0.85, p.z + s]);
        }
      }
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      const v: Vec3 = camera.getPosition().clone();
      for (const [x, y, z] of pts) {
        const s = camera.camera!.worldToScreen(v.set(x, y, z));
        [x0, y0, x1, y1] = [Math.min(x0, s.x), Math.min(y0, s.y), Math.max(x1, s.x), Math.max(y1, s.y)];
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    },
  };
  (window as unknown as { __sumoArt: ArtProbe }).__sumoArt = probe;

  const frames = (n: number) =>
    new Promise<void>((resolve) => {
      let left = n;
      const tick = () => (--left <= 0 ? resolve() : app.once('frameend', tick));
      app.once('frameend', tick);
    });

  void (async () => {
    // A few frames with every puck standing, so the frame loop creates them all; then stop the clock.
    await frames(6);
    app.timeScale = 0;
    for (const f of pose.falling) {
      const p = state.players.get(f.id);
      if (p) Object.assign(p, { alive: false, vx: f.vx, vy: f.vy });
    }
    // The frame loop sees alive → false and starts the fall; advance just that animation by hand.
    await frames(2);
    // 0.12 s into the fall: tipping over the rim. (Hit flashes are left out: frozen, they read as a white disc.)
    if (pose.falling.length) scene.update(0.12);
    if (pose.result) resultHandlers.forEach((fn) => fn(pose.result!));
    await frames(10);
    // Stop drawing: the scene is still, and a software-rendered 3× frame per tick would stall the screenshots.
    app.autoRender = false;
    probe.ready = true;
  })();

  const room = {
    roomId: `art-${shot}`,
    reconnectionToken: '',
    send() {},
    onDrop() {},
    onReconnect() {},
    onLeave() {},
  } as unknown as Room;

  return {
    room,
    state,
    sessionId: pose.me,
    rttMs: RTT_MS,
    offerStick: () => null,
    releaseStick: () => null,
    onFx() {},
    onPatch(fn) {
      patchHandlers.push(fn);
      fn(performance.now());
    },
    onResult(fn) {
      resultHandlers.push(fn);
    },
    leave: async () => {},
  };
}
