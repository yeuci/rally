import { createApp, setupAnimLayers } from '@rally/game-kit';
import { Color, Entity, MeshInstance, Quat, StandardMaterial, Vec3 } from 'playcanvas';
import { loadSushiModels, MODELS, type CharacterName, type FoodName, type PropModel } from './models.ts';

/**
 * Dev-only model gallery (gallery.html, never part of a build): every model of the pack as the pipeline wrote it, lit
 * like the game. `?view=food|props|characters`, `?clip=<name>` (characters), `?cam=x,z,distance,pitch`.
 */
const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const labels = document.getElementById('labels')!;
const { app } = createApp({ canvas, maxPixelRatio: 2 });
app.scene.ambientLight = new Color(0.6, 0.55, 0.5);
app.scene.clusteredLightingEnabled = false;

const vertexMat = new StandardMaterial();
vertexMat.diffuseVertexColor = true;
vertexMat.useMetalness = false;
vertexMat.gloss = 0.2;
vertexMat.update();

const camera = new Entity('camera');
camera.addComponent('camera', { clearColor: new Color(0.16, 0.12, 0.09), fov: 30, nearClip: 0.1, farClip: 200 });
app.root.addChild(camera);
const sun = new Entity('sun');
sun.addComponent('light', { type: 'directional', intensity: 1.1, castShadows: true, shadowDistance: 40 });
sun.setEulerAngles(55, 35, 0);
app.root.addChild(sun);
const ground = new Entity('ground');
const groundMat = new StandardMaterial();
groundMat.diffuse = new Color(0.78, 0.6, 0.4);
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
  const models = await loadSushiModels(app);
  const view = params.get('view') ?? 'food';
  let dist = 30;
  if (view === 'food') {
    const names = Object.keys(MODELS.food) as FoodName[];
    const cols = 8;
    names.forEach((name, i) => {
      const f = models.food[name];
      const e = new Entity(name);
      e.addComponent('render', { meshInstances: [new MeshInstance(f.mesh, vertexMat)], castShadows: true });
      e.setPosition((i % cols) * 1.6 - 5.6, -f.min[1]!, Math.floor(i / cols) * 1.6 - 3.2);
      app.root.addChild(e);
      tag(e, name);
    });
    dist = 16;
  } else if (view === 'props') {
    const names = Object.keys(MODELS.props) as PropModel[];
    const cols = 9;
    names.forEach((name, i) => {
      const p = models.props[name];
      const e = new Entity(name);
      e.addComponent('render', { meshInstances: [new MeshInstance(p.mesh, vertexMat)], castShadows: true });
      e.setPosition((i % cols) * 3.4 - 13.6, 0, Math.floor(i / cols) * 3.4 - 8.5);
      app.root.addChild(e);
      tag(e, name);
    });
    dist = 42;
  } else {
    const names = [...MODELS.chefs, ...MODELS.customers] as CharacterName[];
    const clip = params.get('clip') ?? 'Idle';
    names.forEach((name, i) => {
      const model = models.characters[name].instantiateRenderEntity();
      for (const c of model.findComponents('render')) {
        const r = c as unknown as { meshInstances: MeshInstance[]; castShadows: boolean };
        for (const mi of r.meshInstances) mi.material = vertexMat;
        r.castShadows = true;
      }
      model.setLocalScale(0.5, 0.5, 0.5);
      setupAnimLayers(model, models.clips, [{ name: 'Body', initial: 'A', states: { A: { clip } } }]);
      const root = new Entity(name);
      root.addChild(model);
      root.setPosition((i % 4) * 1.6 - 2.4, 0, Math.floor(i / 4) * 2 - 1);
      app.root.addChild(root);
      if (i < 4 && params.has('tools')) {
        for (const id of ['knife', 'pan'] as const) {
          const t = models.tools[id];
          const bone = model.findByName(t.bone) as Entity | null;
          if (!bone) continue;
          const e = new Entity(id);
          e.addComponent('render', { meshInstances: [new MeshInstance(t.mesh, vertexMat)] });
          e.setLocalPosition(t.t[0]!, t.t[1]!, t.t[2]!);
          e.setLocalRotation(new Quat(t.r[0]!, t.r[1]!, t.r[2]!, t.r[3]!));
          bone.addChild(e);
        }
      }
      tag(root, name);
    });
    dist = 12;
  }
  const cam = (params.get('cam') ?? '').split(',').map(Number);
  const cx = cam[0] || 0;
  const cz = cam[1] || 0;
  dist = cam[2] || dist;
  const pitch = ((cam[3] || 50) * Math.PI) / 180;
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
