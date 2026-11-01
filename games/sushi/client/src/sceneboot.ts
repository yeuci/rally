import { Color, StandardMaterial, type Application } from 'playcanvas';
import { renderIcons, type Icons } from './icons.ts';
import type { Models } from './models.ts';
import type { RenderQuality } from './quality.ts';
import { createSushiScene, type SushiScene } from './scene.ts';

export type { SushiScene };

/**
 * The boot's last visual steps, in order: the dish icons are rendered first (one frame with only the food models in
 * front of an orthographic camera, behind the loading veil), then the restaurant is built.
 */
export async function createSceneSafe(
  app: Application,
  onResize: (fn: (w: number, h: number) => void) => void,
  models: Models,
  quality: RenderQuality,
): Promise<{ scene: SushiScene; icons: Icons }> {
  const mat = new StandardMaterial();
  mat.diffuseVertexColor = true;
  mat.useMetalness = false;
  mat.specular = new Color(0.05, 0.05, 0.05);
  mat.gloss = 0.2;
  mat.update();
  let icons: Icons = new Map();
  try {
    icons = await renderIcons(app, models, mat);
  } catch (err) {
    console.warn('[sushi] icons', err);
  }
  const scene = createSushiScene(app, onResize, models, {
    shadows: quality.shadows,
    effects: quality.effects,
    crowdShadows: quality.crowdShadows,
  });
  return { scene, icons };
}
