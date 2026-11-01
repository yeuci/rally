import { hexRgb } from '@rally/game-kit';
import {
  BLEND_ADDITIVEALPHA,
  BLEND_NORMAL,
  Color,
  Entity,
  MeshInstance,
  SHADOW_PCF1_32F,
  StandardMaterial,
  Vec3,
  type Application,
} from 'playcanvas';
import {
  BARRELS,
  CAMERA_FOV_DEG,
  CAMERA_LEAD,
  CAMERA_PITCH_DEG,
  MEDS,
  PALETTE,
  PLAYER_RADIUS,
  cameraDistance,
  cameraFocus,
  tierWeapon,
  type Vec2,
  type WeaponSpec,
} from '@rally/game-gunrun-server';
import { createFighter, type Fighter } from './characters.ts';
import { tracerLength } from './localgun.ts';
import { buildLevel } from './level.ts';
import type { Models } from './models.ts';

/**
 * Rendering only. Simulation coordinates (x right, y down the screen) map to world (x, 0, y); the camera looks down at
 * 60° from the +z side (Overrun's camera, a little closer) and follows the local player with a lead toward the aim.
 * Its framing is the rules' (view.ts), so the server knows what each player's screen shows.
 */
const SKY = new Color(0.36, 0.55, 0.28);
const PITCH = (CAMERA_PITCH_DEG * Math.PI) / 180;
/** Gun height: tracers, muzzle flashes, the aim plane. */
const GUN_Y = 1.0;
const MAX_TRACERS = 48;
const MAX_BURSTS = 48;
const MAX_BOOMS = 8;
const MAX_SCORCH = 10;

export interface PlayerPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Aim angle (radians, sim axes). */
  aim: number;
  slot: number;
  alive: boolean;
  /** Spawn protection: drawn flickering. */
  prot: boolean;
  me: boolean;
  /** Rung of the ladder: the gun in hand. */
  tier: number;
  /** The match winner on the podium. */
  celebrating: boolean;
}

export interface SceneOptions {
  /** The sun casts shadows. Default true. */
  shadows?: boolean;
  /** Bursts, scorch marks, camera shake. Default true. */
  effects?: boolean;
}

export interface GunRunScene {
  /**
   * Point the camera at (x, y), led toward `aim` (unit, sim axes; touch and keys), or by `lead` (world units: the
   * mouse, from the cursor's offset from the screen centre, so the lead never feeds back into the aim). `snap` jumps.
   */
  focus(x: number, y: number, aim: Vec2 | null, snap?: boolean, lead?: Vec2): void;
  setPlayer(id: string, pose: PlayerPose): void;
  removePlayer(id: string): void;
  /** Standing barrels and med kits (bits of `BARRELS` / `MEDS`). */
  setBarrels(bits: number): void;
  setMeds(bits: number): void;
  /** Rockets (kind 0) and grenades (1) in flight; `prune()` drops the ones not set since. */
  setProjectile(id: string, kind: number, x: number, y: number, h: number): void;
  prune(): void;
  /**
   * A shot by player `shooter` (null: nobody drawn): the flash at their gun's muzzle (the barrel tip, following the
   * animation) and a tracer from there to each ray's end (`ends`: x, y pairs; none for a rocket or grenade launch);
   * their arms play the shot. Without a gun in hand to start from, (x, y) at gun height stands in.
   */
  shot(shooter: string | null, x: number, y: number, angle: number, weapon: WeaponSpec, ends: readonly number[]): void;
  /** A stab by player `shooter`: the swing at (x, y) toward `angle`; their arms play the punch. */
  stab(shooter: string | null, x: number, y: number, angle: number): void;
  /** A bullet or a blade connects: sparks in the victim's colour. */
  hit(x: number, y: number, slot: number): void;
  explosion(x: number, y: number, radius: number): void;
  shake(amount: number): void;
  /** Screen position (CSS px) above a player's head, for labels; false when hidden. */
  labelAnchor(id: string, out: { x: number; y: number }): boolean;
  /** Screen position (CSS px) of a ground point at height `h`. */
  toScreen(x: number, y: number, h: number, out: { x: number; y: number }): void;
  /** The ground point (sim, at gun height) under a screen position (CSS px), or null. */
  toGround(sx: number, sy: number): Vec2 | null;
  update(dt: number): void;
  /** Camera distance multiplier (store art: closer for the icon). Default 1. */
  setZoom(k: number): void;
  /** Drop pooled effects (lowMemory). */
  trim(): void;
  readonly drawnPlayers: number;
  readonly camera: Entity;
}

function material(color: Color, opts: { gloss?: number; vertex?: boolean } = {}): StandardMaterial {
  const m = new StandardMaterial();
  m.diffuse = color;
  m.useMetalness = false;
  m.specular = new Color(0.06, 0.06, 0.06);
  m.gloss = opts.gloss ?? 0.25;
  if (opts.vertex) m.diffuseVertexColor = true;
  m.update();
  return m;
}

function glow(color: Color, opts: { additive?: boolean; opacity?: number } = {}): StandardMaterial {
  const m = new StandardMaterial();
  m.diffuse = new Color(0, 0, 0);
  m.emissive = color;
  m.useLighting = false;
  m.blendType = opts.additive === false ? BLEND_NORMAL : BLEND_ADDITIVEALPHA;
  m.depthWrite = false;
  m.opacity = opts.opacity ?? 1;
  m.update();
  return m;
}

const rgb = (hex: string) => {
  const [r, g, b] = hexRgb(hex);
  return new Color(r / 255, g / 255, b / 255);
};

interface Rig {
  fighter: Fighter;
  ring: Entity;
  laser: Entity;
  visible: boolean;
  alive: boolean;
  x: number;
  y: number;
  /** Scene clock at this player's last shot / stab (the arms play it for a moment). */
  firedAt: number;
  stabbedAt: number;
}

interface Effect {
  e: Entity;
  mat: StandardMaterial;
  age: number;
  life: number;
  live: boolean;
  vx: number;
  vy: number;
  vz: number;
  size: number;
}

export function createGunRunScene(
  app: Application,
  onResize: (fn: (w: number, h: number) => void) => void,
  models: Models,
  { shadows = true, effects = true }: SceneOptions = {},
): GunRunScene {
  const device = app.graphicsDevice;
  app.scene.ambientLight = new Color(0.52, 0.53, 0.58);
  // One directional light: clustered lighting buys nothing here and costs every fragment (a lot on weak GPUs).
  app.scene.clusteredLightingEnabled = false;

  // --- camera ---------------------------------------------------------------------------------------------
  const camera = new Entity('camera');
  camera.addComponent('camera', { clearColor: SKY, fov: CAMERA_FOV_DEG, nearClip: 1, farClip: 120 });
  app.root.addChild(camera);
  let dist = 20;
  let zoom = 1;
  const focusAt = new Vec3();
  const focusWant = new Vec3();
  let focusSet = false;
  // The framing the rules share (view.ts): bots only fire from where your screen shows them.
  function frame(width: number, height: number) {
    dist = cameraDistance(width / Math.max(1, height));
  }
  frame(device.width, device.height);
  onResize(frame);

  const sun = new Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.95, 0.85),
    intensity: 1.15,
    castShadows: shadows,
    // Hard single-tap shadows suit the toon look and cost a third less than PCF3 (measured in software GL).
    shadowType: SHADOW_PCF1_32F,
    shadowBias: 0.3,
    normalOffsetBias: 0.06,
    shadowResolution: 1024,
    shadowDistance: 34,
    shadowIntensity: 0.55,
  });
  sun.setEulerAngles(55, 35, 0);
  app.root.addChild(sun);

  // --- the yard ---------------------------------------------------------------------------------------------
  const vertexMat = material(new Color(1, 1, 1), { vertex: true, gloss: 0.2 });
  buildLevel(app, models, vertexMat, shadows);

  const barrels = BARRELS.map((b) => {
    const e = new Entity('barrel');
    e.addComponent('render', {
      meshInstances: [new MeshInstance(models.props.ExplodingBarrel.mesh, vertexMat)],
      castShadows: shadows,
      receiveShadows: true,
    });
    e.setPosition(b.x, 0, b.y);
    e.setEulerAngles(0, b.x * 37, 0);
    app.root.addChild(e);
    return { e, up: true, pop: 1 };
  });
  const medGlow = glow(new Color(0.3, 1, 0.4), { additive: false, opacity: 0.25 });
  const meds = MEDS.map((m) => {
    const root = new Entity('med');
    const kit = new Entity('kit');
    kit.addComponent('render', {
      meshInstances: [new MeshInstance(models.props.Health.mesh, vertexMat)],
      castShadows: shadows,
    });
    root.addChild(kit);
    const ring = new Entity('med-ring');
    ring.addComponent('render', { type: 'cylinder', material: medGlow, castShadows: false });
    ring.setLocalScale(1.0, 0.02, 1.0);
    ring.setLocalPosition(0, 0.02, 0);
    root.addChild(ring);
    root.setPosition(m.x, 0, m.y);
    app.root.addChild(root);
    return { root, kit, up: true };
  });

  // --- players ------------------------------------------------------------------------------------------------
  const ringMats = PALETTE.map((c) => glow(rgb(c), { additive: false, opacity: 0.5 }));
  const myRingMat = glow(new Color(1, 1, 1), { additive: false, opacity: 0.45 });
  const laserMat = glow(new Color(1, 0.15, 0.1), { opacity: 0.55 });
  const rigs = new Map<string, Rig>();
  function makeRig(slot: number): Rig {
    const fighter = createFighter(app, models, slot, vertexMat);
    const ring = new Entity('ring');
    ring.addComponent('render', { type: 'cylinder', material: ringMats[slot % ringMats.length]!, castShadows: false });
    ring.setLocalScale(1.15, 0.02, 1.15);
    ring.setLocalPosition(0, 0.015, 0);
    fighter.root.addChild(ring);
    const laser = new Entity('laser');
    laser.addComponent('render', { type: 'box', material: laserMat, castShadows: false });
    laser.enabled = false;
    app.root.addChild(laser);
    app.root.addChild(fighter.root);
    return { fighter, ring, laser, visible: true, alive: true, x: 0, y: 0, firedAt: -1, stabbedAt: -1 };
  }

  // --- projectiles ----------------------------------------------------------------------------------------------
  const rocketBody = material(new Color(0.32, 0.34, 0.38));
  const rocketTip = material(new Color(0.75, 0.12, 0.1));
  const flame = glow(new Color(1, 0.6, 0.2));
  interface Shell {
    e: Entity;
    kind: number;
    seen: boolean;
    x: number;
    y: number;
    spin: number;
  }
  const shells = new Map<string, Shell>();
  function makeShell(kind: number): Entity {
    const e = new Entity('shell');
    if (kind === 0) {
      const body = new Entity();
      body.addComponent('render', { type: 'cylinder', material: rocketBody, castShadows: shadows });
      body.setLocalScale(0.16, 0.5, 0.16);
      body.setLocalEulerAngles(90, 0, 0);
      const tip = new Entity();
      tip.addComponent('render', { type: 'cone', material: rocketTip, castShadows: false });
      tip.setLocalScale(0.16, 0.18, 0.16);
      tip.setLocalPosition(0, 0, 0.33);
      tip.setLocalEulerAngles(90, 0, 0);
      const fire = new Entity();
      fire.addComponent('render', { type: 'sphere', material: flame, castShadows: false });
      fire.setLocalScale(0.18, 0.18, 0.36);
      fire.setLocalPosition(0, 0, -0.36);
      e.addChild(body);
      e.addChild(tip);
      e.addChild(fire);
    } else {
      e.addComponent('render', {
        meshInstances: [new MeshInstance(models.grenade, vertexMat)],
        castShadows: shadows,
      });
      e.setLocalScale(0.7, 0.7, 0.7);
    }
    app.root.addChild(e);
    return e;
  }

  // --- effects ------------------------------------------------------------------------------------------------
  function effectEntity(type: 'box' | 'sphere' | 'cylinder', mat: StandardMaterial): Effect {
    const e = new Entity();
    const m = mat.clone();
    m.update();
    e.addComponent('render', { type, material: m, castShadows: false, receiveShadows: false });
    e.enabled = false;
    app.root.addChild(e);
    return { e, mat: m, age: 0, life: 1, live: false, vx: 0, vy: 0, vz: 0, size: 1 };
  }
  const pool = (n: number, make: () => Effect) => Array.from({ length: n }, make);
  const tracers = pool(MAX_TRACERS, () => effectEntity('box', glow(new Color(1, 0.88, 0.5))));
  const muzzles = pool(10, () => effectEntity('sphere', glow(new Color(1, 0.78, 0.35))));
  const slashes = pool(6, () => effectEntity('box', glow(new Color(1, 1, 1))));
  // A blast: a white-hot core, orange fire puffs flung out and up, a flash on the ground, then grey smoke.
  const booms = pool(MAX_BOOMS, () => effectEntity('sphere', glow(new Color(1, 0.92, 0.6))));
  const fire = pool(MAX_BOOMS * 5, () => effectEntity('sphere', glow(new Color(1, 0.5, 0.12))));
  const shocks = pool(MAX_BOOMS, () => effectEntity('cylinder', glow(new Color(1, 0.75, 0.4))));
  const smokeBase = glow(new Color(0.42, 0.4, 0.38), { additive: false, opacity: 0.7 });
  const smoke = effects ? pool(MAX_BOOMS * 3, () => effectEntity('sphere', smokeBase)) : [];
  const bursts = effects ? pool(MAX_BURSTS, () => effectEntity('box', material(new Color(1, 1, 1)))) : [];
  const scorchMat = glow(new Color(0, 0, 0), { additive: false, opacity: 0.35 });
  scorchMat.emissive = new Color(0.05, 0.04, 0.03);
  scorchMat.update();
  const scorches = effects ? pool(MAX_SCORCH, () => effectEntity('cylinder', scorchMat)) : [];
  const take = (list: Effect[]) => {
    let best = list[0]!;
    for (const f of list) {
      if (!f.live) return f;
      if (f.age / f.life > best.age / best.life) best = f;
    }
    return best;
  };
  const start = (f: Effect, life: number) => {
    f.live = true;
    f.age = 0;
    f.life = life;
    f.e.enabled = true;
  };
  const step = (list: Effect[], dt: number, each: (f: Effect, u: number) => void) => {
    for (const f of list) {
      if (!f.live) continue;
      f.age += dt;
      const u = f.age / f.life;
      if (u >= 1) {
        f.live = false;
        f.e.enabled = false;
        continue;
      }
      each(f, u);
    }
  };

  let clock = 0;
  let shakeAmp = 0;
  let drawn = 0;
  const camPos = new Vec3();
  const from = new Vec3();
  const to = new Vec3();
  const tmp = new Vec3();
  const ray0 = new Vec3();
  const ray1 = new Vec3();

  return {
    camera,
    get drawnPlayers() {
      return drawn;
    },
    focus(x, y, aim, snap = false, lead) {
      const l = lead ?? (aim ? { x: aim.x * CAMERA_LEAD, y: aim.y * CAMERA_LEAD * 0.7 } : { x: 0, y: 0 });
      // Led, and kept inside the yard (plus a margin) when the yard is bigger than the screen.
      const f = cameraFocus(x, y, l, device.width / Math.max(1, device.height), zoom);
      focusWant.set(f.x, 0, f.y);
      if (snap || !focusSet) {
        focusAt.copy(focusWant);
        focusSet = true;
      }
    },
    setPlayer(id, v) {
      let r = rigs.get(id);
      if (!r) rigs.set(id, (r = makeRig(v.slot)));
      r.x = v.x;
      r.y = v.y;
      r.alive = v.alive;
      r.visible = true;
      const root = r.fighter.root;
      root.setPosition(v.x, 0, v.y);
      // Facing the aim (sim angle → yaw about +y; the models face +z). The dead keep the way they fell.
      if (v.alive) root.setEulerAngles(0, (Math.atan2(Math.cos(v.aim), Math.sin(v.aim)) * 180) / Math.PI, 0);
      const speed = Math.hypot(v.vx, v.vy);
      const back = speed > 0.3 && (v.vx * Math.cos(v.aim) + v.vy * Math.sin(v.aim)) / speed < -0.2;
      const w = tierWeapon(v.tier);
      r.fighter.setWeapon(v.alive ? w.id : null);
      r.fighter.update({
        speed: v.alive ? speed : 0,
        back,
        alive: v.alive,
        firing: clock - r.firedAt < 0.3,
        stabbing: clock - r.stabbedAt < 0.05,
        celebrating: v.celebrating,
      });
      r.fighter.setVisible(!v.prot || Math.floor(clock * 12) % 2 === 0);
      r.ring.enabled = v.alive;
      r.ring.render!.meshInstances[0]!.material = v.me ? myRingMat : ringMats[v.slot % ringMats.length]!;
      // The sniper's laser sight: everyone sees where a sniper points.
      r.laser.enabled = v.alive && w.id === 'sniper';
      if (r.laser.enabled) {
        const dx = Math.cos(v.aim);
        const dy = Math.sin(v.aim);
        // From the rifle's muzzle (last frame's pose: the fighter was placed above, its bones update next).
        if (!r.fighter.muzzle(from)) from.set(v.x + dx * 0.6, GUN_Y, v.y + dy * 0.6);
        const ox = from.x;
        const oy = from.z;
        const others: { x: number; y: number; r: number }[] = [];
        for (const o of rigs.values())
          if (o !== r && o.visible && o.alive) others.push({ x: o.x, y: o.y, r: PLAYER_RADIUS });
        const len = tracerLength(ox, oy, dx, dy, w.range, others);
        r.laser.setPosition(ox + (dx * len) / 2, from.y, oy + (dy * len) / 2);
        r.laser.setEulerAngles(0, (Math.atan2(dx, dy) * 180) / Math.PI, 0);
        r.laser.setLocalScale(0.025, 0.025, len);
      }
    },
    removePlayer(id) {
      const r = rigs.get(id);
      if (!r) return;
      r.fighter.destroy();
      r.laser.destroy();
      rigs.delete(id);
    },
    setBarrels(bits) {
      barrels.forEach((b, i) => {
        const up = (bits & (1 << i)) !== 0;
        if (up && !b.up) b.pop = 0;
        b.up = up;
        b.e.enabled = up;
      });
    },
    setMeds(bits) {
      meds.forEach((m, i) => {
        m.up = (bits & (1 << i)) !== 0;
        m.root.enabled = m.up;
      });
    },
    setProjectile(id, kind, x, y, h) {
      let s = shells.get(id);
      if (!s) shells.set(id, (s = { e: makeShell(kind), kind, seen: true, x, y, spin: 0 }));
      s.seen = true;
      const dx = x - s.x;
      const dy = y - s.y;
      if (dx * dx + dy * dy > 1e-6) s.e.setEulerAngles(0, (Math.atan2(dx, dy) * 180) / Math.PI, 0);
      if (kind === 1) {
        s.spin += 12;
        s.e.setLocalEulerAngles(s.spin, (Math.atan2(dx, dy) * 180) / Math.PI, 0);
      }
      s.x = x;
      s.y = y;
      s.e.setPosition(x, h, y);
    },
    prune() {
      for (const [id, s] of shells) {
        if (s.seen) {
          s.seen = false;
          continue;
        }
        s.e.destroy();
        shells.delete(id);
      }
    },
    shot(shooter, x, y, angle, weapon, ends) {
      const r = shooter ? rigs.get(shooter) : undefined;
      if (r) r.firedAt = clock;
      // From the barrel tip when the shooter's gun is drawn, else from the server's ray origin at gun height.
      if (!r?.visible || !r.fighter.muzzle(from)) from.set(x + Math.cos(angle) * 0.4, GUN_Y, y + Math.sin(angle) * 0.4);
      const f = take(muzzles);
      start(f, 0.05);
      f.e.setPosition(from.x + Math.cos(angle) * 0.1, from.y, from.z + Math.sin(angle) * 0.1);
      f.size = weapon.pellets > 1 || weapon.kind !== 'hitscan' ? 0.75 : weapon.id === 'smg' ? 0.35 : 0.5;
      f.e.setLocalScale(f.size, f.size, f.size);
      for (let i = 0; i + 1 < ends.length; i += 2) {
        to.set(ends[i]!, from.y, ends[i + 1]!);
        const len = to.distance(from);
        if (len < 0.05) continue;
        const t = take(tracers);
        const sniper = weapon.id === 'sniper';
        start(t, sniper ? 0.22 : weapon.pellets > 1 ? 0.08 : 0.06);
        t.e.setPosition((from.x + to.x) / 2, from.y, (from.z + to.z) / 2);
        t.e.lookAt(to);
        t.size = sniper ? 0.09 : weapon.pellets > 1 ? 0.035 : 0.05;
        t.e.setLocalScale(t.size, t.size, len);
      }
    },
    stab(shooter, x, y, angle) {
      const r = shooter ? rigs.get(shooter) : undefined;
      if (r) r.stabbedAt = clock;
      const f = take(slashes);
      start(f, 0.14);
      f.vx = angle;
      f.e.setPosition(x + Math.cos(angle) * 0.9, GUN_Y, y + Math.sin(angle) * 0.9);
      f.e.setEulerAngles(0, (Math.atan2(Math.cos(angle), Math.sin(angle)) * 180) / Math.PI + 90, 0);
      f.e.setLocalScale(0.05, 0.05, 1.1);
    },
    hit(x, y, slot) {
      if (!effects) return;
      const c = rgb(PALETTE[slot % PALETTE.length] ?? '#ffffff');
      for (let i = 0; i < 5; i++) {
        const b = take(bursts);
        start(b, 0.4);
        const a = (i / 5) * Math.PI * 2 + clock * 7;
        b.vx = Math.cos(a) * 2.5;
        b.vz = Math.sin(a) * 2.5;
        b.vy = 3 + (i % 3);
        b.size = 0.09 + (i % 2) * 0.04;
        b.e.setPosition(x, 1.1, y);
        b.e.setLocalScale(b.size, b.size, b.size);
        b.mat.diffuse = i % 2 ? c : new Color(1, 0.95, 0.7);
        b.mat.update();
      }
    },
    explosion(x, y, radius) {
      const f = take(booms);
      start(f, 0.3);
      f.size = radius * 0.75;
      f.e.setPosition(x, 0.7, y);
      for (let i = 0; i < 5; i++) {
        const p = take(fire);
        start(p, 0.5 + (i % 2) * 0.1);
        const a = (i / 5) * Math.PI * 2 + x;
        p.vx = Math.cos(a) * radius * 0.9;
        p.vz = Math.sin(a) * radius * 0.9;
        p.vy = 2.2 + (i % 3) * 0.6;
        p.size = radius * (0.32 + (i % 3) * 0.06);
        p.e.setPosition(x + Math.cos(a) * 0.3, 0.6, y + Math.sin(a) * 0.3);
      }
      const s = take(shocks);
      start(s, 0.25);
      s.size = radius * 2;
      s.e.setPosition(x, 0.06, y);
      if (!effects) return;
      for (let i = 0; i < 3; i++) {
        const p = take(smoke);
        start(p, 1.6);
        p.vx = Math.cos(i * 2.1 + y) * 0.5;
        p.vz = Math.sin(i * 2.1 + y) * 0.5;
        p.vy = 1.2;
        p.size = radius * 0.35;
        p.e.setPosition(x + p.vx, 0.9, y + p.vz);
      }
      const sc = take(scorches);
      start(sc, 4);
      sc.size = radius * 0.7;
      sc.e.setPosition(x, 0.012, y);
      sc.e.setLocalScale(sc.size, 0.004, sc.size);
    },
    shake(amount) {
      if (!effects) return;
      shakeAmp = Math.min(0.7, Math.max(shakeAmp, amount));
    },
    labelAnchor(id, out) {
      const r = rigs.get(id);
      if (!r || !r.visible) return false;
      tmp.set(r.x, r.alive ? 2.5 : 1.0, r.y);
      camera.camera!.worldToScreen(tmp, ray0);
      out.x = ray0.x;
      out.y = ray0.y;
      return true;
    },
    toScreen(x, y, h, out) {
      tmp.set(x, h, y);
      camera.camera!.worldToScreen(tmp, ray0);
      out.x = ray0.x;
      out.y = ray0.y;
    },
    toGround(sx, sy) {
      const cam = camera.camera!;
      cam.screenToWorld(sx, sy, cam.nearClip, ray0);
      cam.screenToWorld(sx, sy, cam.farClip, ray1);
      const dy = ray1.y - ray0.y;
      if (Math.abs(dy) < 1e-6) return null;
      const t = (GUN_Y - ray0.y) / dy; // the plane at gun height, so aim lines up with the tracer
      if (t < 0) return null;
      return { x: ray0.x + (ray1.x - ray0.x) * t, y: ray0.z + (ray1.z - ray0.z) * t };
    },
    update(dt) {
      clock += dt;
      drawn = 0;
      for (const r of rigs.values()) if (r.visible) drawn++;
      // Camera: ease toward the focus.
      const k = 1 - Math.exp(-dt * 7);
      focusAt.x += (focusWant.x - focusAt.x) * k;
      focusAt.z += (focusWant.z - focusAt.z) * k;
      const d = dist * zoom;
      camPos.set(focusAt.x, Math.sin(PITCH) * d, focusAt.z + Math.cos(PITCH) * d);
      if (shakeAmp > 0.002) {
        camPos.x += (Math.random() - 0.5) * 2 * shakeAmp;
        camPos.y += (Math.random() - 0.5) * shakeAmp;
        camPos.z += (Math.random() - 0.5) * 2 * shakeAmp;
        shakeAmp *= Math.exp(-dt * 9);
      } else {
        shakeAmp = 0;
      }
      camera.setPosition(camPos);
      camera.lookAt(focusAt.x, 0, focusAt.z);
      // The yard's live props.
      for (const b of barrels) {
        if (b.pop >= 1) continue;
        b.pop = Math.min(1, b.pop + dt * 3);
        const s = 0.6 + 0.4 * b.pop;
        b.e.setLocalScale(s, s, s);
      }
      meds.forEach((m, i) => {
        m.kit.setLocalPosition(0, 0.25 + Math.sin(clock * 3 + i) * 0.08, 0);
        m.kit.setLocalEulerAngles(0, clock * 90 + i * 40, 0);
      });
      // Effects.
      step(tracers, dt, (f, u) => {
        f.mat.opacity = 1 - u;
        f.mat.update();
      });
      step(muzzles, dt, () => {});
      step(slashes, dt, (f, u) => {
        f.e.setLocalScale(0.05, 0.05, 1.1 * (1 - u * 0.5));
        f.mat.opacity = 1 - u;
        f.mat.update();
      });
      step(booms, dt, (f, u) => {
        const s = f.size * (0.5 + 0.7 * Math.sqrt(u));
        f.e.setLocalScale(s, s, s);
        f.mat.opacity = 1 - u * u;
        f.mat.update();
      });
      step(fire, dt, (f, u) => {
        const p = f.e.getPosition();
        f.vx *= Math.exp(-dt * 5);
        f.vz *= Math.exp(-dt * 5);
        f.e.setPosition(p.x + f.vx * dt, p.y + f.vy * dt, p.z + f.vz * dt);
        const s = f.size * (1 - u * 0.7);
        f.e.setLocalScale(s, s, s);
        f.mat.opacity = 1 - u;
        f.mat.update();
      });
      step(shocks, dt, (f, u) => {
        const s = f.size * (0.4 + 0.6 * u);
        f.e.setLocalScale(s, 0.02, s);
        f.mat.opacity = 0.45 * (1 - u);
        f.mat.update();
      });
      step(smoke, dt, (f, u) => {
        const p = f.e.getPosition();
        f.e.setPosition(p.x + f.vx * dt, p.y + f.vy * dt, p.z + f.vz * dt);
        const s = f.size * (0.5 + u);
        f.e.setLocalScale(s, s, s);
        // Smoke shows once the fire has burnt out.
        f.mat.opacity = 0.65 * Math.min(1, u * 4) * (1 - u);
        f.mat.update();
      });
      step(scorches, dt, (f, u) => {
        f.mat.opacity = 0.35 * (1 - u * u);
        f.mat.update();
      });
      step(bursts, dt, (f) => {
        f.vy -= 18 * dt;
        const p = f.e.getPosition();
        const y = Math.max(0.05, p.y + f.vy * dt);
        f.e.setPosition(p.x + f.vx * dt, y, p.z + f.vz * dt);
        if (y <= 0.05) {
          f.vx *= 0.6;
          f.vz *= 0.6;
        }
      });
    },
    setZoom(k) {
      zoom = k;
    },
    trim() {
      for (const list of [tracers, muzzles, slashes, booms, fire, shocks, smoke, bursts, scorches]) {
        for (const f of list) {
          f.live = false;
          f.e.enabled = false;
        }
      }
    },
  };
}
