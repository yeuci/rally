#!/usr/bin/env node
/**
 * Rasterises the Rally mark (src/lib/brand.ts) into the app icon, splash and favicon PNGs under assets/images.
 *
 *   node scripts/generate-brand-assets.cjs          (from apps/mobile; needs Playwright + Chromium)
 *
 * brand.ts is transpiled with the TypeScript compiler at run time, so the PNGs always use the exact geometry and
 * colours the app draws with. The script also checks that app.json's splash config matches `SPLASH`.
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const out = (name) => path.join(root, 'assets', 'images', name);

function loadBrand() {
  const file = path.join(root, 'src', 'lib', 'brand.ts');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(mod, mod.exports, require);
  return mod.exports;
}

const { BRAND, ACCENT_STOPS, MARK, SPLASH } = loadBrand();

function checkAppJson() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
  const splash = app.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-splash-screen')?.[1];
  const problems = [];
  if (!splash) problems.push('expo-splash-screen plugin config missing');
  else {
    if (splash.imageWidth !== SPLASH.imageWidth) problems.push(`splash imageWidth ${splash.imageWidth} ≠ ${SPLASH.imageWidth}`);
    if (String(splash.backgroundColor).toUpperCase() !== SPLASH.backgroundColor.toUpperCase()) {
      problems.push(`splash backgroundColor ${splash.backgroundColor} ≠ ${SPLASH.backgroundColor}`);
    }
  }
  if (String(app.android?.adaptiveIcon?.backgroundColor).toUpperCase() !== BRAND.base.toUpperCase()) {
    problems.push(`android.adaptiveIcon.backgroundColor ≠ ${BRAND.base}`);
  }
  if (problems.length) {
    console.error(`app.json is out of sync with src/lib/brand.ts:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
}

const V = MARK.viewBox;
const gradient = (id) => {
  const { x1, y1, x2, y2 } = MARK.gradient;
  const stops = ACCENT_STOPS.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join('');
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`;
};
const markGroup = (paint) =>
  `<g stroke="${paint}" stroke-width="${MARK.strokeWidth}" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="${MARK.stem}" fill="none"/><path d="${MARK.bowl}" fill="${paint}"/><path d="${MARK.leg}" fill="none"/></g>`;
/** The mark's 100×100 box scaled by `scale` around the centre of a 100×100 canvas. */
const placed = (scale, paint) =>
  `<g transform="translate(${V / 2} ${V / 2}) scale(${scale}) translate(${-V / 2} ${-V / 2})">${markGroup(paint)}</g>`;
const svg = (size, body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${V} ${V}"><defs>${defs}</defs>${body}</svg>`;

/** Opaque app icon: base colour, a soft violet glow behind the mark, a faint cyan one low right. */
const iconArt = (size) =>
  svg(
    size,
    `<rect width="${V}" height="${V}" fill="${BRAND.base}"/>` +
      `<circle cx="46" cy="44" r="46" fill="url(#glowA)"/><circle cx="70" cy="76" r="34" fill="url(#glowB)"/>` +
      placed(0.62, 'url(#g)'),
    gradient('g') +
      `<radialGradient id="glowA" cx="46" cy="44" r="46" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${BRAND.violet}" stop-opacity="0.34"/><stop offset="1" stop-color="${BRAND.violet}" stop-opacity="0"/></radialGradient>` +
      `<radialGradient id="glowB" cx="70" cy="76" r="34" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${BRAND.cyan}" stop-opacity="0.16"/><stop offset="1" stop-color="${BRAND.cyan}" stop-opacity="0"/></radialGradient>`,
  );

// Android adaptive icons keep only a 66/108 circle of the layer safe (radius ≈ 313 px at 1024). The mark's farthest
// point (the stem's top cap) is ≈ 48 units from the centre, so 0.5 leaves it ≈ 247 px out: clear of every mask.
const ADAPTIVE_SCALE = 0.5;

const ASSETS = [
  { file: 'icon.png', size: 1024, transparent: false, art: iconArt },
  { file: 'favicon.png', size: 48, transparent: false, art: iconArt },
  // Full 100×100 box, exactly what the intro overlay draws at SPLASH.imageWidth.
  { file: 'splash-icon.png', size: 512, transparent: true, art: (s) => svg(s, markGroup('url(#g)'), gradient('g')) },
  { file: 'android-icon-foreground.png', size: 1024, transparent: true, art: (s) => svg(s, placed(ADAPTIVE_SCALE, 'url(#g)'), gradient('g')) },
  { file: 'android-icon-background.png', size: 1024, transparent: false, art: (s) => svg(s, `<rect width="${V}" height="${V}" fill="${BRAND.base}"/>`) },
  { file: 'android-icon-monochrome.png', size: 1024, transparent: true, art: (s) => svg(s, placed(ADAPTIVE_SCALE, '#FFFFFF')) },
];

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

async function main() {
  checkAppJson();
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Playwright is required: npm i -g playwright && npx playwright install chromium');
    process.exit(1);
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const a of ASSETS) {
      await page.setViewportSize({ width: a.size, height: a.size });
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${a.art(a.size)}</body></html>`,
      );
      await page.screenshot({
        path: out(a.file),
        omitBackground: a.transparent,
        clip: { x: 0, y: 0, width: a.size, height: a.size },
      });
      const s = pngSize(out(a.file));
      if (s.width !== a.size || s.height !== a.size) throw new Error(`${a.file}: got ${s.width}×${s.height}`);
      console.log(`${a.file.padEnd(30)} ${a.size}×${a.size}${a.transparent ? ' transparent' : ''}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
