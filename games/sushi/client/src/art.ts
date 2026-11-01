import type { Room } from '@colyseus/sdk';
import type { Application } from 'playcanvas';
import {
  BotCrew,
  CUSTOMER_STATES,
  DT,
  Kind,
  SEATS,
  SushiGame,
  itemCode,
  matMask,
  type ChefView,
  type CustomerView,
  type MapLike,
  type ResultMessage,
  type SushiStateView,
} from '@rally/game-sushi-server';
import type { Hud } from './hud.ts';
import type { Net } from './net.ts';
import type { SushiScene } from './scene.ts';

/**
 * Dev-only `?art=<shot>` mode: stages one deterministic scene with the game's own renderer, HUD and frame loop for the
 * store art games/sushi/scripts/art.ts captures. main.ts imports this module only behind `import.meta.env.DEV`.
 *
 * Every scene is the real rules (`SushiGame`, the code the server runs) with a fixed seed and a crew of helper bots
 * playing for a while, then frozen:
 * - `icon`: close on the bar: the panda at the pass, plates of every colour riding the belt, no HUD.
 * - `cover`: the restaurant on a busy Friday, four chefs, the dining room open, no HUD.
 * - `bar`: Tuesday's lunch rush at the bar (phone landscape, HUD, order bubbles).
 * - `festival`: Sunday: the dining room, the alley's truck and the festival terrace all open (HUD).
 * - `night`: the night's summary and the upgrade vote (HUD).
 */
export const ART_SHOTS = ['icon', 'cover', 'bar', 'festival', 'night'] as const;
export type ArtShot = (typeof ART_SHOTS)[number];
export const isArtShot = (s: string | null): s is ArtShot => ART_SHOTS.includes(s as ArtShot);

const NAMES = ['Mika', 'jun', 'Sora', 'Ren'];
const RTT_MS = 36;

function mapOf<V>(entries: [string, V][]): MapLike<V> & Map<string, V> {
  return new Map(entries);
}

/** The synced state as the client reads it, from a game (the room's `sync`, as plain objects). */
export function snapshot(g: SushiGame, over: Partial<SushiStateView> = {}): SushiStateView {
  const players = mapOf<ChefView>(
    g.chefList.map((c) => [
      c.id,
      {
        name: c.name,
        slot: c.slot,
        x: c.x,
        y: c.y,
        vx: c.vx,
        vy: c.vy,
        face: c.face,
        held: itemCode(c.held),
        act: c.act,
        connected: true,
        guest: false,
        uid: '',
        bot: false,
        vote: c.vote,
        ack: 0,
      },
    ]),
  );
  const customers = mapOf<CustomerView>(
    [...g.customers.values()].map((c) => [
      c.id.toString(36),
      {
        look: c.look,
        vip: c.vip,
        seat: c.seat,
        state: CUSTOMER_STATES.indexOf(c.state),
        x: c.x,
        y: c.y,
        o0: c.orders[0] ?? 0,
        o1: c.orders[1] ?? 0,
        o2: c.orders[2] ?? 0,
        course: c.course,
        patience: Math.round(Math.max(0, Math.min(1, c.patience / c.patienceMax)) * 100),
        waving: c.waving,
      },
    ]),
  );
  return {
    phase: g.phase,
    timer: g.timer,
    run: g.run,
    day: g.day,
    clock: g.dayFraction,
    stars: g.stars,
    money: g.money,
    earned: g.dayStats.earned,
    tips: g.dayStats.tips,
    served: g.dayStats.served,
    angry: g.dayStats.angry,
    zones: g.zones,
    owned: [...g.owned.keys()].join(','),
    today: [...g.todayCards].join(','),
    cards: g.cards.join(','),
    chosen: g.chosen,
    dishes: g.dishes,
    helper: g.helper,
    crew: g.crew,
    beltS: g.beltS,
    beltSpeed: 0,
    summary: g.lastSummary ? JSON.stringify(g.lastSummary) : '',
    code: '',
    isPrivate: false,
    maxPlayers: 4,
    tick: g.tick,
    players,
    customers,
    stations: g.stations.map((s) => ({
      item: itemCode(s.item),
      mat: matMask(s.mat),
      state: s.state,
      count: s.count,
      progress: Math.round(Math.min(1, s.progress) * 100),
    })),
    slots: g.slots.map((s) => ({
      item: itemCode(s.item),
      stale: s.stale,
      age: s.item ? Math.round(Math.min(1, s.age / g.today.staleTime) * 100) : 0,
    })),
    seats: g.seats.map((s) => ({ dirty: s.dirty, eating: s.eating })),
    ...over,
  };
}

/** A game on `day` with `crew` bots playing for `seconds`. */
function played(seed: number, day: number, crew: number, seconds: number, rules = {}) {
  const g = new SushiGame({ seed, rules: { morningTime: 1, ...rules } });
  for (let i = 0; i < crew; i++) g.addPlayer(`p${i}`, NAMES[i]!, true);
  const bots = new BotCrew(g);
  g.skipToDay(day);
  for (let t = 0; t < seconds; t += DT) {
    bots.think(DT);
    g.step(DT);
  }
  // Bots, but drawn as the crew (no BOT tags on the art).
  return g;
}

export interface ArtPose {
  state: SushiStateView;
  me: string;
  clean: boolean;
  /** A box to frame instead of the open zones (sim units). */
  frame?: { x0: number; y0: number; x1: number; y1: number };
  result: ResultMessage | null;
}

export function artPose(shot: ArtShot): ArtPose {
  switch (shot) {
    case 'icon': {
      const g = played(3, 5, 2, 30, { arrivals: 1.4 });
      // Plates of every colour on the kitchen side of the belt.
      const kinds = [Kind.SalmonNigiri, Kind.SalmonRoll, Kind.SeaUrchinRoll, Kind.MaguroNigiri, Kind.California];
      kinds.forEach((k, i) => g.putOnBelt(i, k));
      g.beltS = 0.6;
      const panda = g.chefList[0]!;
      Object.assign(panda, {
        x: -0.7,
        y: -1.75,
        face: Math.PI / 2,
        held: { kind: Kind.UnagiNigiri, plated: true, n: 1 },
      });
      return {
        state: snapshot(g),
        me: 'p0',
        clean: true,
        frame: { x0: -3.2, y0: -3.0, x1: 1.8, y1: 0.0 },
        result: null,
      };
    }
    case 'cover': {
      const g = played(11, 5, 4, 70, { arrivals: 1.5 });
      return { state: snapshot(g), me: 'p0', clean: true, result: null };
    }
    case 'bar': {
      const g = played(7, 2, 2, 58, { arrivals: 1.6 });
      return { state: snapshot(g), me: 'p0', clean: false, result: null };
    }
    case 'festival': {
      const g = played(5, 7, 4, 62, { arrivals: 1.2 });
      return { state: snapshot(g), me: 'p0', clean: false, result: null };
    }
    case 'night': {
      const g = played(9, 3, 3, 400, { voteTime: 999 });
      // Mid-vote: two chefs have picked.
      const chefs = g.chefList;
      if (chefs[1]) chefs[1].vote = 1;
      if (chefs[2]) chefs[2].vote = 0;
      return {
        state: snapshot(g, { timer: 11.6 }),
        me: 'p0',
        clean: false,
        result: {
          matchId: 'art:1:3',
          recorded: true,
          boards: { days: { score: 3, rank: 12 }, tips: { score: 1840, rank: 7 } },
          unlocked: [{ key: 'five_star_day', title: 'Five-Star Day', icon: '⭐' }],
        },
      };
    }
  }
}

export interface ArtProbe {
  shot: ArtShot;
  ready: boolean;
}

const CLEAN_CSS = '#hud, #labels, .stick { display: none !important; }';

/**
 * A `Net` look-alike that serves the frozen pose to main.ts' normal frame loop, then freezes time and stops drawing.
 * Sets `window.__sushiArt` for the capture script.
 */
export function stageArt(shot: ArtShot, deps: { app: Application; scene: SushiScene; hud: Hud }): Net {
  const { app, scene, hud } = deps;
  const pose = artPose(shot);
  if (pose.clean) {
    const style = document.createElement('style');
    style.textContent = CLEAN_CSS;
    document.head.appendChild(style);
  }
  hud.hideHint();
  document.getElementById('teach')!.hidden = true;
  const patchHandlers: ((t: number) => void)[] = [];
  const patch = () => patchHandlers.forEach((fn) => fn(performance.now()));
  setInterval(patch, 50);
  const probe: ArtProbe = { shot, ready: false };
  (window as unknown as { __sushiArt: ArtProbe }).__sushiArt = probe;
  const frames = (n: number) =>
    new Promise<void>((resolve) => {
      let left = n;
      const tick = () => (--left <= 0 ? resolve() : app.once('frameend', tick));
      app.once('frameend', tick);
    });
  void (async () => {
    await frames(4);
    if (pose.frame) scene.frameBox(pose.frame);
    await frames(40);
    app.timeScale = 0;
    await frames(6);
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
  void SEATS;
  return {
    room,
    state: pose.state,
    sessionId: pose.me,
    rttMs: RTT_MS,
    offer: () => null,
    release: () => null,
    onFx() {},
    onPatch(fn) {
      patchHandlers.push(fn);
      fn(performance.now());
    },
    onResult(fn: (r: ResultMessage) => void) {
      if (pose.result) setTimeout(() => fn(pose.result!), 100);
    },
    vote() {},
    start() {},
    dev() {},
    leave: async () => {},
  };
}
