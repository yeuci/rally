import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GameManifestSchema } from '@rally/protocol';
import { artBaseName, imageSize, MAX_ART_BYTES, planArt } from '../src/art.ts';
import { PublishError } from '../src/errors.ts';
import { sha256Hex } from '../src/hash.ts';
import { loadManifest, parseManifest } from '../src/manifest.ts';
import { applyArtUrls, buildPlan, type PublishPlan } from '../src/plan.ts';
import { printPlan, publishGame } from '../src/publish.ts';
import { tempDir, validManifest, writeTree } from './helpers.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const SUPABASE_URL = 'https://abc.supabase.co';
const CDN = `${SUPABASE_URL}/storage/v1/object/public/games`;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** A copy of fixtures/games/arty (game.json + art/) with fixtures/site as its prebuilt client/dist. */
async function artyCopy(): Promise<{ gamesDir: string; gameDir: string }> {
  const gamesDir = await tempDir();
  const gameDir = path.join(gamesDir, 'arty');
  await cp(path.join(FIXTURES, 'games', 'arty'), gameDir, { recursive: true });
  await cp(path.join(FIXTURES, 'site'), path.join(gameDir, 'client', 'dist'), { recursive: true });
  return { gamesDir, gameDir };
}

async function editManifest(gameDir: string, patch: Record<string, unknown>): Promise<void> {
  const file = path.join(gameDir, 'game.json');
  const m = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...m, ...patch }));
}

const hashOf = async (gameDir: string, rel: string) => sha256Hex(await readFile(path.join(gameDir, rel)));

test('imageSize reads PNG, JPEG and WebP headers', async () => {
  const art = path.join(FIXTURES, 'games', 'arty', 'art');
  assert.deepEqual(imageSize(await readFile(path.join(art, 'icon.png'))), { format: 'png', width: 64, height: 64 });
  assert.deepEqual(imageSize(await readFile(path.join(art, 'cover.jpg'))), {
    format: 'jpeg',
    width: 192,
    height: 108,
  });
  assert.deepEqual(imageSize(await readFile(path.join(art, 'shot-1.png'))), { format: 'png', width: 90, height: 160 });
  assert.deepEqual(imageSize(await readFile(path.join(art, 'shot-2.webp'))), {
    format: 'webp',
    width: 160,
    height: 90,
  });

  // Synthetic headers for the WebP variants ImageMagick did not produce above.
  const riff = (chunk: string, body: number[]) => {
    const b = Buffer.alloc(40);
    b.write('RIFF', 0, 'latin1');
    b.write('WEBP', 8, 'latin1');
    b.write(chunk, 12, 'latin1');
    Buffer.from(body).copy(b, 20);
    return b;
  };
  // VP8L (chunk data at 20): signature 0x2f, then 14-bit width-1 and height-1.
  const w = 300 - 1;
  const h = 17 - 1;
  const bits = w | (h << 14);
  assert.deepEqual(imageSize(riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24])), {
    format: 'webp',
    width: 300,
    height: 17,
  });
  // VP8X: flags + reserved, then 24-bit canvas width-1 / height-1 at offsets 24 and 27.
  assert.deepEqual(imageSize(riff('VP8X', [0, 0, 0, 0, 0x2b, 0x01, 0, 0x12, 0, 0])), {
    format: 'webp',
    width: 300,
    height: 19,
  });

  assert.equal(imageSize(Buffer.from('not an image at all, just some text bytes')), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), null, 'truncated JPEG');
  assert.equal(imageSize(new Uint8Array()), null);
});

test('artBaseName makes a short URL-safe stem', () => {
  assert.equal(artBaseName('art/icon.png'), 'icon');
  assert.equal(artBaseName('art/Shot 1.final.PNG'), 'shot-1-final');
  assert.equal(artBaseName('art/---.png'), 'art');
  assert.equal(artBaseName(`art/${'x'.repeat(80)}.png`).length, 40);
});

test('planArt hashes local files from the game folder, keys them by content and leaves URLs alone', async () => {
  const { gameDir } = await artyCopy();
  const manifest = await loadManifest(gameDir);
  const { uploads, warnings } = await planArt({ manifest, gameDir, supabaseUrl: SUPABASE_URL });
  assert.deepEqual(warnings, []);

  const icon = (await hashOf(gameDir, 'art/icon.png')).slice(0, 12);
  const cover = (await hashOf(gameDir, 'art/cover.jpg')).slice(0, 12);
  const shot1 = (await hashOf(gameDir, 'art/shot-1.png')).slice(0, 12);
  const shot2 = (await hashOf(gameDir, 'art/shot-2.webp')).slice(0, 12);
  assert.deepEqual(
    uploads.map((u) => [u.source, u.objectKey, u.usedBy, u.headers['content-type'], u.width, u.height]),
    [
      ['art/icon.png', `arty/art/icon-${icon}.png`, ['icon'], 'image/png', 64, 64],
      ['art/cover.jpg', `arty/art/cover-${cover}.jpg`, ['cover'], 'image/jpeg', 192, 108],
      ['art/shot-1.png', `arty/art/shot-1-${shot1}.png`, ['screenshots[0]'], 'image/png', 90, 160],
      ['art/shot-2.webp', `arty/art/shot-2-${shot2}.webp`, ['screenshots[2]'], 'image/webp', 160, 90],
    ],
  );
  for (const u of uploads) {
    assert.equal(u.url, `${CDN}/${u.objectKey}`);
    assert.equal(u.headers['cache-control'], IMMUTABLE);
    assert.equal(u.sha256, await hashOf(gameDir, u.source));
    assert.equal(u.size, (await readFile(path.join(gameDir, u.source))).byteLength);
  }

  // The same file used twice is uploaded once; shape warnings for a non-square icon and a tall cover.
  await editManifest(gameDir, { icon: 'art/shot-1.png', cover: 'art/shot-1.png', screenshots: ['./art/shot-1.png'] });
  const reused = await planArt({ manifest: await loadManifest(gameDir), gameDir, supabaseUrl: SUPABASE_URL });
  assert.equal(reused.uploads.length, 1);
  assert.deepEqual(reused.uploads[0]!.usedBy, ['icon', 'cover', 'screenshots[0]']);
  assert.deepEqual(reused.warnings, [
    'icon art/shot-1.png is 90×160; icons should be square (recommended 1024×1024)',
    'cover art/shot-1.png is 90×160 (0.56:1); covers should be wide, 1.2–2.4:1 (recommended 1920×1080)',
  ]);

  // A file that is not what its extension says only warns.
  await writeFile(path.join(gameDir, 'art', 'fake.png'), 'definitely not a png');
  await editManifest(gameDir, { icon: undefined, cover: undefined, screenshots: ['art/fake.png'] });
  const fake = await planArt({ manifest: await loadManifest(gameDir), gameDir, supabaseUrl: SUPABASE_URL });
  assert.equal(fake.uploads.length, 1);
  assert.match(fake.warnings[0]!, /screenshots\[0\] art\/fake\.png: could not read the image size/);

  // Nothing local: nothing to upload.
  const none = await planArt({ manifest: parseManifest(validManifest), gameDir, supabaseUrl: SUPABASE_URL });
  assert.deepEqual(none, { uploads: [], warnings: [] });
});

test('planArt refuses missing files, oversized files and paths that escape the game folder', async () => {
  const { gameDir } = await artyCopy();
  const plan = async () => planArt({ manifest: await loadManifest(gameDir), gameDir, supabaseUrl: SUPABASE_URL });

  await editManifest(gameDir, { cover: 'art/missing-cover.jpg' });
  await assert.rejects(
    plan(),
    (e: Error) =>
      e instanceof PublishError &&
      /game\.json cover: art file "art\/missing-cover\.jpg" not found/.test(e.message) &&
      e.message.includes(path.join(gameDir, 'art', 'missing-cover.jpg')),
  );

  assert.equal(GameManifestSchema.safeParse({ ...validManifest, cover: 'art' }).success, false, 'no extension');

  await writeTree(gameDir, { 'art/huge.png': new Uint8Array(MAX_ART_BYTES + 1) });
  await editManifest(gameDir, { cover: undefined, screenshots: ['art/huge.png'] });
  await assert.rejects(plan(), (e: Error) => e instanceof PublishError && /at most 2 MB/.test(e.message));

  await writeTree(gameDir, { 'art/ok.png': await readFile(path.join(gameDir, 'art', 'icon.png')) });
  const outside = path.join(await tempDir(), 'secret.png');
  await writeFile(outside, 'x');
  await symlink(outside, path.join(gameDir, 'art', 'link.png'));
  await editManifest(gameDir, { screenshots: ['art/ok.png', 'art/link.png'] });
  await assert.rejects(
    plan(),
    (e: Error) => e instanceof PublishError && /resolves outside games\/arty/.test(e.message),
  );
});

test('buildPlan rewrites art paths to CDN URLs in the games row and the stored manifest', async () => {
  const { gameDir } = await artyCopy();
  const manifest = await loadManifest(gameDir);
  const art = await planArt({ manifest, gameDir, supabaseUrl: SUPABASE_URL });
  const files = [{ path: 'index.html', sha256: 'a'.repeat(64), size: 10 }];
  const plan = buildPlan({ manifest, files, supabaseUrl: SUPABASE_URL, csp: "default-src 'self'", art: art.uploads });

  const url = (source: string) => art.uploads.find((u) => u.source === source)!.url;
  assert.equal(plan.db.games.icon_url, url('art/icon.png'));
  assert.equal(plan.db.games.cover_url, url('art/cover.jpg'));
  assert.deepEqual(plan.db.games.screenshots, [
    url('art/shot-1.png'),
    'https://cdn.example.com/arty/remote.png',
    url('art/shot-2.webp'),
  ]);
  const stored = plan.db.gameVersion.manifest;
  assert.equal(stored.icon, plan.db.games.icon_url);
  assert.equal(stored.cover, plan.db.games.cover_url);
  assert.deepEqual(stored.screenshots, plan.db.games.screenshots);
  assert.ok(GameManifestSchema.safeParse(stored).success);
  assert.deepEqual(plan.art, art.uploads);
  assert.deepEqual(
    plan.uploads.map((u) => u.objectKey),
    ['arty/1.0.0/index.html'],
    'art is not part of the bundle',
  );

  // Without art: null columns; with a local path but no planned upload: refused.
  const bare = buildPlan({ manifest: parseManifest(validManifest), files, supabaseUrl: SUPABASE_URL, csp: '' });
  assert.equal(bare.db.games.icon_url, null);
  assert.equal(bare.db.games.cover_url, null);
  assert.deepEqual(bare.art, []);
  assert.throws(
    () => buildPlan({ manifest, files, supabaseUrl: SUPABASE_URL, csp: '' }),
    /icon: local art path "art\/icon\.png" has no planned upload/,
  );
  assert.equal(applyArtUrls(parseManifest(validManifest), []).icon, undefined);
});

test('dry run with local art: the plan and publish-plan.json list the art uploads and the rewritten URLs', async () => {
  const { gamesDir } = await artyCopy();
  const out = path.join(await tempDir(), 'publish-plan.json');
  const logs: string[] = [];
  const { plan } = await publishGame({
    slug: 'arty',
    dryRun: true,
    build: false,
    gamesDir,
    planOut: out,
    env: { SUPABASE_URL },
    log: (l) => logs.push(l),
  });
  assert.ok(plan);
  const written = JSON.parse(await readFile(out, 'utf8')) as PublishPlan;
  assert.deepEqual(written, JSON.parse(JSON.stringify(plan)));

  assert.equal(written.art.length, 4);
  for (const a of written.art) {
    assert.match(a.objectKey, /^arty\/art\/[a-z0-9-]+-[a-f0-9]{12}\.(png|jpg|webp)$/);
    assert.equal(a.url, `${CDN}/${a.objectKey}`);
    assert.equal(a.headers['cache-control'], IMMUTABLE);
  }
  const icon = written.art.find((a) => a.usedBy.includes('icon'))!;
  const cover = written.art.find((a) => a.usedBy.includes('cover'))!;
  assert.equal(written.db.games.icon_url, icon.url);
  assert.equal(written.db.games.cover_url, cover.url);
  assert.equal(written.db.games.screenshots[1], 'https://cdn.example.com/arty/remote.png');
  assert.ok(written.db.games.screenshots.every((s) => s.startsWith('https://')));
  assert.equal(written.db.gameVersion.manifest.icon, icon.url);
  assert.ok(GameManifestSchema.safeParse(written.db.gameVersion.manifest).success);
  // The bundle uploads stay the dist/ files under the version prefix.
  assert.ok(written.uploads.every((u) => u.objectKey.startsWith('arty/1.0.0/')));

  const text = logs.join('\n');
  assert.match(text, /• art: 4 local file\(s\), .* → games\/arty\/art\//);
  assert.match(text, /art {8}games\/arty\/art\/ {2}\(content-addressed, upsert; skipped when already uploaded\)/);
  assert.match(text, /art\/icon\.png +→ arty\/art\/icon-[a-f0-9]{12}\.png +\S+ B +image\/png +64×64 +icon/);
  assert.match(text, /art\/cover\.jpg +→ arty\/art\/cover-[a-f0-9]{12}\.jpg .* 192×108 +cover/);
  assert.ok(!text.includes('warning'), 'square icon and 16:9 cover: no warnings');

  // Printout for a game without art.
  const lines: string[] = [];
  printPlan(
    buildPlan({
      manifest: parseManifest(validManifest),
      files: [{ path: 'index.html', sha256: 'a'.repeat(64), size: 1 }],
      supabaseUrl: SUPABASE_URL,
      csp: '',
    }),
    (l) => lines.push(l),
  );
  assert.ok(lines.some((l) => /^ {2}art {8}none/.test(l)));
});

test('dry run fails with a clear error when an art file is missing (before building)', async () => {
  const { gamesDir, gameDir } = await artyCopy();
  await editManifest(gameDir, { icon: 'art/nope.png' });
  await assert.rejects(
    publishGame({ slug: 'arty', dryRun: true, gamesDir, env: { SUPABASE_URL }, log: () => {} }),
    (e: Error) => e instanceof PublishError && /game\.json icon: art file "art\/nope\.png" not found/.test(e.message),
  );
});
