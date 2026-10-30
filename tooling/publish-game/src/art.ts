import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isLocalArtPath, normalizeLocalArtPath, type GameManifest } from '@rally/protocol';
import { IMMUTABLE_CACHE_CONTROL } from './cache.ts';
import { PublishError } from './errors.ts';
import { sha256Hex } from './hash.ts';
import { BUCKET, contentTypeFor, publicObjectUrl } from './plan.ts';

/** Largest art file the publisher accepts (each of icon, cover, screenshots). */
export const MAX_ART_BYTES = 2 * 1024 * 1024;
/** Covers outside this width/height range only produce a warning. */
export const COVER_ASPECT = { min: 1.2, max: 2.4 } as const;

/**
 * A local art file from game.json, uploaded content-addressed to `games/<slug>/art/<name>-<sha256[0:12]>.<ext>`.
 * The name changes whenever the bytes do, so the object is immutable, safe to upsert, and shared by every version
 * that uses the same file.
 */
export interface PlannedArtUpload {
  /** Path relative to `games/<slug>/`, as written in game.json without a leading `./`. */
  source: string;
  /** Where game.json uses it: `icon`, `cover`, `screenshots[0]`, … */
  usedBy: string[];
  /** Object key inside the bucket: `<slug>/art/<name>-<hash>.<ext>`. */
  objectKey: string;
  /** Public CDN URL written into the `games` row and the stored manifest. */
  url: string;
  size: number;
  sha256: string;
  /** Pixel size read from the file header; null when it could not be read. */
  width: number | null;
  height: number | null;
  headers: { 'content-type': string; 'cache-control': string };
}

export interface ArtPlan {
  uploads: PlannedArtUpload[];
  /** Non-fatal problems (icon not square, cover aspect ratio, unreadable size). */
  warnings: string[];
}

/** Every art reference in the manifest, with the field that holds it. */
function artRefs(m: GameManifest): { field: string; value: string }[] {
  const refs: { field: string; value: string }[] = [];
  if (m.icon !== undefined) refs.push({ field: 'icon', value: m.icon });
  if (m.cover !== undefined) refs.push({ field: 'cover', value: m.cover });
  m.screenshots.forEach((value, i) => refs.push({ field: `screenshots[${i}]`, value }));
  return refs;
}

/**
 * Read every local art file game.json points at (from the game folder, not from `dist/`), check it, hash it and
 * work out its CDN object key and URL. Absolute URLs are left alone. Throws PublishError for a missing file, a path
 * that leaves the game folder, or a file over {@link MAX_ART_BYTES}.
 */
export async function planArt(input: {
  manifest: GameManifest;
  gameDir: string;
  supabaseUrl: string;
}): Promise<ArtPlan> {
  const { manifest, gameDir, supabaseUrl } = input;
  const bySource = new Map<string, PlannedArtUpload>();
  const warnings: string[] = [];
  let realGameDir: string | undefined;

  for (const { field, value } of artRefs(manifest)) {
    if (!isLocalArtPath(value)) continue;
    const source = normalizeLocalArtPath(value);
    const existing = bySource.get(source);
    if (existing) {
      existing.usedBy.push(field);
      checkShape(field, existing, warnings);
      continue;
    }

    const abs = path.resolve(gameDir, source);
    if (!isInside(gameDir, abs)) {
      throw new PublishError(`game.json ${field}: "${value}" points outside games/${manifest.id}/`);
    }
    let size: number;
    try {
      const st = await stat(abs);
      if (!st.isFile()) throw new PublishError(`game.json ${field}: "${value}" is not a file (${abs})`);
      size = st.size;
    } catch (err) {
      if (err instanceof PublishError) throw err;
      throw new PublishError(
        `game.json ${field}: art file "${value}" not found (expected ${abs}; art paths are relative to games/${manifest.id}/)`,
      );
    }
    realGameDir ??= await realpath(gameDir);
    if (!isInside(realGameDir, await realpath(abs))) {
      throw new PublishError(`game.json ${field}: "${value}" resolves outside games/${manifest.id}/ (symlink?)`);
    }
    if (size > MAX_ART_BYTES) {
      throw new PublishError(
        `game.json ${field}: "${value}" is ${(size / 1024 / 1024).toFixed(2)} MB; art files must be at most ${MAX_ART_BYTES / 1024 / 1024} MB (resize or recompress it)`,
      );
    }

    const data = await readFile(abs);
    const sha256 = sha256Hex(data);
    const ext = path.extname(source).slice(1).toLowerCase();
    const objectKey = `${manifest.id}/art/${artBaseName(source)}-${sha256.slice(0, 12)}.${ext}`;
    const dims = imageSize(data);
    if (!dims) {
      warnings.push(`${field} ${source}: could not read the image size (is it really a ${ext.toUpperCase()} file?)`);
    } else if (dims.format !== (ext === 'jpg' ? 'jpeg' : ext)) {
      warnings.push(`${field} ${source}: the file is a ${dims.format.toUpperCase()} image but is named .${ext}`);
    }
    const upload: PlannedArtUpload = {
      source,
      usedBy: [field],
      objectKey,
      url: publicObjectUrl(supabaseUrl, BUCKET, objectKey),
      size: data.byteLength,
      sha256,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      headers: { 'content-type': contentTypeFor(source), 'cache-control': IMMUTABLE_CACHE_CONTROL },
    };
    bySource.set(source, upload);
    checkShape(field, upload, warnings);
  }
  return { uploads: [...bySource.values()], warnings };
}

function checkShape(field: string, u: PlannedArtUpload, warnings: string[]): void {
  if (u.width === null || u.height === null) return;
  const size = `${u.width}×${u.height}`;
  if (field === 'icon' && u.width !== u.height) {
    warnings.push(`icon ${u.source} is ${size}; icons should be square (recommended 1024×1024)`);
  }
  if (field === 'cover') {
    const ratio = u.width / u.height;
    if (ratio < COVER_ASPECT.min || ratio > COVER_ASPECT.max) {
      warnings.push(
        `cover ${u.source} is ${size} (${ratio.toFixed(2)}:1); covers should be wide, ${COVER_ASPECT.min}–${COVER_ASPECT.max}:1 (recommended 1920×1080)`,
      );
    }
  }
}

/** `art/Shot 1.final.PNG` → `shot-1-final`: a short, URL-safe stem for the object name. */
export function artBaseName(source: string): string {
  const stem = path.posix.basename(source, path.posix.extname(source));
  const clean = stem
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return clean || 'art';
}

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface ImageSize {
  format: 'png' | 'jpeg' | 'webp';
  width: number;
  height: number;
}

/** Width and height from a PNG, JPEG or WebP header; null for anything else or a truncated file. */
export function imageSize(buf: Uint8Array): ImageSize | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  try {
    // PNG: signature, then the IHDR chunk (width, height as big-endian u32).
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
      if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    // JPEG: walk the marker segments to the first start-of-frame (SOF0–SOF15 except DHT, JPG, DAC).
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        if (marker === 0xff) {
          i++; // fill byte
          continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          i += 2; // standalone markers carry no length
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { format: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }
    // WebP: RIFF container, first chunk VP8 (lossy), VP8L (lossless) or VP8X (extended).
    if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = b.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') {
        return { format: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') {
        return { format: 'webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
      }
    }
  } catch {
    return null; // truncated header
  }
  return null;
}
