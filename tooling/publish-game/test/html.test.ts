import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { processIndexHtml, resolveLocalRef } from '../src/html.ts';

const fixture = path.join(import.meta.dirname, 'fixtures', 'site');
const readAsset = (rel: string) => readFileSync(path.join(fixture, rel));
const html = readFileSync(path.join(fixture, 'index.html'), 'utf8');
const csp = "default-src 'self' https://abc.supabase.co";

// openssl dgst -sha384 -binary <file> | base64
const SRI = {
  'assets/app.js': 'sha384-yr00AOBNDE4G8AT/k7qVWZG1BIGkdFyN54WZ3VduYbKAFj5kgEtR2O7MFUrqpuvD',
  'assets/vendor.js': 'sha384-meth+BM2rYQJK1bc5toCY6h9Dg+mSsIapxKkK5gM3FUiWWG9wYZHEj//LotCqVtT',
  'assets/app.css': 'sha384-OOAocoe9URdSEbKSuC4UfBMdbWnyUwZrR5hgjomiMM3B/YKmdhn8l9D4QtETSrtx',
};

test('injects SRI with exact sha384 values on the entry script, modulepreload and stylesheet', () => {
  const out = processIndexHtml(html, { csp, readAsset });
  assert.deepEqual(out.integrity, SRI);
  assert.ok(
    out.html.includes(
      `<script type="module" src="./assets/app.js" integrity="${SRI['assets/app.js']}" crossorigin="anonymous"></script>`,
    ),
  );
  assert.ok(
    out.html.includes(
      `<link rel="modulepreload" href="./assets/vendor.js" integrity="${SRI['assets/vendor.js']}" crossorigin="anonymous">`,
    ),
  );
  assert.ok(
    out.html.includes(
      `<link rel="stylesheet" href="./assets/app.css" integrity="${SRI['assets/app.css']}" crossorigin="anonymous">`,
    ),
  );
  // The icon is checked but gets no SRI.
  assert.ok(out.html.includes('<link rel="icon" href="./icon.svg" />'));
  assert.deepEqual(out.references, ['assets/app.css', 'assets/app.js', 'assets/vendor.js', 'icon.svg']);
});

test('places the CSP meta right after <meta charset>, before any script', () => {
  const out = processIndexHtml(html, { csp, readAsset });
  const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' https://abc.supabase.co" />`;
  const idx = out.html.indexOf(meta);
  assert.ok(idx > 0, 'CSP meta present');
  assert.ok(out.html.includes(`<meta charset="UTF-8" />\n    ${meta}\n    <title>`));
  assert.ok(idx < out.html.indexOf('<script'));
  assert.equal(out.html.match(/Content-Security-Policy/g)?.length, 1);
});

test('a leading BOM is dropped so the shell hashes the same bytes it fetched as text', () => {
  const out = processIndexHtml(`\uFEFF${html}`, { csp, readAsset }).html;
  assert.ok(!out.startsWith('\uFEFF'));
  assert.equal(out, processIndexHtml(html, { csp, readAsset }).html);
});

test('processing is idempotent (re-run on processed output, new policy replaces old)', () => {
  const once = processIndexHtml(html, { csp, readAsset }).html;
  assert.equal(processIndexHtml(once, { csp, readAsset }).html, once);
  const changed = processIndexHtml(once, { csp: "default-src 'none'", readAsset }).html;
  assert.equal(changed.match(/Content-Security-Policy/g)?.length, 1);
  assert.ok(changed.includes(`content="default-src 'none'"`));
  assert.equal(changed, processIndexHtml(html, { csp: "default-src 'none'", readAsset }).html);
});

test('rejects external, protocol-relative, root-relative and escaping references', () => {
  const cases = [
    '<script type="module" src="https://cdn.example.com/x.js"></script>',
    '<script src="//cdn.example.com/x.js"></script>',
    '<link rel="stylesheet" href="/assets/app.css">',
    '<img src="../secret.png">',
    '<script src="data:text/javascript,alert(1)"></script>',
  ];
  for (const tag of cases) {
    const bad = html.replace('</head>', `${tag}\n</head>`);
    assert.throws(() => processIndexHtml(bad, { csp, readAsset }), /outside the bundle/, tag);
  }
});

test('rejects inline scripts and references to files missing from the build', () => {
  assert.throws(
    () => processIndexHtml(html.replace('</head>', '<script>alert(1)</script></head>'), { csp, readAsset }),
    /inline <script>/,
  );
  assert.doesNotThrow(() =>
    processIndexHtml(html.replace('</head>', '<script type="application/json">{"a":"</div>"}</script></head>'), {
      csp,
      readAsset,
    }),
  );
  assert.throws(
    () => processIndexHtml(html.replace('./assets/app.css', './assets/gone.css'), { csp, readAsset }),
    /gone\.css is not in the build output/,
  );
});

test('ignores references inside comments', () => {
  assert.ok(html.includes('commented.example'));
  assert.doesNotThrow(() => processIndexHtml(html, { csp, readAsset }));
});

test('resolveLocalRef', () => {
  assert.equal(resolveLocalRef('./assets/a.js'), 'assets/a.js');
  assert.equal(resolveLocalRef('assets/a.js?v=1#x'), 'assets/a.js');
  assert.equal(resolveLocalRef('./sub/../a%20b.png'), 'a b.png');
  assert.equal(resolveLocalRef('#frag'), null);
  assert.equal(resolveLocalRef('data:image/png;base64,AA=='), null);
  assert.ok(resolveLocalRef('mailto:x@example.com') instanceof Error);
});

test('classic <script src> gets SRI too, with or without a type', () => {
  for (const tag of [
    '<script src="./assets/vendor.js"></script>',
    '<script type="text/javascript" src="./assets/vendor.js" defer></script>',
  ]) {
    const out = processIndexHtml(html.replace('</head>', `${tag}\n</head>`), { csp, readAsset });
    const classic = /<script(?![^>]*type="module")[^>]*src="\.\/assets\/vendor\.js"[^>]*>/.exec(out.html)?.[0];
    assert.ok(classic, tag);
    assert.ok(classic.includes(`integrity="${SRI['assets/vendor.js']}"`), classic);
    assert.ok(classic.includes('crossorigin="anonymous"'), classic);
  }
});

test('an inline import map is rejected: the CSP would refuse it at runtime', () => {
  assert.throws(
    () =>
      processIndexHtml(html.replace('</head>', '<script type="importmap">{"imports":{}}</script></head>'), {
        csp,
        readAsset,
      }),
    /importmap.*blocked by the CSP/,
  );
  assert.doesNotThrow(() =>
    processIndexHtml(html.replace('</head>', '<script type="application/ld+json">{}</script></head>'), {
      csp,
      readAsset,
    }),
  );
});
