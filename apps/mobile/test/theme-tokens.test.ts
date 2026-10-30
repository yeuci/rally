import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PALETTE } from '../src/lib/brand';

/** `--color-<name>: <value>;` of one `@variant <theme> { … }` block in global.css. */
function tokens(theme: 'light' | 'dark'): Map<string, string> {
  const css = readFileSync(join(__dirname, '..', 'global.css'), 'utf8');
  const start = css.indexOf(`@variant ${theme} {`);
  assert.ok(start >= 0, `@variant ${theme}`);
  const block = css.slice(start, css.indexOf('}', start));
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const norm = (v: string) => v.toLowerCase().replace(/\s+/g, '');

test('PALETTE mirrors the global.css tokens it duplicates, in both themes', () => {
  const keys: Record<string, keyof (typeof PALETTE)['dark']> = {
    background: 'background',
    foreground: 'foreground',
    card: 'card',
    muted: 'muted',
    'muted-foreground': 'mutedForeground',
    border: 'border',
    primary: 'primary',
    'primary-foreground': 'primaryForeground',
    ring: 'ring',
    destructive: 'destructive',
    skeleton: 'skeleton',
    'skeleton-highlight': 'skeletonHighlight',
    backdrop: 'backdrop',
  };
  for (const theme of ['light', 'dark'] as const) {
    const css = tokens(theme);
    for (const [token, key] of Object.entries(keys)) {
      assert.ok(css.has(token), `${theme}: --color-${token}`);
      assert.equal(norm(css.get(token)!), norm(PALETTE[theme][key]), `${theme}: --color-${token} vs PALETTE.${key}`);
    }
  }
});

test('podium and backdrop tokens exist in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    const css = tokens(theme);
    for (const medal of ['gold', 'silver', 'bronze']) {
      for (const suffix of ['', '-soft', '-line'])
        assert.ok(css.has(`${medal}${suffix}`), `${theme}: --color-${medal}${suffix}`);
    }
    assert.ok(css.has('backdrop'));
  }
});
