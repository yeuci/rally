import {
  type Application,
  BLEND_NORMAL,
  Color,
  Entity,
  GAMMA_SRGB,
  type GraphicsDevice,
  MeshInstance,
  Quat,
  SHADOW_PCF5_16F,
  StandardMaterial,
  TONEMAP_NEUTRAL,
  Vec3,
} from 'playcanvas';
import { roundedBox } from './meshes.ts';
import { MODELS, type Models } from './models.ts';
import { type PersonState, makePerson, oneShot, play, resetPerson } from './people.ts';
import { PEDESTAL_DEPTH, PEDESTAL_HALF, PIECES, type PieceKind, type SimEvent, type ToppleSim } from './sim.ts';

const hex = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return new Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** One colour per seat. */
export const SEAT_COLORS = ['#ff6b5b', '#4aa3ff', '#ffc23d', '#3fd08f', '#a07cf0', '#ff7fc4'] as const;

const PALETTE = {
  sky: '#bfe6f2',
  grass: '#8fd06b',
  grassDark: '#78bd57',
  stone: '#ece4d6',
  stoneDark: '#d6cbb7',
  trim: '#c7b89d',
  logEnd: '#f3dcb0',
  guide: '#ffffff',
  leaves: '#5cb85c',
  leaves2: '#79c96a',
  trunk: '#7a5133',
  out: '#9a9a9a',
  skins: ['#f1c7a1', '#8d5524', '#ffdbac', '#e0ac69', '#c68642', '#d9a273'],
} as const;

/** The players stand in a ring this far from the tower's axis, round the pedestal's base. */
const RING = 3.05;
/** The camera's starting yaw: seats are laid out from it, so seat 0 starts in view. */
const START_YAW = 0.6;

/** Visual corner radius of piece boxes (the colliders use a slightly smaller one). */
const ROUND = 0.05;

let device: GraphicsDevice;
const materials = new Map<string, StandardMaterial>();

function mat(color: string, opacity = 1): StandardMaterial {
  const key = `${color}/${opacity}`;
  let m = materials.get(key);
  if (!m) {
    m = new StandardMaterial();
    m.diffuse = hex(color);
    m.specular = new Color(0.08, 0.08, 0.08);
    m.gloss = 0.35;
    m.useMetalness = false;
    if (opacity < 1) {
      m.opacity = opacity;
      m.blendType = BLEND_NORMAL;
      m.depthWrite = false;
    }
    m.update();
    materials.set(key, m);
  }
  return m;
}

function box(
  parent: Entity,
  color: string,
  pos: [number, number, number],
  size: [number, number, number],
  r = ROUND,
  opacity = 1,
  shadows = true,
) {
  const e = new Entity('box');
  e.addComponent('render', { castShadows: shadows, receiveShadows: true });
  e.render!.meshInstances = [new MeshInstance(roundedBox(device, size[0], size[1], size[2], r), mat(color, opacity))];
  e.render!.castShadows = shadows;
  e.setLocalPosition(...pos);
  parent.addChild(e);
  return e;
}

function prim(
  parent: Entity,
  type: 'cylinder' | 'cone' | 'sphere',
  color: string,
  pos: [number, number, number],
  scale: [number, number, number],
  opts: { rot?: [number, number, number]; opacity?: number; shadows?: boolean } = {},
) {
  const e = new Entity(type);
  e.addComponent('render', {
    type,
    material: mat(color, opts.opacity),
    castShadows: opts.shadows ?? true,
    receiveShadows: true,
  });
  e.setLocalPosition(...pos);
  e.setLocalScale(...scale);
  if (opts.rot) e.setLocalEulerAngles(...opts.rot);
  parent.addChild(e);
  return e;
}

/** A piece's look: its parts as rounded boxes / a log with light end grain, in the owner's colour. */
function makePiece(parent: Entity, kind: PieceKind, color: string, opacity = 1): Entity {
  const root = new Entity(`piece-${kind}`);
  parent.addChild(root);
  const shadows = opacity === 1;
  for (const p of PIECES[kind].parts) {
    if (p.shape === 'box') {
      box(root, color, [p.x, p.y, p.z], [p.hx * 2, p.hy * 2, p.hz * 2], ROUND, opacity, shadows);
    } else {
      prim(root, 'cylinder', color, [p.x, p.y, p.z], [p.r * 2, p.hl * 2, p.r * 2], {
        rot: [0, 0, 90],
        opacity,
        shadows,
      });
      for (const end of [-1, 1]) {
        prim(root, 'cylinder', PALETTE.logEnd, [p.x + end * (p.hl + 0.004), p.y, p.z], [p.r * 1.7, 0.01, p.r * 1.7], {
          rot: [0, 0, 90],
          opacity,
          shadows: false,
        });
      }
    }
  }
  return root;
}

export interface ToppleScene {
  /** Forget all piece entities (new match / new round). */
  reset(): void;
  /** Per frame: pieces from the physics bodies, the held piece, the camera. `dt` is game time (0 while paused). */
  sync(sim: ToppleSim, dt: number): void;
  /** Turn the camera around the tower by `delta` radians (eased). */
  orbit(delta: number): void;
  /** Camera yaw (radians): screen-relative input is turned by it. */
  readonly yaw: number;
  /** World units per CSS pixel at the tower, for dragging the held piece. */
  readonly unitsPerPx: number;
  /** A short camera shake (topples). */
  shake(amount: number): void;
  project(x: number, y: number, z: number, out: { x: number; y: number }): void;
  /** A sim event the players react to (a topple). */
  event(e: SimEvent): void;
  /** Store art (dev only): frame closer (`zoom` < 1) or wider, from a fixed yaw; null = the game's own framing. */
  setArtView(view: { zoom: number; yaw?: number; lift?: number } | null): void;
  trim(): void;
  readonly entityCount: number;
}

/** `models`: the players (see models.ts). `shadows: false` for the dev-only low-render mode (see lowfx.ts). */
export function createToppleScene(app: Application, models: Models, opts: { shadows?: boolean } = {}): ToppleScene {
  device = app.graphicsDevice;
  app.scene.ambientLight = new Color(0.5, 0.52, 0.58);

  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: hex(PALETTE.sky),
    fov: 42,
    nearClip: 0.2,
    farClip: 200,
    gammaCorrection: GAMMA_SRGB,
    toneMapping: TONEMAP_NEUTRAL,
  });
  app.root.addChild(camera);

  const sun = new Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.96, 0.9),
    intensity: 1.1,
    castShadows: opts.shadows ?? true,
    shadowType: SHADOW_PCF5_16F,
    shadowBias: 0.2,
    normalOffsetBias: 0.04,
    shadowResolution: 2048,
    shadowDistance: 30,
    shadowIntensity: 0.4,
  });
  sun.setEulerAngles(55, 30, 0);
  app.root.addChild(sun);

  const world = new Entity('world');
  app.root.addChild(world);

  // Lawn, a ring of trees, and the stone pedestal the tower stands on (its top is y = 0).
  const floorY = -PEDESTAL_DEPTH;
  prim(world, 'cylinder', PALETTE.grass, [0, floorY - 0.05, 0], [60, 0.1, 60], { shadows: false });
  prim(world, 'cylinder', PALETTE.grassDark, [0, floorY - 0.04, 0], [9, 0.1, 9], { shadows: false });
  box(world, PALETTE.stoneDark, [0, floorY + 0.15, 0], [PEDESTAL_HALF * 2 + 0.7, 0.3, PEDESTAL_HALF * 2 + 0.7], 0.12);
  box(
    world,
    PALETTE.stone,
    [0, -PEDESTAL_DEPTH / 2 - 0.05, 0],
    [PEDESTAL_HALF * 2 - 0.1, PEDESTAL_DEPTH - 0.1, PEDESTAL_HALF * 2 - 0.1],
    0.1,
  );
  box(world, PALETTE.trim, [0, -0.08, 0], [PEDESTAL_HALF * 2, 0.16, PEDESTAL_HALF * 2], 0.06);
  const trees = new Entity('trees');
  world.addChild(trees);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + Math.sin(i * 7.3) * 0.2;
    const r = 11 + Math.abs(Math.sin(i * 3.1)) * 5;
    const s = 1 + Math.abs(Math.sin(i * 1.7)) * 0.6;
    const t = new Entity('tree');
    t.setLocalPosition(Math.cos(a) * r, floorY, Math.sin(a) * r);
    trees.addChild(t);
    prim(t, 'cylinder', PALETTE.trunk, [0, 0.5 * s, 0], [0.3 * s, 1 * s, 0.3 * s]);
    prim(t, 'sphere', i % 2 ? PALETTE.leaves : PALETTE.leaves2, [0, 1.6 * s, 0], [1.8 * s, 1.7 * s, 1.8 * s]);
  }

  const piecesRoot = new Entity('pieces');
  world.addChild(piecesRoot);
  const views = new Map<number, Entity>();

  // The held piece (translucent) and a guide line straight down from it.
  let held: Entity | null = null;
  let heldKey = '';
  const guide = prim(world, 'cylinder', PALETTE.guide, [0, 0, 0], [0.03, 1, 0.03], { opacity: 0.55, shadows: false });
  const target = prim(world, 'cylinder', PALETTE.guide, [0, 0, 0], [0.22, 0.01, 0.22], {
    opacity: 0.6,
    shadows: false,
  });

  // The players: one character per seat round the pedestal, on a disc in their seat colour. Whoever's turn it is
  // points up at the tower; a toppler slumps and sits out the rest of the match; the winner cheers.
  const peopleRoot = new Entity('people');
  world.addChild(peopleRoot);
  const people = MODELS.characters.map((name, i) => {
    const color = SEAT_COLORS[i % SEAT_COLORS.length]!;
    const person = makePerson(app, models, peopleRoot, name, color, PALETTE.skins[i % PALETTE.skins.length]!);
    const disc = prim(peopleRoot, 'cylinder', color, [0, 0, 0], [1, 0.04, 1], { opacity: 0.9, shadows: false });
    return { person, disc, color, out: false, seats: 0 };
  });
  /** Who knocked the tower over (sitting down already, before the sim marks them out). */
  let toppler = -1;
  let shownSim: ToppleSim | null = null;

  function placePeople(n: number) {
    people.forEach((v, i) => {
      if (i >= n) return;
      const a = START_YAW + ((i + 0.5) * Math.PI * 2) / n;
      const x = Math.sin(a) * RING;
      const z = Math.cos(a) * RING;
      v.person.root.setLocalPosition(x, floorY, z);
      // Face the tower (characters look down +z).
      v.person.root.setLocalEulerAngles(0, ((a + Math.PI) * 180) / Math.PI, 0);
      v.disc.setLocalPosition(x, floorY + 0.02, z);
      v.seats = n;
    });
  }

  function syncPeople(sim: ToppleSim) {
    if (sim !== shownSim) {
      // A new match: everyone back up.
      shownSim = sim;
      toppler = -1;
      for (const v of people) {
        resetPerson(v.person);
        v.out = false;
        v.disc.render!.material = mat(v.color, 0.9);
      }
    }
    const n = sim.players.length;
    people.forEach((v, i) => {
      const on = i < n;
      v.person.root.enabled = v.disc.enabled = on;
      if (!on) return;
      if (v.seats !== n) placePeople(n);
      const p = sim.players[i]!;
      const down = !p.alive || (sim.phase === 'crash' && i === toppler);
      const turn = sim.phase === 'aim' && sim.current === i && !down;
      const want: PersonState = down
        ? 'Sit'
        : sim.phase === 'over' && sim.winner === i
          ? 'Victory'
          : turn
            ? 'Point'
            : 'Idle';
      play(v.person, want, time);
      if (!p.alive && !v.out) {
        v.out = true;
        v.disc.render!.material = mat(PALETTE.out, 0.9);
      }
      const r = turn ? 1.25 + Math.sin(time * 6) * 0.08 : 1;
      v.disc.setLocalScale(r, 0.04, r);
    });
  }

  let artView: { zoom: number; yaw?: number; lift?: number } | null = null;
  let yaw = START_YAW;
  let wantYaw = yaw;
  let focusY = 0.8;
  let dist = 11;
  let shakeAmp = 0;
  let time = 0;
  const tmp = new Vec3();
  const q = new Quat();

  function fit(top: number): { focus: number; dist: number } {
    const gd = app.graphicsDevice;
    const aspect = gd.width / Math.max(1, gd.height);
    const vfov = (42 * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    // Keep the pedestal across and the upper tower (plus the held piece above it) in view, looking down onto the
    // top, where the next piece goes.
    const across = PEDESTAL_HALF * 2 * 1.42 + 0.6; // the diagonal: the pedestal is seen at an angle
    const tall = Math.max(2.8, top * 0.7 + 2.4);
    const byWidth = across / 2 / Math.tan(hfov / 2);
    const byHeight = tall / 2 / Math.tan(vfov / 2) + 1.2;
    return { focus: top * 0.7 + 0.3, dist: Math.max(7, byWidth, byHeight) };
  }

  const scene: ToppleScene = {
    get yaw() {
      return yaw;
    },
    get unitsPerPx() {
      const gd = app.graphicsDevice;
      const vfov = (42 * Math.PI) / 180;
      const cssH = gd.height / (gd.maxPixelRatio || 1);
      return (2 * dist * Math.tan(vfov / 2)) / Math.max(1, cssH);
    },
    get entityCount() {
      return views.size * 3 + 160;
    },
    reset() {
      for (const e of views.values()) e.destroy();
      views.clear();
      held?.destroy();
      held = null;
      heldKey = '';
    },
    sync(sim, dt) {
      time += dt;
      // Pieces follow their bodies.
      const seen = new Set<number>();
      for (const p of sim.pieces) {
        seen.add(p.id);
        let e = views.get(p.id);
        if (!e) {
          e = makePiece(piecesRoot, p.kind, SEAT_COLORS[p.owner % SEAT_COLORS.length]!);
          views.set(p.id, e);
        }
        const t = p.body.translation();
        const r = p.body.rotation();
        e.setPosition(t.x, t.y, t.z);
        e.setRotation(q.set(r.x, r.y, r.z, r.w));
      }
      for (const [id, e] of views) {
        if (!seen.has(id)) {
          e.destroy();
          views.delete(id);
        }
      }

      // Held piece while aiming.
      const aiming = sim.phase === 'aim';
      const key = `${sim.piece}/${sim.current}`;
      if (aiming && key !== heldKey) {
        held?.destroy();
        held = makePiece(world, sim.piece, SEAT_COLORS[sim.current % SEAT_COLORS.length]!, 0.82);
        heldKey = key;
      }
      if (held) held.enabled = aiming;
      guide.enabled = target.enabled = aiming;
      if (aiming && held) {
        const h = sim.held;
        const bob = Math.sin(time * 3) * 0.03;
        held.setPosition(h.pos.x, h.pos.y + bob, h.pos.z);
        held.setRotation(q.set(h.rot.x, h.rot.y, h.rot.z, h.rot.w));
        const len = Math.max(0.01, h.pos.y - 0.35);
        guide.setLocalPosition(h.pos.x, len / 2, h.pos.z);
        guide.setLocalScale(0.03, len, 0.03);
        target.setLocalPosition(h.pos.x, 0.012, h.pos.z);
      }

      syncPeople(sim);

      // Camera: orbit, rise with the tower, shake on topples.
      const k = dt > 0 ? 1 - Math.exp(-dt * 4) : 1;
      yaw += (wantYaw - yaw) * (dt > 0 ? 1 - Math.exp(-dt * 8) : 1);
      const want = fit(sim.towerTop);
      if (artView) {
        want.dist *= artView.zoom;
        want.focus += artView.lift ?? 0;
      }
      focusY += (want.focus - focusY) * k;
      dist += (want.dist - dist) * k;
      shakeAmp = Math.max(0, shakeAmp - dt * 1.5);
      const sx = shakeAmp ? Math.sin(time * 53) * shakeAmp : 0;
      const sy = shakeAmp ? Math.cos(time * 47) * shakeAmp : 0;
      const pitch = 0.63;
      camera.setPosition(
        Math.sin(yaw) * Math.cos(pitch) * dist + sx,
        focusY + Math.sin(pitch) * dist + sy,
        Math.cos(yaw) * Math.cos(pitch) * dist,
      );
      // Aim a little below the focus: the controls at the bottom take more room than the HUD at the top.
      camera.lookAt(sx * 0.3, focusY - dist * 0.05, 0);
    },
    orbit(delta) {
      wantYaw += delta;
    },
    setArtView(view) {
      artView = view;
      if (view?.yaw !== undefined) yaw = wantYaw = view.yaw;
    },
    event(e) {
      if (e.type !== 'topple') return;
      // The toppler slumps (then sits out); everyone else still in flinches at the crash.
      toppler = e.player;
      shownSim?.players.forEach((p, i) => {
        if (!p.alive) return;
        const v = people[i]!;
        if (i === e.player) oneShot(v.person, models, 'Defeat', time);
        else oneShot(v.person, models, 'Flinch', time, 1.2);
      });
    },
    shake(amount) {
      shakeAmp = Math.min(0.5, Math.max(shakeAmp, amount));
    },
    project(x, y, z, out) {
      const s = camera.camera!.worldToScreen(tmp.set(x, y, z));
      out.x = s.x;
      out.y = s.y;
    },
    trim() {
      sun.light!.shadowResolution = 1024;
      trees.enabled = false;
    },
  };
  return scene;
}
