import {
  type Application,
  BLEND_ADDITIVEALPHA,
  BLEND_NORMAL,
  Color,
  CULLFACE_NONE,
  Entity,
  GAMMA_SRGB,
  type GraphNode,
  type Mesh,
  MeshInstance,
  SHADOW_PCF3_16F,
  StandardMaterial,
  TONEMAP_NEUTRAL,
  Vec3,
} from 'playcanvas';
import { FxBatch } from './fx.ts';
import { Geo, hex, type RGB } from './geo.ts';
import { buildPaper } from './paper.ts';
import { buildRoom, fanBlades, type RoomKit, type RoomView, stampHalo, stampMesh } from './rooms.ts';
import { ROOM_H, type Form, type FoldSim, type SimEvent } from './sim.ts';
import {
  artAtlas,
  floorboards,
  fxAtlas,
  fxCell,
  FX_DOT,
  FX_PUFF,
  FX_RING,
  FX_STAR,
  STAMP_KINDS,
  stampAtlas,
  stampCell,
  THEMES,
  wallpaper,
} from './textures.ts';

/**
 * The renderer: a cosy side-on house interior seen through a slightly raised perspective camera that follows the
 * plane. Rooms are built from merged procedural meshes when they enter `sim.rooms` and destroyed when they leave
 * (rooms.ts); the plane is folded paper (paper.ts); steam, heat, wind, dust and sparkles are pooled particle quads
 * (fx.ts).
 */
export interface FoldScene {
  /** A new run: forget the old rooms and effects. */
  reset(sim: FoldSim): void;
  /** Per frame: interpolate the plane (sim.alpha), build / drop room meshes as sim.rooms changes, follow with the
   *  camera. `dt` is game time (0 while paused). */
  sync(sim: FoldSim, dt: number): void;
  /** Effects for a sim event (refold, flap, stamp, skid, crash …). */
  event(e: SimEvent, sim: FoldSim): void;
  /** World (x, y, z) to CSS px on the canvas. */
  project(x: number, y: number, z: number, out: { x: number; y: number }): void;
  /** Drop non-essential work (lowMemory). */
  trim(): void;
  readonly entityCount: number;
}

// --- camera framing ---------------------------------------------------------------------------------------
/** Vertical field of view (degrees). */
const FOV = 40;
/** Downward tilt (degrees). */
const TILT = 7;
/** Heights kept in view at z = 0: the floor and the ceiling with a margin (the HUD sits over the top edge). */
const VIEW_LO = -0.35;
const VIEW_HI = 6.65;
/** At least this much of the lane (m) is in view across, on narrow screens. */
const MIN_VIEW_W = 12.5;
/** Where the plane sits across the screen (0 = left edge): far enough in to clear the shape chips, room ahead. */
const PLANE_AT = 0.36;
/** The camera never shows the house left of this. */
const LEFT_EDGE = -0.75;
const FOLLOW = 6;

// --- the plane ----------------------------------------------------------------------------------------------
/** The plane is rolled toward the camera so its wings read from the side. */
const ROLL = 18;
/** Drawn a little larger than its collision box so it reads on a phone. */
const PLANE_SCALE = 1.3;
const FORM_TIME = 0.16;
const FLAP_TIME = 0.3;
const WING_UP = 62;
const WING_DOWN = -12;
const BALL_R = 0.21;
const BALL_SCALE = 1.35;
const PAPER_SOGGY = new Color(0.62, 0.71, 0.84);

const DUST: RGB = hex('#cdb595');
const STEAM: RGB = hex('#ffffff');
const HEAT: RGB = hex('#ffab5e');
const GOLD: RGB = hex('#ffd36a');
const WATER: RGB = hex('#8fbbe6');
const PLASTER: RGB = hex('#f1e8d8');
const SKY: RGB = hex('#bfe0ff');

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Vertex colours are authored as sRGB bytes (geo.ts); the material decodes them to linear. (`vertexColorGamma` is a
 * StandardMaterial flag that playcanvas.d.ts does not declare.)
 */
function srgbVertexColors(m: StandardMaterial) {
  (m as unknown as { vertexColorGamma: boolean }).vertexColorGamma = true;
}

function countEntities(node: GraphNode): number {
  let n = 1;
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) n += countEntities(kids[i]!);
  return n;
}

export function createFoldScene(app: Application, opts: { shadows?: boolean } = {}): FoldScene {
  const device = app.graphicsDevice;
  const shadows = opts.shadows ?? true;

  // --- lights and camera ----------------------------------------------------------------------------------
  app.scene.ambientLight = new Color(0.52, 0.46, 0.42);
  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: new Color(0.23, 0.17, 0.145),
    fov: FOV,
    nearClip: 1,
    farClip: 80,
    gammaCorrection: GAMMA_SRGB,
    toneMapping: TONEMAP_NEUTRAL,
  });
  app.root.addChild(camera);
  const sun = new Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.93, 0.82),
    intensity: 1.2,
    castShadows: shadows,
    shadowType: SHADOW_PCF3_16F,
    shadowBias: 0.2,
    normalOffsetBias: 0.05,
    shadowResolution: 2048,
    shadowDistance: 26,
    shadowIntensity: 0.42,
  });
  // From the upper front left: the sides of what is coming (the camera sees their left faces) are lit, and shadows
  // fall on the back wall a little right of and below what casts them.
  sun.setEulerAngles(58, -22, 0);
  app.root.addChild(sun);
  const world = new Entity('world');
  app.root.addChild(world);

  // --- materials (shared by every room) -------------------------------------------------------------------
  const vertexLit = (gloss: number, spec: number) => {
    const m = new StandardMaterial();
    m.diffuse = new Color(1, 1, 1);
    m.diffuseVertexColor = true;
    srgbVertexColors(m);
    m.useMetalness = false;
    m.specular = new Color(spec, spec, spec);
    m.gloss = gloss;
    m.update();
    return m;
  };
  const shellMat = vertexLit(0.15, 0.02);
  const propsMat = vertexLit(0.5, 0.12);
  const walls = THEMES.map((_, i) => {
    const m = vertexLit(0.1, 0);
    m.diffuseMap = wallpaper(device, i);
    m.update();
    return m;
  });
  const floorMat = vertexLit(0.55, 0.12);
  floorMat.diffuseMap = floorboards(device);
  floorMat.update();
  const artMat = vertexLit(0.4, 0.05);
  artMat.diffuseMap = artAtlas(device);
  artMat.emissiveMap = artMat.diffuseMap;
  artMat.emissive = new Color(0.22, 0.22, 0.22);
  artMat.update();
  const fx = fxAtlas(device);
  const fxMat = (blend: number) => {
    const m = new StandardMaterial();
    m.useLighting = false;
    m.diffuse = new Color(0, 0, 0);
    m.emissive = new Color(1, 1, 1);
    m.emissiveVertexColor = true;
    srgbVertexColors(m);
    m.opacityMap = fx;
    m.opacityMapChannel = 'a';
    m.opacityVertexColor = true;
    m.opacityVertexColorChannel = 'a';
    m.blendType = blend;
    m.depthWrite = false;
    m.cull = CULLFACE_NONE;
    m.update();
    return m;
  };
  const glowMat = fxMat(BLEND_ADDITIVEALPHA);
  const puffMat = fxMat(BLEND_NORMAL);
  const stampTex = stampAtlas(device);
  const stampMat = new StandardMaterial();
  stampMat.diffuseMap = stampTex;
  stampMat.opacityMap = stampTex;
  stampMat.opacityMapChannel = 'a';
  stampMat.alphaTest = 0.5;
  stampMat.emissiveMap = stampTex;
  stampMat.emissive = new Color(0.4, 0.4, 0.4);
  stampMat.cull = CULLFACE_NONE;
  stampMat.twoSidedLighting = true;
  stampMat.useMetalness = false;
  stampMat.gloss = 0.3;
  stampMat.update();
  const paperMat = vertexLit(0.3, 0.05);
  paperMat.cull = CULLFACE_NONE;
  paperMat.twoSidedLighting = true;
  paperMat.emissive = new Color(0.1, 0.1, 0.1);
  paperMat.update();
  const soggyMat = vertexLit(0.5, 0.15);
  soggyMat.diffuse = PAPER_SOGGY;
  soggyMat.cull = CULLFACE_NONE;
  soggyMat.twoSidedLighting = true;
  soggyMat.update();
  const blobMat = new StandardMaterial();
  blobMat.useLighting = false;
  blobMat.diffuse = new Color(0, 0, 0);
  blobMat.emissive = new Color(0.08, 0.05, 0.03);
  blobMat.opacityMap = fx;
  blobMat.opacityMapChannel = 'a';
  blobMat.opacity = 0.4;
  blobMat.blendType = BLEND_NORMAL;
  blobMat.depthWrite = false;
  blobMat.update();

  const kit: RoomKit = {
    device,
    shell: shellMat,
    props: propsMat,
    walls,
    floor: floorMat,
    art: artMat,
    glow: glowMat,
    stamp: stampMat,
    stampMeshes: Array.from({ length: STAMP_KINDS }, (_, k) => stampMesh(device, stampCell(k))),
    stampHalo: stampHalo(device),
    fanBlades: fanBlades(device),
    shadows,
    decor: true,
  };

  // --- the plane ----------------------------------------------------------------------------------------
  const paper = buildPaper(device);
  const formMesh: Record<Form, Mesh> = { dart: paper.dart, glider: paper.glider, crane: paper.craneBody };
  const part = (parent: Entity, name: string, mesh: Mesh, material: StandardMaterial) => {
    const e = new Entity(name);
    e.addComponent('render', { castShadows: shadows, receiveShadows: false });
    const mi = new MeshInstance(mesh, material);
    e.render!.meshInstances = [mi];
    e.render!.castShadows = shadows;
    e.render!.receiveShadows = false;
    parent.addChild(e);
    return { e, mi };
  };
  const planeRoot = new Entity('plane');
  world.addChild(planeRoot);
  const body = part(planeRoot, 'plane-body', paper.glider, paperMat);
  const wingNear = part(body.e, 'wing-near', paper.craneWingNear, paperMat);
  const wingFar = part(body.e, 'wing-far', paper.craneWingFar, paperMat);
  wingNear.e.setLocalPosition(0, 0.06, 0);
  wingFar.e.setLocalPosition(0, 0.06, 0);
  const ball = part(world, 'paper-ball', paper.ball, paperMat);
  ball.e.enabled = false;

  const blobGeo = new Geo();
  const [bu0, bv0, bu1, bv1] = fxCell(FX_DOT);
  blobGeo.rectY(-0.5, -0.5, 0.5, 0.5, 0, false, bu0, bv0, bu1, bv1);
  const blobMesh = blobGeo.build(device)!;
  const blob = new Entity('blob-shadow');
  blob.addComponent('render', { castShadows: false, receiveShadows: false });
  const blobMI = new MeshInstance(blobMesh, blobMat);
  blob.render!.meshInstances = [blobMI];
  blob.render!.castShadows = false;
  world.addChild(blob);

  // --- particles ----------------------------------------------------------------------------------------
  const puffs = new FxBatch(device, puffMat, 120, world, 'fx-puffs');
  const sparks = new FxBatch(device, glowMat, 96, world, 'fx-sparks');
  let particles = true;

  // --- state ----------------------------------------------------------------------------------------------
  const views: RoomView[] = [];
  /** The sim the views were built for (a new sim means a new house, even without `reset`). */
  let viewsOf: FoldSim | null = null;
  let time = 0;
  let camX = 0;
  let planeVX = 0;
  let snap = true;
  let shake = 0;
  let nudge = 0;
  let pitch = 0;
  let shownForm: Form = 'glider';
  let formT = FORM_TIME;
  let flapT = FLAP_TIME;
  let soggyShown = false;
  let skidAcc = 0;
  let dripAcc = 0;
  const crash = { on: false, x: 0, y: 0, vx: 0, vy: 0, spin: 0, t: 0 };
  let viewLeft = -10;
  let viewRight = 10;
  const camPos = new Vec3();
  const projIn = new Vec3();
  const projOut = new Vec3();

  const overPit = (x: number) => {
    for (let i = 0; i < views.length; i++) {
      const pits = views[i]!.pits;
      for (let k = 0; k < pits.length; k++) if (x > pits[k]!.x0 && x < pits[k]!.x1) return true;
    }
    return false;
  };

  const setForm = (form: Form) => {
    shownForm = form;
    body.mi.mesh = formMesh[form];
    wingNear.e.enabled = wingFar.e.enabled = form === 'crane';
    body.e.setLocalPosition(0, form === 'crane' ? -0.05 : 0, 0);
  };

  const setSoggy = (on: boolean) => {
    soggyShown = on;
    const m = on ? soggyMat : paperMat;
    body.mi.material = m;
    wingNear.mi.material = m;
    wingFar.mi.material = m;
    ball.mi.material = m;
  };

  const clearRooms = () => {
    for (const v of views) v.root.destroy();
    views.length = 0;
  };

  const rnd = Math.random;

  /** A ring of sparkles (stamps, stairwells). */
  const sparkle = (x: number, y: number, color: RGB, n: number, ring: boolean) => {
    if (!particles) return;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rnd() * 0.4;
      const sp = 1.6 + rnd() * 1.4;
      const i = sparks.spawn(FX_STAR, x, y, 0.1, Math.cos(a) * sp, Math.sin(a) * sp, 0.45 + rnd() * 0.25, 0.22, 0.05);
      sparks.look(i, k % 2 ? color : STEAM, 1);
      sparks.motion(i, -1.5, 3, 0, (rnd() - 0.5) * 8, rnd() * 3);
    }
    if (ring) {
      const i = sparks.spawn(FX_RING, x, y, 0.1, 0, 0, 0.35, 0.3, 1.5);
      sparks.look(i, color, 0.9);
    }
  };

  const dust = (x: number, y: number, n: number, spread: number) => {
    if (!particles) return;
    for (let k = 0; k < n; k++) {
      const i = puffs.spawn(
        FX_PUFF,
        x + (rnd() - 0.5) * spread,
        y,
        0.15,
        (rnd() - 0.6) * 1.2,
        0.3 + rnd() * 0.5,
        0.55 + rnd() * 0.3,
        0.12,
        0.45,
      );
      puffs.look(i, DUST, 0.55);
      puffs.motion(i, 0, 2.2, 0, (rnd() - 0.5) * 2, rnd() * 6);
    }
  };

  const emitZones = (dt: number) => {
    for (let v = 0; v < views.length; v++) {
      const view = views[v]!;
      if (view.x1 < viewLeft - 1 || view.x0 > viewRight + 1) continue;
      const em = view.emitters;
      for (let k = 0; k < em.length; k++) {
        const z = em[k]!;
        if (z.x1 < viewLeft - 1 || z.x0 > viewRight + 1) continue;
        const rate = z.kind === 'steam' ? 13 : z.kind === 'heat' ? 12 : 12;
        z.acc += rate * dt;
        while (z.acc >= 1) {
          z.acc -= 1;
          if (z.kind === 'steam') {
            const i = puffs.spawn(
              FX_PUFF,
              z.sx + (rnd() - 0.5) * 0.18,
              z.sy + 0.02,
              0.05,
              0.06 + (rnd() - 0.5) * 0.25,
              1 + rnd() * 0.5,
              2.6 + rnd() * 0.9,
              0.22,
              1.05,
            );
            puffs.look(i, STEAM, 0.55);
            puffs.motion(i, 0.25, 0.25, 0.09, (rnd() - 0.5) * 1.2, rnd() * 6);
          } else if (z.kind === 'heat') {
            // Shimmering streaks and warm motes rising from the radiator.
            const tall = rnd() < 0.55;
            const batch = tall ? puffs : sparks;
            const i = batch.spawn(
              FX_DOT,
              z.x0 + 0.3 + rnd() * (z.x1 - z.x0 - 0.6),
              z.y0 + rnd() * 0.3,
              0.02,
              0,
              1.1 + rnd() * 0.8,
              1.5 + rnd() * 0.8,
              tall ? 0.5 : 0.1,
              tall ? 0.95 : 0.24,
            );
            batch.look(i, HEAT, tall ? 0.3 : 0.7, tall ? 0.12 : 1);
            batch.motion(i, 0.4, 0.15, 0.09);
          } else {
            const x = z.x0 + rnd() * (z.x1 - z.x0);
            const cx = (z.x0 + z.x1) / 2;
            const i = puffs.spawn(
              FX_DOT,
              x,
              4.2 + rnd() * 1.2,
              0.1 + (rnd() - 0.5) * 0.8,
              (x - cx) * 0.35,
              -3.6 - rnd() * 1.6,
              0.9,
              0.6,
              0.95,
            );
            puffs.look(i, STEAM, 0.42, 0.075);
          }
        }
      }
    }
  };

  const scene: FoldScene = {
    get entityCount() {
      return countEntities(world) + 2;
    },

    reset(sim) {
      clearRooms();
      puffs.clear();
      sparks.clear();
      crash.on = false;
      ball.e.enabled = false;
      planeRoot.enabled = true;
      formT = FORM_TIME;
      flapT = FLAP_TIME;
      pitch = 0;
      shake = nudge = 0;
      planeVX = 0;
      snap = true;
      setForm(sim.plane.form);
      setSoggy(false);
      scene.sync(sim, 0);
    },

    sync(sim, dt) {
      time += dt;

      // Rooms in and out (sim.rooms only ever drops from the front and adds at the back). New rooms appear far ahead
      // of the plane, so outside a reset at most one is built per frame (no hitch when several arrive together).
      if (sim !== viewsOf) {
        clearRooms();
        viewsOf = sim;
        snap = true;
      }
      const rooms = sim.rooms;
      const first = rooms.length ? rooms[0]!.index : 0;
      const last = rooms.length ? rooms[rooms.length - 1]!.index : -1;
      while (views.length && views[0]!.index < first) views.shift()!.root.destroy();
      while (views.length && views[views.length - 1]!.index > last) views.pop()!.root.destroy();
      let have = views.length ? views[views.length - 1]!.index : -Infinity;
      let budget = snap || views.length < 2 ? Infinity : 1;
      for (let i = 0; i < rooms.length && budget > 0; i++) {
        const room = rooms[i]!;
        if (room.index > have) {
          budget--;
          views.push(buildRoom(room, kit, world));
          have = room.index;
        }
      }

      // The plane.
      const p = sim.plane;
      const a = sim.alpha;
      const x = p.px + (p.x - p.px) * a;
      let y = p.py + (p.y - p.py) * a;
      if (sim.phase === 'ready') y += Math.sin(time * 2.2) * 0.06;
      if (dt > 0) {
        const vx = sim.phase === 'playing' ? p.vx : 0;
        planeVX += (vx - planeVX) * (1 - Math.exp(-dt * 4));
        const target = clamp(Math.atan2(p.vy, Math.max(0.5, p.vx)), -0.62, 0.55);
        pitch += (target - pitch) * (1 - Math.exp(-dt * 12));
      }
      if (p.soggy > 0 !== soggyShown) setSoggy(p.soggy > 0);
      let roll = ROLL + Math.sin(time * 1.7) * 2.5;
      let sx = 1,
        sy = 1,
        sz = 1;
      if (formT < FORM_TIME) {
        formT += dt;
        const t = Math.min(1, formT / FORM_TIME);
        const s = Math.sin(t * Math.PI);
        sx = 1 - 0.45 * s;
        sy = 1 + 0.5 * s;
        sz = 1 - 0.55 * s;
        roll += s * 50;
        if (t >= 0.5 && shownForm !== p.form) setForm(p.form);
      } else if (shownForm !== p.form) setForm(p.form);
      planeRoot.setLocalPosition(x, y, 0);
      planeRoot.setLocalEulerAngles(roll, 0, (pitch * 180) / Math.PI);
      planeRoot.setLocalScale(sx * PLANE_SCALE, sy * PLANE_SCALE, sz * PLANE_SCALE);
      if (shownForm === 'crane') {
        let up = WING_UP + Math.sin(time * 3) * 4;
        if (flapT < FLAP_TIME) {
          flapT += dt;
          const t = Math.min(1, flapT / FLAP_TIME);
          up =
            t < 0.35
              ? WING_UP + (WING_DOWN - WING_UP) * ease(t / 0.35)
              : WING_DOWN + (WING_UP - WING_DOWN) * ease((t - 0.35) / 0.65);
        }
        wingNear.e.setLocalEulerAngles(-up, 0, 0);
        wingFar.e.setLocalEulerAngles(up, 0, 0);
      }

      // Crash: the crumpled ball drops, bounces and rolls (or falls down the stairwell).
      let shadowX = x,
        shadowY = y;
      if (crash.on) {
        if (dt > 0) {
          crash.t += dt;
          crash.vy -= 14 * dt;
          crash.x += crash.vx * dt;
          crash.y += crash.vy * dt;
          if (crash.y < BALL_R && !overPit(crash.x)) {
            crash.y = BALL_R;
            if (crash.vy < -0.9) {
              crash.vy = -crash.vy * 0.42;
              crash.vx *= 0.7;
              dust(crash.x, 0.05, 2, 0.2);
            } else {
              crash.vy = 0;
              crash.vx *= Math.max(0, 1 - 3 * dt);
            }
          }
          crash.spin -= (crash.vx / BALL_R) * dt;
          if (crash.y < -4) ball.e.enabled = false;
        }
        const pop = Math.min(1, crash.t / 0.12);
        const s = (0.4 + 0.6 * pop + Math.sin(pop * Math.PI) * 0.2) * BALL_SCALE;
        ball.e.setLocalPosition(crash.x, crash.y, 0);
        ball.e.setLocalEulerAngles(20, 30, (crash.spin * 180) / Math.PI);
        ball.e.setLocalScale(s, s, s);
        shadowX = crash.x;
        shadowY = crash.y;
      }

      // Soft blob shadow under the plane (or the ball), not over a stairwell.
      const blobOn = (crash.on ? ball.e.enabled : true) && shadowY > -0.2 && !overPit(shadowX);
      blob.enabled = blobOn;
      if (blobOn) {
        const h = Math.max(0, shadowY);
        const s = 0.8 + h * 0.1;
        blob.setLocalPosition(shadowX, 0.012, 0);
        blob.setLocalScale(s, 1, s * 0.55);
        blobMI.setParameter('material_opacity', clamp(0.62 - h * 0.06, 0.22, 0.62));
      }

      // Camera framing: the room's full height at z = 0 in view, the plane a third of the way in.
      const aspect = device.width / Math.max(1, device.height);
      const tanHalf = Math.tan(((FOV / 2) * Math.PI) / 180);
      const half = (VIEW_HI - VIEW_LO) / 2,
        yc = (VIEW_HI + VIEW_LO) / 2;
      const tilt = (TILT * Math.PI) / 180;
      const cos = Math.cos(tilt),
        sin = Math.sin(tilt);
      const dist = Math.max((half * cos) / tanHalf + half * sin, MIN_VIEW_W / (2 * tanHalf * aspect));
      const halfW = dist * tanHalf * aspect;
      const focusX = crash.on ? Math.min(crash.x, x + 3) : x;
      const target = Math.max(focusX + (0.5 - PLANE_AT) * 2 * halfW, LEFT_EDGE + halfW);
      if (snap || Math.abs(target - camX) > 25) {
        camX = target;
        snap = false;
      } else if (dt > 0) {
        const lead = crash.on ? 0 : planeVX / FOLLOW;
        camX += (target + lead - camX) * (1 - Math.exp(-dt * FOLLOW));
      }
      viewLeft = camX - halfW;
      viewRight = camX + halfW;
      if (dt > 0) {
        shake *= Math.exp(-dt * 6);
        nudge *= Math.exp(-dt * 14);
      }
      const ox = Math.sin(time * 47) * shake;
      const oy = Math.cos(time * 39) * shake * 0.7 + nudge;
      camPos.set(camX + ox, yc + dist * sin + oy, dist * cos);
      camera.setPosition(camPos);
      camera.setEulerAngles(-TILT, 0, 0);

      // Stamps bob and sway; taken ones disappear. Fan blades spin.
      for (let v = 0; v < views.length; v++) {
        const view = views[v]!;
        const visible = view.x1 > viewLeft - 2 && view.x0 < viewRight + 2;
        const st = view.stamps;
        for (let k = 0; k < st.length; k++) {
          const s = st[k]!;
          if (s.s.taken) {
            if (s.e.enabled) s.e.enabled = false;
            continue;
          }
          if (!visible) continue;
          s.e.setLocalPosition(s.s.x, s.s.y + Math.sin(time * 2.4 + s.phase) * 0.08, 0);
          s.e.setLocalEulerAngles(0, Math.sin(time * 1.6 + s.phase) * 30, Math.sin(time * 2.1 + s.phase) * 7);
          // Now and then a twinkle, so stamps read as things to collect rather than pictures on the wall.
          if (particles && dt > 0 && rnd() < dt * 1.3) {
            const i = sparks.spawn(
              FX_STAR,
              s.s.x + (rnd() - 0.5) * 0.5,
              s.s.y + (rnd() - 0.5) * 0.6,
              0.12,
              0,
              0.15,
              0.55,
              0.05,
              0.2,
            );
            sparks.look(i, GOLD, 0.9);
            sparks.motion(i, 0, 0, 0, 2);
          }
        }
        if (visible) {
          const fans = view.fans;
          for (let k = 0; k < fans.length; k++) fans[k]!.setLocalEulerAngles(0, (time * 640 + k * 45) % 360, 0);
        }
      }

      // Ambient particles.
      if (particles && dt > 0) {
        emitZones(dt);
        if (sim.phase === 'playing' && p.grounded) {
          skidAcc += dt * 16;
          while (skidAcc >= 1) {
            skidAcc -= 1;
            const i = puffs.spawn(
              FX_PUFF,
              x - 0.25,
              0.04,
              0.15,
              -0.3 - rnd() * 0.5,
              0.25 + rnd() * 0.35,
              0.5,
              0.1,
              0.35,
            );
            puffs.look(i, DUST, 0.45);
            puffs.motion(i, 0, 2, 0, (rnd() - 0.5) * 3);
          }
        }
        if (sim.phase === 'playing' && p.soggy > 0) {
          dripAcc += dt * 5;
          while (dripAcc >= 1) {
            dripAcc -= 1;
            const i = puffs.spawn(FX_DOT, x + (rnd() - 0.5) * 0.4, y - 0.08, 0.12, p.vx * 0.3, -0.4, 0.6, 0.07, 0.05);
            puffs.look(i, WATER, 0.85);
            puffs.motion(i, -9);
          }
        }
      }
      puffs.update(dt);
      sparks.update(dt);
    },

    event(e, sim) {
      const p = sim.plane;
      switch (e.type) {
        case 'form':
          formT = 0;
          if (particles) {
            for (let k = 0; k < 4; k++) {
              const i = sparks.spawn(FX_DOT, p.x, p.y, 0.1, (rnd() - 0.5) * 2.4, (rnd() - 0.5) * 2.4, 0.3, 0.14, 0.04);
              sparks.look(i, STEAM, 0.7);
            }
          }
          break;
        case 'flap':
          flapT = 0;
          if (particles) {
            for (let k = 0; k < 2; k++) {
              const i = puffs.spawn(
                FX_PUFF,
                p.x - 0.15,
                p.y - 0.12,
                0.1,
                -0.8 - rnd() * 0.5,
                -0.9 - rnd() * 0.4,
                0.4,
                0.12,
                0.42,
              );
              puffs.look(i, STEAM, 0.35);
              puffs.motion(i, 0, 3);
            }
          }
          break;
        case 'stamp':
          sparkle(e.x, e.y, GOLD, 10, true);
          break;
        case 'skid':
          dust(p.x - 0.1, 0.05, 7, 0.5);
          break;
        case 'bonk':
          nudge = 0.08;
          if (particles) {
            for (let k = 0; k < 3; k++) {
              const i = puffs.spawn(
                FX_PUFF,
                p.x + (rnd() - 0.5) * 0.4,
                ROOM_H - 0.05,
                0.1,
                (rnd() - 0.5) * 0.5,
                -0.4,
                0.7,
                0.08,
                0.3,
              );
              puffs.look(i, PLASTER, 0.6);
              puffs.motion(i, -0.6, 1.5);
            }
          }
          break;
        case 'soggy':
          if (particles) {
            for (let k = 0; k < 6; k++) {
              const i = puffs.spawn(FX_DOT, p.x, p.y, 0.12, (rnd() - 0.5) * 2, 0.8 + rnd(), 0.6, 0.08, 0.05);
              puffs.look(i, WATER, 0.9);
              puffs.motion(i, -9);
            }
          }
          break;
        case 'stairwell':
          sparkle(p.x, p.y, SKY, 6, false);
          break;
        case 'crash': {
          crash.on = true;
          crash.t = 0;
          crash.x = e.x;
          crash.y = e.y;
          crash.spin = 0;
          if (e.cause === 'stall') {
            crash.vx = Math.max(0.6, p.vx * 0.6);
            crash.vy = 1.2;
          } else if (e.cause === 'stairwell') {
            crash.vx = 1.2;
            crash.vy = -1;
          } else {
            crash.vx = -1.4 - Math.min(2, p.vx * 0.15);
            crash.vy = e.cause === 'lamp' || e.cause === 'doorway' || e.cause === 'fan' ? 0.2 : 2.6;
          }
          planeRoot.enabled = false;
          ball.e.enabled = true;
          shake = 0.22;
          if (particles) {
            for (let k = 0; k < 8; k++) {
              const ang = rnd() * Math.PI * 2;
              const sp = 1 + rnd() * 2;
              const i = puffs.spawn(FX_STAR, e.x, e.y, 0.15, Math.cos(ang) * sp, Math.sin(ang) * sp, 0.6, 0.16, 0.06);
              puffs.look(i, STEAM, 0.95);
              puffs.motion(i, -5, 1.5, 0, (rnd() - 0.5) * 10);
            }
            dust(e.x, Math.max(0.05, e.y), 4, 0.4);
          }
          break;
        }
        default:
          break;
      }
    },

    project(x, y, z, out) {
      camera.camera!.worldToScreen(projIn.set(x, y, z), projOut);
      out.x = projOut.x;
      out.y = projOut.y;
    },

    trim() {
      if (!particles) return;
      particles = false;
      puffs.clear();
      sparks.clear();
      kit.decor = false;
      for (const v of views) {
        for (const d of v.decor) d.destroy();
        v.decor.length = 0;
      }
      if (sun.light) sun.light.shadowResolution = 1024;
    },
  };
  return scene;
}
