import path from 'node:path';
import { PublishError } from './errors.ts';
import { sriSha384 } from './hash.ts';

/**
 * Post-processing of the built entry document (architecture §2, Security):
 *
 * 1. Every `src` / `href` / `srcset` / `poster` must point inside the bundle (`./…` or a bare relative path).
 *    Absolute URLs, protocol-relative `//host`, root-relative `/x` and `../` escapes are rejected, as are
 *    inline `<script>`s, import maps included (the CSP would block them on device anyway). Inline JSON data
 *    blocks are fine: the CSP does not apply to them.
 * 2. SRI (`integrity="sha384-…" crossorigin="anonymous"`) on every `<script src>` (module or classic),
 *    `<link rel="stylesheet">` and `<link rel="modulepreload">`. Modules the entry imports dynamically and
 *    assets fetched at runtime are not covered (see README, "What the integrity covers").
 * 3. The CSP `<meta http-equiv="Content-Security-Policy">` goes first in `<head>` (right after
 *    `<meta charset>`), so it governs every element after it.
 *
 * Idempotent: an existing CSP meta is replaced and integrity values are recomputed, so `--no-build`
 * re-runs on an already-processed `dist/` give the same result.
 */
export interface ProcessHtmlOptions {
  csp: string;
  /** Bytes of a bundle-relative file (posix path, no leading `./`); throw if it does not exist. */
  readAsset: (relPath: string) => Uint8Array;
  /** Path of the HTML file inside the bundle, for resolving relative refs. Default `index.html`. */
  htmlPath?: string;
}

export interface ProcessHtmlResult {
  html: string;
  /** Bundle-relative path → SRI value that was written. */
  integrity: Record<string, string>;
  /** Every bundle-local file the document references. */
  references: string[];
}

interface Attr {
  name: string;
  value: string | null;
}
interface Tag {
  start: number;
  end: number;
  name: string;
  attrs: Attr[];
  selfClosing: boolean;
}

const REF_ATTRS = new Set(['src', 'href', 'poster', 'srcset']);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/**
 * Inline script types that are data blocks, never executed; the CSP does not apply to them. `importmap` is not one:
 * browsers treat an inline import map as an inline script and the CSP (no 'unsafe-inline') refuses it.
 */
const DATA_SCRIPT_TYPES = new Set(['application/json', 'application/ld+json']);

export function processIndexHtml(html: string, opts: ProcessHtmlOptions): ProcessHtmlResult {
  const htmlPath = opts.htmlPath ?? 'index.html';
  const htmlDir = path.posix.dirname(htmlPath);
  const masked = maskNonMarkup(html);
  const tags = scanTags(html, masked);
  const problems: string[] = [];
  const references = new Set<string>();
  const integrity: Record<string, string> = {};
  const edits: { start: number; end: number; text: string }[] = [];

  for (const tag of tags) {
    if (tag.name === 'meta' && attr(tag, 'http-equiv')?.toLowerCase() === 'content-security-policy') {
      // Drop the old policy together with the line break and indentation in front of it.
      const before = /\n[ \t]*$/.exec(html.slice(0, tag.start));
      edits.push({ start: before ? tag.start - before[0].length : tag.start, end: tag.end, text: '' });
      continue;
    }

    if (tag.name === 'script' && attr(tag, 'src') === undefined) {
      const type = (attr(tag, 'type') ?? '').toLowerCase();
      if (type === 'importmap') {
        problems.push(
          `inline <script type="importmap"> is blocked by the CSP (no 'unsafe-inline'); let Vite bundle the imports: ${snippet(html, tag)}`,
        );
      } else if (!DATA_SCRIPT_TYPES.has(type)) {
        problems.push(`inline <script> is not allowed (CSP blocks it): ${snippet(html, tag)}`);
      }
      continue;
    }

    for (const a of tag.attrs) {
      if (!REF_ATTRS.has(a.name) || a.value === null) continue;
      const refs = a.name === 'srcset' ? a.value.split(',').map((s) => s.trim().split(/\s+/)[0] ?? '') : [a.value];
      for (const ref of refs) {
        const local = resolveLocalRef(ref, htmlDir, tag.name);
        if (local === null) continue; // anchor or data: URI
        if (local instanceof Error) {
          problems.push(`<${tag.name} ${a.name}="${ref}">: ${local.message}`);
          continue;
        }
        try {
          opts.readAsset(local);
        } catch {
          problems.push(`<${tag.name} ${a.name}="${ref}">: ${local} is not in the build output`);
          continue;
        }
        references.add(local);
      }
    }

    const target = sriTarget(tag);
    if (target !== null) {
      const local = resolveLocalRef(target, htmlDir, tag.name);
      if (typeof local !== 'string' || !references.has(local)) continue; // already reported above
      const sri = sriSha384(opts.readAsset(local));
      integrity[local] = sri;
      const attrs = tag.attrs.filter((a) => a.name !== 'integrity' && a.name !== 'crossorigin');
      attrs.push({ name: 'integrity', value: sri }, { name: 'crossorigin', value: 'anonymous' });
      edits.push({ start: tag.start, end: tag.end, text: renderTag({ ...tag, attrs }) });
    }
  }

  if (problems.length > 0) {
    throw new PublishError(`${htmlPath} references things outside the bundle:\n  - ${problems.join('\n  - ')}`);
  }

  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(opts.csp)}" />`;
  const charset = tags.find((t) => t.name === 'meta' && attr(t, 'charset') !== undefined);
  const head = tags.find((t) => t.name === 'head');
  const anchor = charset ?? head;
  if (!anchor) throw new PublishError(`${htmlPath} has no <head>; cannot place the CSP <meta>`);
  const indent = lineIndent(html, anchor.start, anchor === head ? '  ' : '');
  edits.push({ start: anchor.end, end: anchor.end, text: `\n${indent}${meta}` });

  // No BOM: the shell fetches the entry as text (which drops a BOM) and hashes it against `game_versions.sha256`.
  const out = applyEdits(html, edits).replace(/^\uFEFF/, '');
  return { html: out, integrity, references: Array.from(references).sort() };
}

/**
 * `./assets/a.js` → `assets/a.js`. Returns null for things that are not file references (`#frag`,
 * `data:` outside scripts) and an Error for references that leave the bundle.
 */
export function resolveLocalRef(ref: string, htmlDir = '.', tagName = ''): string | null | Error {
  const value = ref.trim();
  if (value === '' || value.startsWith('#')) return null;
  if (/^data:/i.test(value)) {
    return tagName === 'script' ? new Error('data: URIs are not allowed for scripts') : null;
  }
  if (value.startsWith('//') || SCHEME.test(value)) return new Error('external URL; bundle everything under ./');
  if (value.startsWith('/'))
    return new Error('root-relative path; use ./ so the bundle works under games/<slug>/<version>/');
  const clean = value.split(/[?#]/)[0] ?? '';
  const joined = path.posix.normalize(path.posix.join(htmlDir, decodeURIComponent(clean)));
  if (joined === '..' || joined.startsWith('../')) return new Error('path escapes the bundle');
  return joined;
}

function sriTarget(tag: Tag): string | null {
  // Every external script, module or classic: SRI is harmless on a type the browser does not execute.
  if (tag.name === 'script') return attr(tag, 'src') ?? null;
  if (tag.name === 'link') {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('stylesheet') || rel.includes('modulepreload')) return attr(tag, 'href') ?? null;
  }
  return null;
}

function attr(tag: Tag, name: string): string | undefined {
  const a = tag.attrs.find((x) => x.name === name);
  return a ? (a.value ?? '') : undefined;
}

/** Blank out comments and raw-text element bodies (script/style) so tag scanning ignores them; offsets stay aligned. */
function maskNonMarkup(html: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(
      /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
      (_m, open: string, _n: string, body: string, close: string) => open + blank(body) + close,
    );
}

function scanTags(html: string, masked: string): Tag[] {
  const tags: Tag[] = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const raw = html.slice(m.index, m.index + m[0].length);
    const inner = /^<[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*?)?\/?>$/.exec(raw)?.[1] ?? '';
    tags.push({
      start: m.index,
      end: m.index + m[0].length,
      name: m[1]!.toLowerCase(),
      attrs: parseAttrs(inner),
      selfClosing: m[3] === '/',
    });
  }
  return tags;
}

function parseAttrs(text: string): Attr[] {
  const attrs: Attr[] = [];
  const re = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = m[2] ?? m[3] ?? m[4];
    attrs.push({ name: m[1]!.toLowerCase(), value: value === undefined ? null : decodeEntities(value) });
  }
  return attrs;
}

function renderTag(tag: Tag): string {
  const attrs = tag.attrs
    .map((a) => (a.value === null ? ` ${a.name}` : ` ${a.name}="${escapeAttr(a.value)}"`))
    .join('');
  return `<${tag.name}${attrs}${tag.selfClosing ? ' /' : ''}>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function applyEdits(html: string, edits: { start: number; end: number; text: string }[]): string {
  let out = html;
  // Back to front so earlier offsets stay valid; at equal starts the wider edit (a removal) goes first.
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function lineIndent(html: string, index: number, extra: string): string {
  const lineStart = html.lastIndexOf('\n', index - 1) + 1;
  return (/^[ \t]*/.exec(html.slice(lineStart, index))?.[0] ?? '') + extra;
}

function snippet(html: string, tag: Tag): string {
  return html.slice(tag.start, Math.min(tag.end, tag.start + 80));
}
