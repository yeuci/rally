import { createApp } from '@rally/game-kit';
import { BLEND_NONE, BLEND_NORMAL, Color, Entity, MeshInstance, StandardMaterial, Vec3 } from 'playcanvas';
import { BARRELS, LADDER, MEDS, OBSTACLES, POSTS, SPAWNS } from '@rally/game-gunrun-server';
import { createFighter } from './characters.ts';
import { buildLevel } from './level.ts';
import { loadGunRunModels, MODELS, type PropName } from './models.ts';

/**
 * Dev-only model gallery (gallery.html, never part of a build): every prop of the pack on a grid and the characters
 * with each gun of the ladder, lit like the game. `?view=props|fighters`, `?cam=x,z,distance,pitch`.
 * Use it to check a pipeline change before it reaches the game.
 */
const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const labels = document.getElementById('labels')!;
const { app } = createApp({ canvas, maxPixelRatio: 2 });
app.scene.ambientLight = new Color(0.55, 0.55, 0.6);
app.scene.clusteredLightingEnabled = false;

const vertexMat = new StandardMaterial();
vertexMat.diffuseVertexColor = true;
vertexMat.useMetalness = false;
vertexMat.gloss = 0.2;
vertexMat.update();

const camera = new Entity('camera');
camera.addComponent('camera', { clearColor: new Color(0.11, 0.17, 0.1), fov: 30, nearClip: 0.5, farClip: 200 });
app.root.addChild(camera);
const sun = new Entity('sun');
sun.addComponent('light', {
  type: 'directional',
  intensity: 1.1,
  castShadows: true,
  shadowDistance: 60,
  shadowResolution: 2048,
});
sun.setEulerAngles(55, 35, 0);
app.root.addChild(sun);
const ground = new Entity('ground');
const groundMat = new StandardMaterial();
groundMat.diffuse = new Color(0.36, 0.55, 0.22);
groundMat.update();
ground.addComponent('render', { type: 'plane', material: groundMat });
ground.setLocalScale(200, 1, 200);
app.root.addChild(ground);

const tags: { e: Entity; el: HTMLElement }[] = [];
function tag(e: Entity, text: string) {
  const el = document.createElement('div');
  el.textContent = text;
  labels.appendChild(el);
  tags.push({ e, el });
}

async function main() {
  const models = await loadGunRunModels(app);
  const view = params.get('view') ?? 'props';
  let cx = 0;
  let cz = 0;
  if (view === 'arena') {
    // The yard as the game builds it, with the rules' colliders over it (red boxes, cylinders) and the spawns.
    ground.enabled = false;
    const level = buildLevel(app, models, vertexMat, true);
    console.info(`[gallery] level: ${Math.round(level.triangles)} triangles`);
    if (params.has('colliders')) {
      const red = new StandardMaterial();
      red.diffuse = new Color(1, 0.1, 0.1);
      red.opacity = 0.45;
      red.blendType = BLEND_NORMAL;
      red.update();
      for (const o of OBSTACLES) {
        const e = new Entity();
        e.addComponent('render', { type: 'box', material: red, castShadows: false });
        e.setLocalScale(o.x1 - o.x0, 0.2, o.y1 - o.y0);
        e.setPosition((o.x0 + o.x1) / 2, 3.2, (o.y0 + o.y1) / 2);
        app.root.addChild(e);
      }
      for (const c of POSTS) {
        const e = new Entity();
        e.addComponent('render', { type: 'cylinder', material: red, castShadows: false });
        e.setLocalScale(c.r * 2, 0.2, c.r * 2);
        e.setPosition(c.x, 3.2, c.y);
        app.root.addChild(e);
      }
      const blue = new StandardMaterial();
      blue.diffuse = new Color(0.2, 0.4, 1);
      blue.update();
      for (const s of [...SPAWNS]) {
        const e = new Entity();
        e.addComponent('render', { type: 'cylinder', material: blue, castShadows: false });
        e.setLocalScale(0.9, 0.1, 0.9);
        e.setPosition(s.x, 0.05, s.y);
        app.root.addChild(e);
      }
      for (const b of [...BARRELS, ...MEDS]) {
        const e = new Entity();
        e.addComponent('render', { type: 'sphere', material: red, castShadows: false });
        e.setLocalScale(0.8, 0.8, 0.8);
        e.setPosition(b.x, 0.5, b.y);
        app.root.addChild(e);
      }
    }
    for (const b of BARRELS) {
      const e = new Entity();
      e.addComponent('render', { meshInstances: [new MeshInstance(models.props.ExplodingBarrel.mesh, vertexMat)] });
      e.setPosition(b.x, 0, b.y);
      app.root.addChild(e);
    }
    for (const b of MEDS) {
      const e = new Entity();
      e.addComponent('render', { meshInstances: [new MeshInstance(models.props.Health.mesh, vertexMat)] });
      e.setPosition(b.x, 0.2, b.y);
      app.root.addChild(e);
    }
  } else if (view === 'props') {
    const names = Object.keys(MODELS.props) as PropName[];
    const cols = 7;
    const fenceMat = new StandardMaterial();
    fenceMat.diffuseMap = models.fence;
    fenceMat.opacityMap = models.fence;
    fenceMat.opacityMapChannel = 'a';
    fenceMat.alphaTest = 0.5;
    fenceMat.blendType = BLEND_NONE;
    fenceMat.cull = 0;
    fenceMat.update();
    names.forEach((name, i) => {
      const p = models.props[name];
      const e = new Entity(name);
      const mis = [new MeshInstance(p.mesh, vertexMat)];
      if (p.alpha) mis.push(new MeshInstance(p.alpha.mesh, fenceMat));
      e.addComponent('render', { meshInstances: mis, castShadows: true });
      e.setPosition((i % cols) * 12 - 36, 0, Math.floor(i / cols) * 12 - 24);
      app.root.addChild(e);
      tag(e, name);
    });
  } else {
    LADDER.forEach((w, i) => {
      for (let slot = 0; slot < 3; slot++) {
        const f = createFighter(app, models, i * 3 + slot, vertexMat);
        f.setWeapon(w);
        f.update({ speed: 0, back: false, alive: true, firing: false, stabbing: false, celebrating: false });
        f.root.setPosition(i * 2.4 - 9.6, 0, slot * 3 - 3);
        f.root.setEulerAngles(0, slot === 1 ? 90 : slot === 2 ? 180 : 0, 0);
        app.root.addChild(f.root);
        if (slot === 0) tag(f.root, w);
      }
    });
  }
  const cam = (params.get('cam') ?? '').split(',').map(Number);
  cx = cam[0] || cx;
  cz = cam[1] || cz;
  const dist = cam[2] || (view === 'fighters' ? 26 : view === 'arena' ? 75 : 90);
  const pitch = ((cam[3] || 55) * Math.PI) / 180;
  camera.setPosition(cx, Math.sin(pitch) * dist, cz + Math.cos(pitch) * dist);
  camera.lookAt(new Vec3(cx, 0, cz));
  const tmp = new Vec3();
  app.on('update', () => {
    for (const t of tags) {
      camera.camera!.worldToScreen(t.e.getPosition(), tmp);
      t.el.style.left = `${tmp.x}px`;
      t.el.style.top = `${tmp.y + 6}px`;
    }
  });
  app.start();
  (window as unknown as { __galleryReady: boolean }).__galleryReady = true;
}

void main();
