import {
  ADDRESS_CLAMP_TO_EDGE,
  ADDRESS_REPEAT,
  FILTER_LINEAR,
  FILTER_LINEAR_MIPMAP_LINEAR,
  type GraphicsDevice,
  PIXELFORMAT_RGBA8,
  PIXELFORMAT_SRGBA8,
  Texture,
} from 'playcanvas';

/**
 * Procedural canvas textures, each drawn once and cached: six wallpapers, floorboards, the effects atlas (soft dot,
 * ring, sparkle, puff), the wall-art atlas (paintings, window views, a clock face) and the postage stamps. Nothing is
 * downloaded.
 */

type Ctx = CanvasRenderingContext2D;

const cache = new Map<string, Texture>();

function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function texture(
  device: GraphicsDevice,
  name: string,
  c: HTMLCanvasElement,
  opts: { srgb?: boolean; repeat?: boolean; aniso?: number } = {},
): Texture {
  const address = opts.repeat ? ADDRESS_REPEAT : ADDRESS_CLAMP_TO_EDGE;
  const t = new Texture(device, {
    name,
    width: c.width,
    height: c.height,
    format: opts.srgb === false ? PIXELFORMAT_RGBA8 : PIXELFORMAT_SRGBA8,
    mipmaps: true,
    minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: address,
    addressV: address,
    anisotropy: opts.aniso ?? 4,
  });
  t.setSource(c);
  return t;
}

function cached(key: string, make: () => Texture): Texture {
  let t = cache.get(key);
  if (!t) cache.set(key, (t = make()));
  return t;
}

/** Deterministic noise for texture details. */
function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- wallpaper ------------------------------------------------------------------------------------------

/** World size (m) of one wallpaper tile. */
export const WALLPAPER_TILE = 1.6;

/** Per theme: wallpaper base, the darker painted panelling below the dado rail, and an accent for fabrics. */
export const THEMES: readonly { paper: string; panel: string; accent: string; rug: string; rug2: string }[] = [
  { paper: '#9fb894', panel: '#6c8763', accent: '#c4553f', rug: '#9c3b30', rug2: '#e2c48f' },
  { paper: '#d9a29a', panel: '#a5675f', accent: '#3f6f8f', rug: '#2f4f6f', rug2: '#e6d3b0' },
  { paper: '#dcb15a', panel: '#93703d', accent: '#3f7f6a', rug: '#2f5f4a', rug2: '#e9d9b0' },
  { paper: '#9bb8d2', panel: '#5b7c9e', accent: '#c98a3a', rug: '#7a3550', rug2: '#ecd9b5' },
  { paper: '#79ada6', panel: '#3f736d', accent: '#d46b4a', rug: '#a8742e', rug2: '#f0dfbc' },
  { paper: '#cf8a68', panel: '#91553f', accent: '#4a6f9a', rug: '#2e6b6b', rug2: '#efdcb8' },
];

function wallpaperArt(theme: number, g: Ctx, S: number) {
  const t = THEMES[theme]!;
  g.fillStyle = t.paper;
  g.fillRect(0, 0, S, S);
  const r = rand(theme * 977 + 5);
  // A faint paper grain under every pattern.
  for (let i = 0; i < 900; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
    g.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 2);
  }
  switch (theme) {
    case 0: {
      // Regency stripes: broad bands, cream pinstripes, a vine in every other band.
      for (let x = 0; x < S; x += 64) {
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.fillRect(x, 0, 32, S);
        g.fillStyle = 'rgba(250,244,220,0.55)';
        g.fillRect(x + 31, 0, 2, S);
        g.fillRect(x + 62, 0, 2, S);
        g.strokeStyle = 'rgba(70,100,60,0.35)';
        g.lineWidth = 2;
        g.beginPath();
        for (let y = 0; y <= S; y += 4) g.lineTo(x + 16 + Math.sin((y / S) * Math.PI * 8) * 6, y);
        g.stroke();
        g.fillStyle = 'rgba(70,100,60,0.35)';
        for (let y = 16; y < S; y += 32) {
          const lx = x + 16 + Math.sin((y / S) * Math.PI * 8) * 6;
          g.beginPath();
          g.ellipse(lx + 5, y, 5, 2.5, 0.6, 0, Math.PI * 2);
          g.ellipse(lx - 5, y + 16, 5, 2.5, -0.6, 0, Math.PI * 2);
          g.fill();
        }
      }
      break;
    }
    case 1: {
      // Polka dots on a half-drop grid, with tiny dots between.
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 5; col++) {
          const x = col * 64 + (row % 2 ? 32 : 0);
          const y = row * 64 + 32;
          g.fillStyle = 'rgba(255,240,230,0.75)';
          g.beginPath();
          g.arc(x, y, 9, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = 'rgba(140,70,60,0.22)';
          g.beginPath();
          g.arc(x + 32, y, 3, 0, Math.PI * 2);
          g.fill();
        }
      }
      break;
    }
    case 2: {
      // Damask-ish: a mirrored ornament on a half-drop grid.
      const motif = (cx: number, cy: number) => {
        g.save();
        g.translate(cx, cy);
        for (const s of [1, -1]) {
          g.save();
          g.scale(s, 1);
          g.strokeStyle = 'rgba(150,100,30,0.55)';
          g.fillStyle = 'rgba(150,100,30,0.4)';
          g.lineWidth = 3;
          g.beginPath();
          g.moveTo(0, -40);
          g.bezierCurveTo(22, -26, 26, -6, 8, 6);
          g.bezierCurveTo(24, 14, 22, 34, 0, 44);
          g.stroke();
          g.beginPath();
          g.moveTo(8, 6);
          g.bezierCurveTo(26, 0, 32, -14, 24, -22);
          g.stroke();
          g.beginPath();
          g.ellipse(14, 24, 6, 3, 0.8, 0, Math.PI * 2);
          g.fill();
          g.restore();
        }
        g.fillStyle = 'rgba(245,215,140,0.5)';
        g.beginPath();
        g.ellipse(0, -2, 6, 14, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      };
      for (const [x, y] of [
        [64, 64],
        [192, 192],
        [192, -64],
        [64, 320],
        [-64, 192],
        [320, 192],
      ] as const)
        motif(x, y);
      break;
    }
    case 3: {
      // Gingham check.
      g.fillStyle = 'rgba(255,255,255,0.22)';
      for (let i = 0; i < S; i += 64) {
        g.fillRect(i, 0, 32, S);
        g.fillRect(0, i, S, 32);
      }
      g.strokeStyle = 'rgba(40,70,110,0.18)';
      g.lineWidth = 1;
      for (let i = 0; i < S; i += 16) {
        g.beginPath();
        g.moveTo(i + 0.5, 0);
        g.lineTo(i + 0.5, S);
        g.stroke();
      }
      break;
    }
    case 4: {
      // Trellis: a diagonal lattice with dots at the crossings.
      g.strokeStyle = 'rgba(230,240,225,0.35)';
      g.lineWidth = 3;
      for (let i = -S; i <= S * 2; i += 64) {
        g.beginPath();
        g.moveTo(i, 0);
        g.lineTo(i + S, S);
        g.stroke();
        g.beginPath();
        g.moveTo(i, S);
        g.lineTo(i + S, 0);
        g.stroke();
      }
      g.fillStyle = 'rgba(250,236,200,0.75)';
      for (let y = 0; y <= S; y += 64) {
        for (let x = 0; x <= S; x += 64) {
          for (const [dx, dy] of [
            [0, 0],
            [32, 32],
          ] as const) {
            g.beginPath();
            g.arc(x + dx, y + dy, 4.5, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
      break;
    }
    default: {
      // Chevrons.
      g.strokeStyle = 'rgba(255,225,200,0.38)';
      g.lineWidth = 5;
      for (let y = 0; y < S + 32; y += 32) {
        g.beginPath();
        for (let x = 0; x <= S; x += 32) g.lineTo(x, y + ((x / 32) % 2 ? 12 : -4));
        g.stroke();
      }
      g.fillStyle = 'rgba(120,50,30,0.18)';
      for (let y = 16; y < S; y += 64) for (let x = 16; x < S; x += 64) g.fillRect(x - 2, y - 2, 4, 4);
      break;
    }
  }
}

export function wallpaper(device: GraphicsDevice, theme: number): Texture {
  return cached(`wall${theme}`, () => {
    const S = 256;
    const [c, g] = canvas(S, S);
    wallpaperArt(theme, g, S);
    return texture(device, `wallpaper-${theme}`, c, { repeat: true });
  });
}

// --- floorboards ----------------------------------------------------------------------------------------

/** World size (m) of the floorboard tile: along x, along z. */
export const FLOOR_TILE_X = 2.4;
export const FLOOR_TILE_Z = 1.2;

export function floorboards(device: GraphicsDevice): Texture {
  return cached('floor', () => {
    const W = 512,
      H = 256,
      ROWS = 8;
    const [c, g] = canvas(W, H);
    const r = rand(42);
    const tones = ['#c8955c', '#bf8b52', '#d0a068', '#b98450', '#c6915a'];
    const rowH = H / ROWS;
    for (let row = 0; row < ROWS; row++) {
      let x = -r() * 200;
      while (x < W) {
        const len = 150 + r() * 190;
        const tone = tones[Math.floor(r() * tones.length)]!;
        // Each board is drawn twice, shifted by the tile width, so it wraps across the seam.
        for (const shift of [0, -W, W]) {
          const bx = x + shift;
          if (bx > W || bx + len < 0) continue;
          g.fillStyle = tone;
          g.fillRect(bx, row * rowH, len, rowH);
          const gr = rand(Math.floor(x * 13 + row * 101));
          for (let k = 0; k < 6; k++) {
            g.strokeStyle = `rgba(90,55,25,${0.06 + gr() * 0.1})`;
            g.lineWidth = 1;
            g.beginPath();
            const y0 = row * rowH + 3 + gr() * (rowH - 6);
            g.moveTo(bx, y0);
            for (let t = 0; t <= len; t += 24) g.lineTo(bx + t, y0 + Math.sin(t * 0.03 + k) * 1.5);
            g.stroke();
          }
          g.fillStyle = 'rgba(70,40,20,0.55)';
          g.fillRect(bx, row * rowH, 2, rowH);
        }
        x += len;
      }
      g.fillStyle = 'rgba(70,40,20,0.5)';
      g.fillRect(0, row * rowH, W, 2);
      g.fillStyle = 'rgba(255,240,210,0.12)';
      g.fillRect(0, row * rowH + 2, W, 2);
    }
    return texture(device, 'floorboards', c, { repeat: true, aniso: 8 });
  });
}

// --- effects atlas ----------------------------------------------------------------------------------------

/** Cells of the 2 × 2 effects atlas (white, shape in alpha). */
export const FX_DOT = 0,
  FX_RING = 1,
  FX_STAR = 2,
  FX_PUFF = 3;

/** uv rect of an effects cell: [u0, v0, u1, v1]. */
export function fxCell(cell: number): readonly [number, number, number, number] {
  const u = (cell % 2) * 0.5,
    v = Math.floor(cell / 2) * 0.5;
  return [u, v, u + 0.5, v + 0.5];
}

export function fxAtlas(device: GraphicsDevice): Texture {
  return cached('fx', () => {
    const S = 128,
      h = S / 2;
    const [c, g] = canvas(S, S);
    const radial = (cx: number, cy: number, r: number, stops: [number, number][]) => {
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      for (const [o, a] of stops) grad.addColorStop(o, `rgba(255,255,255,${a})`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    };
    // Soft dot.
    radial(h / 2, h / 2, h / 2 - 1, [
      [0, 1],
      [0.35, 0.75],
      [0.7, 0.25],
      [1, 0],
    ]);
    // Ring.
    radial(h + h / 2, h / 2, h / 2 - 1, [
      [0, 0],
      [0.62, 0],
      [0.8, 1],
      [1, 0],
    ]);
    // Four-point sparkle.
    g.save();
    g.translate(h / 2, h + h / 2);
    radial(0, 0, h * 0.22, [
      [0, 1],
      [1, 0],
    ]);
    g.fillStyle = 'rgba(255,255,255,1)';
    for (let k = 0; k < 4; k++) {
      g.rotate(Math.PI / 2);
      g.beginPath();
      g.moveTo(0, -h * 0.46);
      g.quadraticCurveTo(h * 0.04, -h * 0.04, h * 0.46 * 0.12, 0);
      g.quadraticCurveTo(h * 0.04, h * 0.04, 0, 0);
      g.lineTo(0, -h * 0.46);
      g.fill();
      g.beginPath();
      g.moveTo(0, -h * 0.46);
      g.quadraticCurveTo(-h * 0.04, -h * 0.04, -h * 0.46 * 0.12, 0);
      g.lineTo(0, 0);
      g.fill();
    }
    g.restore();
    // Puff: overlapping soft blobs.
    const r = rand(7);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      radial(h + h / 2 + Math.cos(a) * 9, h + h / 2 + Math.sin(a) * 9, 13 + r() * 5, [
        [0, 0.55],
        [1, 0],
      ]);
    }
    radial(h + h / 2, h + h / 2, 18, [
      [0, 0.7],
      [1, 0],
    ]);
    return texture(device, 'fx', c, { srgb: false });
  });
}

// --- wall art -----------------------------------------------------------------------------------------------

export const ART_PAINTINGS = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12] as const;
export const ART_WINDOWS = [8, 9] as const;
export const ART_CLOCK = 10;

/** uv rect of a wall-art cell, bottom-left first: [u0, vBottom, u1, vTop] (the canvas's top row is v = 0). */
export function artCell(cell: number): readonly [number, number, number, number] {
  const col = cell % 4,
    row = Math.floor(cell / 4);
  const e = 2 / 512;
  return [col / 4 + e, (row + 1) / 4 - e, (col + 1) / 4 - e, row / 4 + e];
}

function paint(g: Ctx, cell: number) {
  const S = 128;
  const x0 = (cell % 4) * S,
    y0 = Math.floor(cell / 4) * S;
  g.save();
  g.beginPath();
  g.rect(x0, y0, S, S);
  g.clip();
  g.translate(x0, y0);
  const sky = (top: string, bottom: string, h = S) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, S, h);
  };
  const hill = (color: string, y: number, amp: number, freq: number, phase: number) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, S);
    for (let x = 0; x <= S; x += 4) g.lineTo(x, y + Math.sin(x * freq + phase) * amp);
    g.lineTo(S, S);
    g.fill();
  };
  const circle = (x: number, y: number, r: number, color: string) => {
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  switch (cell) {
    case 0: // rolling hills
      sky('#9fd0e8', '#f3e6c4');
      circle(96, 34, 12, '#ffe39a');
      hill('#8fb56a', 70, 8, 0.05, 0);
      hill('#6f9a52', 88, 10, 0.04, 2);
      hill('#557f3f', 108, 6, 0.06, 4);
      break;
    case 1: // sailboat
      sky('#bfe3f2', '#e9f4f4', 80);
      g.fillStyle = '#3f7fb0';
      g.fillRect(0, 80, S, 48);
      g.fillStyle = 'rgba(255,255,255,0.4)';
      for (let i = 0; i < 6; i++) g.fillRect(10 + i * 20, 92 + (i % 3) * 10, 12, 2);
      g.fillStyle = '#7a4a2a';
      g.beginPath();
      g.moveTo(40, 82);
      g.lineTo(92, 82);
      g.lineTo(84, 92);
      g.lineTo(48, 92);
      g.fill();
      g.fillStyle = '#fbf6ea';
      g.beginPath();
      g.moveTo(64, 30);
      g.lineTo(64, 80);
      g.lineTo(90, 80);
      g.fill();
      g.fillStyle = '#e5533d';
      g.beginPath();
      g.moveTo(62, 36);
      g.lineTo(62, 80);
      g.lineTo(42, 80);
      g.fill();
      break;
    case 2: // mid-century abstract
      g.fillStyle = '#efe4cc';
      g.fillRect(0, 0, S, S);
      circle(44, 48, 26, '#e0913a');
      g.fillStyle = '#2f5f6f';
      g.fillRect(64, 20, 40, 70);
      circle(84, 96, 18, '#c9473a');
      g.fillStyle = '#2b2b2b';
      g.fillRect(16, 92, 60, 6);
      break;
    case 3: // flowers in a vase
      g.fillStyle = '#e8dcc2';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#5d8a4a';
      for (let i = -2; i <= 2; i++) g.fillRect(62 + i * 6, 46, 3, 44);
      for (const [x, y, col] of [
        [46, 40, '#e5533d'],
        [64, 30, '#f2b632'],
        [82, 42, '#d9658f'],
        [56, 52, '#f6efe0'],
        [74, 54, '#e5533d'],
      ] as const)
        circle(x, y, 10, col);
      g.fillStyle = '#3e6fa8';
      g.beginPath();
      g.moveTo(48, 84);
      g.lineTo(80, 84);
      g.lineTo(74, 116);
      g.lineTo(54, 116);
      g.fill();
      break;
    case 4: // mountain lake
      sky('#c9dff0', '#f6efe2', 70);
      g.fillStyle = '#7d8ea8';
      g.beginPath();
      g.moveTo(10, 72);
      g.lineTo(52, 22);
      g.lineTo(80, 52);
      g.lineTo(96, 36);
      g.lineTo(124, 72);
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(44, 32);
      g.lineTo(52, 22);
      g.lineTo(60, 32);
      g.fill();
      g.fillStyle = '#6aa0c0';
      g.fillRect(0, 72, S, 56);
      g.fillStyle = '#4f7a3f';
      g.fillRect(0, 100, S, 28);
      break;
    case 5: // cameo
      g.fillStyle = '#3f5f5a';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#efe2c8';
      g.beginPath();
      g.ellipse(64, 64, 40, 52, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#3f5f5a';
      g.beginPath();
      g.arc(66, 52, 18, 0, Math.PI * 2);
      g.moveTo(50, 110);
      g.quadraticCurveTo(64, 70, 84, 110);
      g.fill();
      break;
    case 6: // botanical leaf
      g.fillStyle = '#f2ead6';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#5f8f5a';
      g.beginPath();
      g.moveTo(64, 14);
      g.quadraticCurveTo(108, 60, 64, 116);
      g.quadraticCurveTo(20, 60, 64, 14);
      g.fill();
      g.strokeStyle = '#e9e2c8';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(64, 18);
      g.lineTo(64, 114);
      for (let y = 36; y < 104; y += 14) {
        g.moveTo(64, y);
        g.lineTo(44, y - 10);
        g.moveTo(64, y);
        g.lineTo(84, y - 10);
      }
      g.stroke();
      break;
    case 7: // triangles
      g.fillStyle = '#f0e6d0';
      g.fillRect(0, 0, S, S);
      for (const [x, y, col] of [
        [20, 100, '#c9473a'],
        [52, 100, '#2f5f6f'],
        [84, 100, '#e0a33a'],
        [36, 64, '#6f9a52'],
        [68, 64, '#c9473a'],
        [52, 28, '#2f5f6f'],
      ] as const) {
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + 32, y);
        g.lineTo(x + 16, y - 32);
        g.fill();
      }
      break;
    case 8: // window: day
      sky('#7fc0e8', '#d8eef6');
      g.fillStyle = 'rgba(255,255,255,0.9)';
      for (const [x, y, s] of [
        [30, 30, 1],
        [94, 52, 0.8],
      ] as const) {
        g.beginPath();
        g.ellipse(x, y, 18 * s, 8 * s, 0, 0, Math.PI * 2);
        g.ellipse(x + 12 * s, y - 5 * s, 12 * s, 8 * s, 0, 0, Math.PI * 2);
        g.fill();
      }
      for (let i = 0; i < 6; i++) circle(10 + i * 24, 120, 18 + (i % 2) * 6, i % 2 ? '#5f8f4a' : '#6f9f55');
      break;
    case 9: // window: dusk
      sky('#f2a65a', '#ffe0a8');
      circle(80, 70, 16, '#fff2c8');
      for (let i = 0; i < 6; i++) circle(10 + i * 24, 122, 16 + (i % 2) * 6, i % 2 ? '#6a5a7a' : '#5a4a6a');
      break;
    case 10: {
      // clock face
      g.fillStyle = '#fbf6ea';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#2f2a3a';
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const big = k % 3 === 0;
        g.save();
        g.translate(64 + Math.sin(a) * 50, 64 - Math.cos(a) * 50);
        g.rotate(a);
        g.fillRect(-(big ? 3 : 1.5), -6, big ? 6 : 3, big ? 12 : 8);
        g.restore();
      }
      g.strokeStyle = '#2f2a3a';
      g.lineCap = 'round';
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(64, 64);
      g.lineTo(64 + 24, 64 - 14);
      g.stroke();
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(64, 64);
      g.lineTo(64 - 6, 64 - 40);
      g.stroke();
      circle(64, 64, 5, '#c9473a');
      break;
    }
    case 11: // cat
      g.fillStyle = '#e6c27a';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#3a2f2a';
      g.beginPath();
      g.ellipse(64, 92, 30, 26, 0, 0, Math.PI * 2);
      g.ellipse(64, 54, 20, 18, 0, 0, Math.PI * 2);
      g.moveTo(46, 46);
      g.lineTo(50, 26);
      g.lineTo(60, 40);
      g.moveTo(82, 46);
      g.lineTo(78, 26);
      g.lineTo(68, 40);
      g.fill();
      circle(57, 54, 3, '#f2d36a');
      circle(71, 54, 3, '#f2d36a');
      break;
    default: // sunset sea
      sky('#f5b46a', '#f8dca8', 76);
      circle(64, 70, 22, '#fff0c0');
      g.fillStyle = '#3f6f8f';
      g.fillRect(0, 76, S, 52);
      g.fillStyle = 'rgba(255,230,170,0.6)';
      for (let i = 0; i < 5; i++) g.fillRect(44 + (i % 2) * 8, 84 + i * 8, 40 - i * 6, 2);
      break;
  }
  g.restore();
}

export function artAtlas(device: GraphicsDevice): Texture {
  return cached('art', () => {
    const [c, g] = canvas(512, 512);
    g.fillStyle = '#efe4cc';
    g.fillRect(0, 0, 512, 512);
    for (let cell = 0; cell < 13; cell++) paint(g, cell);
    return texture(device, 'art', c);
  });
}

// --- stamps ---------------------------------------------------------------------------------------------------

export const STAMP_KINDS = 4;

/** uv rect of a stamp design, bottom-left first: [u0, vBottom, u1, vTop]. */
export function stampCell(kind: number): readonly [number, number, number, number] {
  return [kind / 4, 1, (kind + 1) / 4, 0];
}

export function stampAtlas(device: GraphicsDevice): Texture {
  return cached('stamps', () => {
    const W = 128,
      H = 160;
    const [c, g] = canvas(W * 4, H);
    const colors = ['#e5533d', '#3e6fd8', '#3f9d5a', '#e9a92a'];
    for (let k = 0; k < 4; k++) {
      g.save();
      g.translate(k * W, 0);
      // Paper with perforated edges: a rectangle with half-circles bitten out of every side.
      const m = 6,
        w = W - m * 2,
        h = H - m * 2,
        hole = 6;
      g.fillStyle = '#fffaf0';
      g.fillRect(m, m, w, h);
      g.globalCompositeOperation = 'destination-out';
      const nx = 7,
        ny = 9;
      for (let i = 0; i <= nx; i++) {
        const x = m + (i / nx) * w;
        g.beginPath();
        g.arc(x, m, hole, 0, Math.PI * 2);
        g.arc(x, m + h, hole, 0, Math.PI * 2);
        g.fill();
      }
      for (let i = 0; i <= ny; i++) {
        const y = m + (i / ny) * h;
        g.beginPath();
        g.arc(m, y, hole, 0, Math.PI * 2);
        g.arc(m + w, y, hole, 0, Math.PI * 2);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
      // The picture.
      const ix = m + 14,
        iy = m + 14,
        iw = w - 28,
        ih = h - 46;
      g.fillStyle = colors[k]!;
      g.fillRect(ix, iy, iw, ih);
      g.fillStyle = 'rgba(255,255,255,0.92)';
      const cx = ix + iw / 2,
        cy = iy + ih / 2;
      g.beginPath();
      if (k === 0) {
        // heart
        g.moveTo(cx, cy + 22);
        g.bezierCurveTo(cx - 34, cy - 2, cx - 16, cy - 30, cx, cy - 12);
        g.bezierCurveTo(cx + 16, cy - 30, cx + 34, cy - 2, cx, cy + 22);
      } else if (k === 1) {
        // paper plane
        g.moveTo(cx - 30, cy + 4);
        g.lineTo(cx + 30, cy - 18);
        g.lineTo(cx - 4, cy + 22);
        g.lineTo(cx - 8, cy + 8);
      } else if (k === 2) {
        // house
        g.moveTo(cx - 24, cy + 22);
        g.lineTo(cx - 24, cy - 2);
        g.lineTo(cx, cy - 24);
        g.lineTo(cx + 24, cy - 2);
        g.lineTo(cx + 24, cy + 22);
      } else {
        // star
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
          const rr = i % 2 ? 11 : 26;
          g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        }
      }
      g.closePath();
      g.fill();
      // Denomination and a postmark line.
      g.fillStyle = '#2f2a3a';
      g.font = 'bold 22px sans-serif';
      g.textAlign = 'center';
      g.fillText(['1d', '2d', '5d', '9d'][k]!, cx, m + h - 12);
      g.strokeStyle = 'rgba(47,42,58,0.35)';
      g.lineWidth = 3;
      g.beginPath();
      for (let x = ix - 6; x <= ix + iw + 6; x += 6) g.lineTo(x, iy + 8 + Math.sin(x * 0.4) * 3);
      g.stroke();
      g.restore();
    }
    return texture(device, 'stamps', c);
  });
}
