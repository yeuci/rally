import {
  BLEND_ADDITIVEALPHA,
  Color,
  CylinderGeometry,
  Entity,
  Mesh,
  MeshInstance,
  SHADOW_PCF3_32F,
  StandardMaterial,
  Vec3,
  type Application,
} from 'playcanvas';
import { ARENA_RADIUS, PALETTE, PUCK_RADIUS } from '@rally/game-sumo-server';

/**
 * Rendering only. Simulation coordinates (x right, y down the screen) map to world (x, 0, y): the camera looks at
 * the platform from the +z side, so dragging right/down on the screen pushes the puck right/down.
 */
const BG = new Color(16 / 255, 20 / 255, 32 / 255);
const PUCK_HEIGHT = 0.7;
const PLATFORM_DEPTH = 0.9;
const FALL_GRAVITY = 26;
const MAX_FLASHES = 6;

export interface PuckView {
  /** Sim coordinates. */
  x: number;
  y: number;
  color: number;
  me: boolean;
  /** Shown on the platform (false: not in the round / already fallen and gone). */
  visible: boolean;
}

export interface SumoScene {
  setRadius(radius: number): void;
  /** Create or update a puck; `falling` starts the fall animation from its current position. */
  setPuck(id: string, view: PuckView): void;
  /** Start falling off the platform, drifting with `vx, vy` (sim units/s). */
  fall(id: string, vx: number, vy: number): void;
  removePuck(id: string): void;
  /** Little additive ring at a contact point; `strength` ~ impulse. */
  flash(x: number, y: number, strength: number): void;
  /** Camera shake, in world units of displacement. */
  shake(amount: number): void;
  /** Screen position (CSS px) of the point above a puck, for name labels; null if hidden. */
  labelAnchor(id: string, out: { x: number; y: number }): boolean;
  update(dt: number): void;
  /** Drop pooled effects (lowMemory). */
  trim(): void;
  /** The game menu: shadows and hit effects (graphics quality, live) and the "Screen shake" setting. */
  setQuality(q: { shadows: boolean; effects: boolean; shake: boolean }): void;
}

function material(color: Color, opts: { gloss?: number; emissive?: Color } = {}): StandardMaterial {
  const m = new StandardMaterial();
  m.diffuse = color;
  m.useMetalness = false;
  m.specular = new Color(0.12, 0.12, 0.12);
  m.gloss = opts.gloss ?? 0.35;
  if (opts.emissive) m.emissive = opts.emissive;
  m.update();
  return m;
}

function hex(c: string): Color {
  const n = Number.parseInt(c.slice(1), 16);
  return new Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

interface Puck {
  root: Entity;
  body: Entity;
  ring: Entity;
  color: number;
  fallVel: Vec3 | null;
  fallAge: number;
  visible: boolean;
}

export interface SumoSceneOptions {
  /** The sun casts shadows (a 1024² PCF shadow map, drawn every frame). Default true. */
  shadows?: boolean;
  /** Hit flashes and camera shake. Default true. */
  effects?: boolean;
}

export function createSumoScene(
  app: Application,
  onResize: (fn: (w: number, h: number) => void) => void,
  { shadows = true, effects = true }: SumoSceneOptions = {},
): SumoScene {
  app.scene.ambientLight = new Color(0.42, 0.44, 0.52);
  /** Hit flashes and shake (the game menu's graphics, live), and the "Screen shake" setting. */
  let fx = effects;
  let shakeOn = true;

  const camera = new Entity('camera');
  camera.addComponent('camera', { clearColor: BG, fov: 40, nearClip: 0.5, farClip: 200 });
  app.root.addChild(camera);
  const camBase = new Vec3();
  const lookAt = new Vec3(0, 0, -0.5);
  const ELEVATION = (58 * Math.PI) / 180;

  /** Fit the full-size platform (plus pucks on its rim) for the current aspect, leaving room for the top HUD. */
  function frame(width: number, height: number) {
    const aspect = width / Math.max(1, height);
    const halfV = Math.tan((40 * Math.PI) / 360);
    const r = ARENA_RADIUS + 1.6;
    const needV = r * Math.sin(ELEVATION) + 1.4;
    // +10 %: the near edge is closer to the camera, so perspective makes it bigger than this flat estimate.
    const dist = Math.max(needV / halfV, r / (halfV * aspect)) * 1.1;
    camBase.set(lookAt.x, lookAt.y + Math.sin(ELEVATION) * dist, lookAt.z + Math.cos(ELEVATION) * dist);
    camera.setPosition(camBase);
    camera.lookAt(lookAt);
  }
  frame(app.graphicsDevice.width, app.graphicsDevice.height);
  onResize(frame);

  const sun = new Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.97, 0.92),
    intensity: 0.95,
    castShadows: shadows,
    shadowType: SHADOW_PCF3_32F,
    shadowBias: 0.25,
    normalOffsetBias: 0.05,
    shadowResolution: 1024,
    shadowDistance: 60,
    shadowIntensity: 0.55,
  });
  sun.setEulerAngles(62, 28, 0);
  app.root.addChild(sun);

  // Void below the platform: a dark disc far down sells the height when pucks fall.
  const voidDisc = new Entity('void');
  voidDisc.addComponent('render', {
    type: 'cylinder',
    material: material(new Color(0.07, 0.09, 0.15)),
    receiveShadows: false,
  });
  voidDisc.setLocalScale(80, 0.1, 80);
  voidDisc.setPosition(0, -14, 0);
  app.root.addChild(voidDisc);

  // The dohyo: clay top with a straw-coloured band (the tawara) around the edge, both scaled with the radius.
  // The platform is the biggest thing on screen: a smooth 72-sided cylinder instead of the 20-sided primitive.
  const disc = Mesh.fromGeometry(app.graphicsDevice, new CylinderGeometry({ radius: 0.5, height: 1, capSegments: 72 }));
  const smooth = (name: string, color: Color, gloss: number, receive: boolean) => {
    const e = new Entity(name);
    e.addComponent('render', {
      meshInstances: [new MeshInstance(disc, material(color, { gloss }))],
      castShadows: false,
      receiveShadows: receive,
    });
    app.root.addChild(e);
    return e;
  };
  const platform = smooth('platform', hex('#d9b27a'), 0.15, true);
  const band = smooth('band', hex('#f1e4c3'), 0.2, true);
  const inner = smooth('inner-ring', hex('#c99f66'), 0.1, true);
  let radius = ARENA_RADIUS;
  function applyRadius() {
    platform.setLocalScale(radius * 2, PLATFORM_DEPTH, radius * 2);
    platform.setPosition(0, -PLATFORM_DEPTH / 2, 0);
    band.setLocalScale(radius * 2 + 0.5, PLATFORM_DEPTH - 0.06, radius * 2 + 0.5);
    band.setPosition(0, -PLATFORM_DEPTH / 2 - 0.04, 0);
    // A darker inner circle: a visual reference for the centre while the edge shrinks.
    inner.setLocalScale(Math.min(radius, 3.4) * 2, 0.02, Math.min(radius, 3.4) * 2);
    inner.setPosition(0, 0.005, 0);
  }
  applyRadius();

  const puckMats = PALETTE.map((c) => material(hex(c), { gloss: 0.55 }));
  const ringMat = material(new Color(1, 1, 1), { emissive: new Color(0.9, 0.9, 0.9) });
  const pucks = new Map<string, Puck>();

  const flashMat = new StandardMaterial();
  flashMat.diffuse = new Color(0, 0, 0);
  flashMat.emissive = new Color(1, 0.95, 0.8);
  flashMat.useLighting = false;
  flashMat.blendType = BLEND_ADDITIVEALPHA;
  flashMat.depthWrite = false;
  flashMat.update();
  let flashes: { e: Entity; mat: StandardMaterial; age: number; size: number }[] = [];

  let shakeAmp = 0;
  const shakeOffset = new Vec3();
  const tmp = new Vec3();

  function makePuck(id: string, color: number): Puck {
    const root = new Entity(`puck-${id}`);
    const body = new Entity('body');
    body.addComponent('render', {
      type: 'cylinder',
      material: puckMats[color % puckMats.length]!,
      castShadows: true,
      receiveShadows: true,
    });
    body.setLocalScale(PUCK_RADIUS * 2, PUCK_HEIGHT, PUCK_RADIUS * 2);
    body.setLocalPosition(0, PUCK_HEIGHT / 2, 0);
    // A lighter cap makes the pucks read as pucks rather than flat discs from the camera angle.
    const cap = new Entity('cap');
    cap.addComponent('render', { type: 'cylinder', material: puckMats[color % puckMats.length]!, castShadows: false });
    cap.setLocalScale(0.62, 0.12, 0.62);
    cap.setLocalPosition(0, 0.56, 0);
    body.addChild(cap);
    const ring = new Entity('me-ring');
    ring.addComponent('render', { type: 'cylinder', material: ringMat, castShadows: false });
    ring.setLocalScale(PUCK_RADIUS * 2 + 0.45, 0.04, PUCK_RADIUS * 2 + 0.45);
    ring.setLocalPosition(0, 0.02, 0);
    ring.enabled = false;
    root.addChild(ring);
    root.addChild(body);
    app.root.addChild(root);
    return { root, body, ring, color, fallVel: null, fallAge: 0, visible: true };
  }

  return {
    setRadius(r) {
      if (Math.abs(r - radius) < 1e-4) return;
      radius = r;
      applyRadius();
    },
    setPuck(id, v) {
      let p = pucks.get(id);
      if (!p) {
        p = makePuck(id, v.color);
        pucks.set(id, p);
      }
      if (p.color !== v.color) {
        p.color = v.color;
        p.body.render!.meshInstances.forEach((mi) => (mi.material = puckMats[v.color % puckMats.length]!));
      }
      p.ring.enabled = v.me;
      if (v.visible) {
        // Back on the platform (new round): cancel any fall.
        p.fallVel = null;
        p.fallAge = 0;
        p.root.setLocalEulerAngles(0, 0, 0);
        p.root.setPosition(v.x, 0, v.y);
        p.root.enabled = true;
      } else if (!p.fallVel) {
        p.root.enabled = false;
      }
      p.visible = v.visible;
    },
    fall(id, vx, vy) {
      const p = pucks.get(id);
      if (!p || p.fallVel) return;
      const len = Math.hypot(vx, vy);
      // Always drift outwards a bit so a slow tip-over still clears the edge visually.
      const pos = p.root.getPosition();
      const out = Math.hypot(pos.x, pos.z) || 1;
      p.fallVel = new Vec3(vx * 0.8 + (pos.x / out) * 2, 2, vy * 0.8 + (pos.z / out) * 2);
      if (len > 12) p.fallVel.mulScalar(12 / len);
      p.fallAge = 0;
      p.root.enabled = true;
    },
    removePuck(id) {
      const p = pucks.get(id);
      if (!p) return;
      p.root.destroy();
      pucks.delete(id);
    },
    flash(x, y, strength) {
      if (!fx) return;
      if (flashes.length >= MAX_FLASHES) {
        const old = flashes.shift()!;
        old.e.destroy();
        old.mat.destroy();
      }
      const mat = flashMat.clone();
      mat.opacity = 0.9;
      mat.update();
      const e = new Entity('flash');
      e.addComponent('render', { type: 'cylinder', material: mat, castShadows: false });
      e.setPosition(x, 0.05, y);
      app.root.addChild(e);
      flashes.push({ e, mat, age: 0, size: 1 + Math.min(strength, 14) * 0.18 });
    },
    shake(amount) {
      if (!fx || !shakeOn) return;
      shakeAmp = Math.min(0.9, Math.max(shakeAmp, amount));
    },
    labelAnchor(id, out) {
      const p = pucks.get(id);
      if (!p || !p.root.enabled || p.fallAge > 0.5) return false;
      const pos = p.root.getPosition();
      tmp.set(pos.x, pos.y + PUCK_HEIGHT + 0.9, pos.z);
      const s = camera.camera!.worldToScreen(tmp);
      out.x = s.x;
      out.y = s.y;
      return true;
    },
    update(dt) {
      for (const p of pucks.values()) {
        if (!p.fallVel) continue;
        p.fallAge += dt;
        p.fallVel.y -= FALL_GRAVITY * dt;
        const pos = p.root.getPosition();
        p.root.setPosition(pos.x + p.fallVel.x * dt, pos.y + p.fallVel.y * dt, pos.z + p.fallVel.z * dt);
        p.root.setLocalEulerAngles(p.fallAge * 220, 0, p.fallAge * 140);
        if (p.fallAge > 1.6) {
          p.root.enabled = false;
          p.fallVel = null;
        }
      }
      flashes = flashes.filter((f) => {
        f.age += dt;
        const u = f.age / 0.35;
        if (u >= 1) {
          f.e.destroy();
          f.mat.destroy();
          return false;
        }
        const s = f.size * (0.6 + u * 1.8);
        f.e.setLocalScale(s, 0.02, s);
        f.mat.opacity = 0.9 * (1 - u);
        f.mat.update();
        return true;
      });
      if (shakeAmp > 0.001) {
        shakeOffset.set(
          (Math.random() - 0.5) * 2 * shakeAmp,
          (Math.random() - 0.5) * shakeAmp,
          (Math.random() - 0.5) * 2 * shakeAmp,
        );
        shakeAmp *= Math.exp(-dt * 14);
      } else {
        shakeOffset.set(0, 0, 0);
        shakeAmp = 0;
      }
      tmp.copy(camBase).add(shakeOffset);
      camera.setPosition(tmp);
    },
    trim() {
      for (const f of flashes) {
        f.e.destroy();
        f.mat.destroy();
      }
      flashes = [];
    },
    setQuality(q) {
      sun.light!.castShadows = q.shadows;
      fx = q.effects;
      shakeOn = q.shake;
      if (!fx || !shakeOn) shakeAmp = 0;
    },
  };
}
