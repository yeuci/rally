import {
  Color,
  Entity,
  MeshInstance,
  PROJECTION_ORTHOGRAPHIC,
  type Application,
  type StandardMaterial,
} from 'playcanvas';
import type { Kind } from '@rally/game-sushi-server';
import { ICON_KINDS, KIND_MODEL } from './catalog.ts';
import type { Models } from './models.ts';

/**
 * Dish and ingredient icons for the DOM (order bubbles, the mat's contents, recipe hints), rendered from the real food
 * models once at boot: every model in a grid in front of an orthographic camera, one frame, the canvas read back
 * right after it is drawn (no preserveDrawingBuffer needed) and cut into one data URL per kind. The background is the
 * order bubble's paper colour, so an icon sits on a bubble seamlessly. Falls back to no icons (the bubbles show
 * names) if the read-back fails.
 */
export type Icons = ReadonlyMap<Kind, string>;

const PAPER = new Color(1, 0.98, 0.94);

export async function renderIcons(app: Application, models: Models, material: StandardMaterial): Promise<Icons> {
  const kinds = ICON_KINDS.filter((k) => KIND_MODEL[k]);
  const cols = 9;
  const rows = Math.ceil(kinds.length / cols);
  const device = app.graphicsDevice;
  const aspect = device.width / Math.max(1, device.height);
  const viewH = rows;
  const viewW = viewH * aspect;
  const cellW = viewW / cols;
  const root = new Entity('icons');
  root.setPosition(0, -200, 0);
  app.root.addChild(root);
  const camera = new Entity('icon-camera');
  camera.addComponent('camera', {
    projection: PROJECTION_ORTHOGRAPHIC,
    orthoHeight: viewH / 2,
    clearColor: PAPER,
    nearClip: 0.1,
    farClip: 20,
  });
  camera.setPosition(0, -200, 10);
  root.addChild(camera);
  camera.setPosition(0, -200, 10);
  const light = new Entity('icon-light');
  light.addComponent('light', { type: 'directional', color: new Color(1, 0.97, 0.9), intensity: 1.2 });
  light.setEulerAngles(40, 30, 0);
  root.addChild(light);
  const prevAmbient = app.scene.ambientLight.clone();
  app.scene.ambientLight = new Color(0.62, 0.6, 0.58);

  kinds.forEach((k, i) => {
    const food = models.food[KIND_MODEL[k]!];
    const size = Math.max(food.max[0]! - food.min[0]!, food.max[1]! - food.min[1]!, food.max[2]! - food.min[2]!);
    const s = (Math.min(cellW, 1) * 0.82) / size;
    const holder = new Entity(`icon-${k}`);
    const e = new Entity();
    e.addComponent('render', { meshInstances: [new MeshInstance(food.mesh, material)], castShadows: false });
    e.setLocalScale(s, s, s);
    // Centre the model on the holder.
    e.setLocalPosition(
      -((food.min[0]! + food.max[0]!) / 2) * s,
      -((food.min[1]! + food.max[1]!) / 2) * s,
      -((food.min[2]! + food.max[2]!) / 2) * s,
    );
    holder.addChild(e);
    const col = i % cols;
    const row = Math.floor(i / cols);
    holder.setLocalPosition(-viewW / 2 + (col + 0.5) * cellW, viewH / 2 - (row + 0.5), 0);
    holder.setLocalEulerAngles(32, -28, 0);
    root.addChild(holder);
  });

  const url = await new Promise<string | null>((resolve) => {
    let frames = 0;
    const grab = () => {
      // Two frames: the first compiles shaders and uploads meshes.
      if (++frames < 2) return;
      app.off('frameend', grab);
      try {
        resolve((device.canvas as HTMLCanvasElement).toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    app.on('frameend', grab);
    setTimeout(() => {
      app.off('frameend', grab);
      resolve(null);
    }, 4000);
  });
  root.destroy();
  app.scene.ambientLight = prevAmbient;
  const out = new Map<Kind, string>();
  if (!url) return out;
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    return out;
  }
  const px = img.naturalWidth / cols;
  const py = img.naturalHeight / rows;
  const size = Math.round(Math.min(px, py, 96));
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return out;
  kinds.forEach((k, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const side = Math.min(px, py);
    g.clearRect(0, 0, size, size);
    g.drawImage(img, col * px + (px - side) / 2, row * py + (py - side) / 2, side, side, 0, 0, size, size);
    out.set(k, c.toDataURL('image/png'));
  });
  return out;
}
