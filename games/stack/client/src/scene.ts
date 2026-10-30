import { type Application, BLEND_ADDITIVEALPHA, Color, Entity, PROJECTION_ORTHOGRAPHIC, SHADOW_PCF5_16F, StandardMaterial, Vec3 } from 'playcanvas';
import { BASE_SIZE, LAYER_HEIGHT, type Slab } from './sim.ts';

/** Matches the app's near-black background. */
const BG = new Color(10 / 255, 10 / 255, 10 / 255);
/** Layers kept as entities below the top (older ones are far below the camera). */
const KEEP_LAYERS = 56;
const KEEP_LAYERS_LOW_MEMORY = 36;
const MAX_DEBRIS = 8;
const GRAVITY = 22;
const BASE_COLUMN = 30;

interface Debris {
  e: Entity;
  mat: StandardMaterial;
  vel: Vec3;
  spin: Vec3;
  age: number;
}

export interface StackScene {
  /** Start a fresh tower (base slab only). `baseHue` in degrees. */
  reset(baseHue: number): void;
  /** Add a placed slab to the tower. */
  place(slab: Slab, perfect: boolean): void;
  /** Where the slider is drawn this frame (null hides it). */
  setSlider(slab: Slab | null): void;
  /** A cut-off piece (or the whole missed slab) that falls away. */
  spawnDebris(slab: Slab, awayDir: number): void;
  /** Camera framing: follow the top, or pull back to show the tower after game over. */
  setOverview(on: boolean, height: number): void;
  /** Per-frame animation; `dt` is game time (0 while paused). */
  update(dt: number): void;
  /** Drop non-essential allocations (lowMemory). */
  trim(): void;
  readonly entityCount: number;
}

export function hueColor(hue: number, light = 0.6): Color {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = 0.55;
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return new Color(f(0), f(8), f(4));
}

function flatMaterial(color: Color): StandardMaterial {
  const m = new StandardMaterial();
  m.diffuse = color;
  m.specular = new Color(0, 0, 0);
  m.gloss = 0;
  m.useMetalness = false;
  m.update();
  return m;
}

export function createStackScene(app: Application): StackScene {
  app.scene.ambientLight = new Color(0.5, 0.5, 0.55);

  // Orthographic, isometric-ish camera: the classic Stack look and no perspective distortion while it rises.
  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: BG,
    projection: PROJECTION_ORTHOGRAPHIC,
    orthoHeight: 9,
    nearClip: 0.1,
    farClip: 200,
  });
  app.root.addChild(camera);
  const CAM_DIR = new Vec3(1, 0.95, 1).normalize().mulScalar(40);

  const sun = new Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.98, 0.95),
    intensity: 0.85,
    castShadows: true,
    shadowType: SHADOW_PCF5_16F,
    shadowBias: 0.3,
    normalOffsetBias: 0.06,
    shadowResolution: 1024,
    shadowDistance: 40,
    shadowIntensity: 0.45,
  });
  sun.setEulerAngles(55, -25, 0);
  app.root.addChild(sun);

  const towerRoot = new Entity('tower');
  app.root.addChild(towerRoot);
  const tower: { e: Entity; mat: StandardMaterial; layer: number }[] = [];
  let keepLayers = KEEP_LAYERS;
  let baseHue = 200;
  const hueOf = (layer: number) => baseHue + layer * 5;

  const sliderMat = flatMaterial(hueColor(baseHue));
  const slider = new Entity('slider');
  slider.addComponent('render', { type: 'box', material: sliderMat, castShadows: true, receiveShadows: true });
  app.root.addChild(slider);
  let sliderLayer = -1;

  // Perfect-drop flash: a thin additive plate that expands and fades around the placed slab.
  const flashMat = new StandardMaterial();
  flashMat.diffuse = new Color(0, 0, 0);
  flashMat.emissive = new Color(1, 1, 1);
  flashMat.useLighting = false;
  flashMat.blendType = BLEND_ADDITIVEALPHA;
  flashMat.depthWrite = false;
  flashMat.opacity = 0;
  flashMat.update();
  const flash = new Entity('flash');
  flash.addComponent('render', { type: 'box', material: flashMat, castShadows: false });
  flash.enabled = false;
  app.root.addChild(flash);
  let flashAge = 1;
  let flashSize = { w: 1, d: 1 };

  let debris: Debris[] = [];

  let camY = 0;
  let orthoH = 9;
  let overview = false;
  let overviewHeight = 0;
  let topY = 0;

  const yOf = (layer: number) => layer * LAYER_HEIGHT;

  function addTowerSlab(slab: Slab) {
    const mat = flatMaterial(hueColor(hueOf(slab.layer)));
    const e = new Entity(`slab-${slab.layer}`);
    e.addComponent('render', { type: 'box', material: mat, castShadows: true, receiveShadows: true });
    if (slab.layer === 0) {
      // The base is a tall column so the tower never shows a floating bottom.
      e.setLocalScale(slab.w, BASE_COLUMN, slab.d);
      e.setPosition(slab.x, LAYER_HEIGHT / 2 - BASE_COLUMN / 2, slab.z);
    } else {
      e.setLocalScale(slab.w, LAYER_HEIGHT, slab.d);
      e.setPosition(slab.x, yOf(slab.layer), slab.z);
    }
    towerRoot.addChild(e);
    tower.push({ e, mat, layer: slab.layer });
    topY = yOf(slab.layer);
    prune();
  }

  function prune() {
    const top = tower.length ? tower[tower.length - 1]!.layer : 0;
    while (tower.length > 0 && tower[0]!.layer < top - keepLayers) {
      const t = tower.shift()!;
      t.e.destroy();
      t.mat.destroy();
    }
  }

  function clearDebris() {
    for (const d of debris) {
      d.e.destroy();
      d.mat.destroy();
    }
    debris = [];
  }

  function frame(width: number, height: number) {
    const aspect = width / Math.max(1, height);
    // Fit the slider's full travel horizontally in portrait; never zoom in closer than 8 units.
    return Math.max(8, 5.4 / aspect);
  }

  const scene: StackScene = {
    get entityCount() {
      return tower.length + debris.length + 2;
    },
    reset(hue) {
      baseHue = hue;
      for (const t of tower) {
        t.e.destroy();
        t.mat.destroy();
      }
      tower.length = 0;
      clearDebris();
      flash.enabled = false;
      overview = false;
      addTowerSlab({ x: 0, z: 0, w: BASE_SIZE, d: BASE_SIZE, layer: 0 });
      sliderLayer = -1;
      camY = topY;
    },
    place(slab, perfect) {
      addTowerSlab(slab);
      if (perfect) {
        flashAge = 0;
        flashSize = { w: slab.w, d: slab.d };
        flash.enabled = true;
        flash.setPosition(slab.x, yOf(slab.layer) - LAYER_HEIGHT / 2 + 0.01, slab.z);
      }
    },
    setSlider(slab) {
      slider.enabled = slab !== null;
      if (!slab) return;
      if (slab.layer !== sliderLayer) {
        sliderLayer = slab.layer;
        sliderMat.diffuse = hueColor(hueOf(slab.layer));
        sliderMat.update();
      }
      slider.setLocalScale(slab.w, LAYER_HEIGHT, slab.d);
      slider.setPosition(slab.x, yOf(slab.layer), slab.z);
    },
    spawnDebris(slab, awayDir) {
      if (debris.length >= MAX_DEBRIS) {
        const old = debris.shift()!;
        old.e.destroy();
        old.mat.destroy();
      }
      const mat = flatMaterial(hueColor(hueOf(slab.layer)));
      const e = new Entity('debris');
      e.addComponent('render', { type: 'box', material: mat, castShadows: true });
      e.setLocalScale(slab.w, LAYER_HEIGHT, slab.d);
      e.setPosition(slab.x, yOf(slab.layer), slab.z);
      app.root.addChild(e);
      const alongX = slab.d >= slab.w ? 0 : 1;
      debris.push({
        e,
        mat,
        vel: new Vec3(alongX ? awayDir * 1.2 : 0, 0.5, alongX ? 0 : awayDir * 1.2),
        spin: new Vec3(alongX ? 0 : awayDir * 90, 0, alongX ? -awayDir * 90 : 0),
        age: 0,
      });
    },
    setOverview(on, height) {
      overview = on;
      overviewHeight = height;
    },
    update(dt) {
      const gd = app.graphicsDevice;
      const baseOrtho = frame(gd.width, gd.height);
      // Exponential smoothing on game time: identical at 30/60/120 Hz and frozen while paused.
      const k = 1 - Math.exp(-dt * 5);
      // Game over: fit the (kept part of the) tower into the upper part of the screen, above the result card.
      // World height shows at ~0.83 of its size on screen (camera pitch ~34°).
      const shown = Math.min(overviewHeight, keepLayers - 6) * LAYER_HEIGHT;
      const wantOrtho = overview ? Math.max(baseOrtho, shown * 0.85 + 3) : baseOrtho;
      const wantY = overview ? topY - shown / 2 - (0.3 * wantOrtho) / 0.83 : topY + baseOrtho * 0.12;
      orthoH += (wantOrtho - orthoH) * (dt > 0 ? k : 0);
      camY += (wantY - camY) * (dt > 0 ? k : 0);
      if (camera.camera!.orthoHeight !== orthoH) camera.camera!.orthoHeight = orthoH;
      camera.setPosition(CAM_DIR.x, camY + CAM_DIR.y, CAM_DIR.z);
      camera.lookAt(0, camY, 0);

      for (let i = debris.length - 1; i >= 0; i--) {
        const d = debris[i]!;
        d.age += dt;
        d.vel.y -= GRAVITY * dt;
        const p = d.e.getPosition();
        d.e.setPosition(p.x + d.vel.x * dt, p.y + d.vel.y * dt, p.z + d.vel.z * dt);
        d.e.rotateLocal(d.spin.x * dt, d.spin.y * dt, d.spin.z * dt);
        if (d.age > 2.5) {
          d.e.destroy();
          d.mat.destroy();
          debris.splice(i, 1);
        }
      }

      if (flash.enabled) {
        flashAge += dt;
        const t = Math.min(1, flashAge / 0.45);
        const grow = 0.15 + t * 0.6;
        flash.setLocalScale(flashSize.w + grow, 0.02, flashSize.d + grow);
        flashMat.opacity = (1 - t) * 0.55;
        flashMat.update();
        if (t >= 1) flash.enabled = false;
      }
    },
    trim() {
      keepLayers = KEEP_LAYERS_LOW_MEMORY;
      prune();
      clearDebris();
      sun.light!.shadowResolution = 512;
    },
  };

  scene.reset(baseHue);
  return scene;
}
