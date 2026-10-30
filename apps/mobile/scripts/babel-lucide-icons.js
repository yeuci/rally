/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Rewrites `import { XIcon, type LucideIcon } from 'lucide-react-native'` into one import per icon module
 * (`lucide-react-native/icons/x`). Metro does not tree-shake, so the barrel import drags every icon
 * (~1,600 modules, ~8 MB of dev JS) into the bundle; the shell uses about two dozen.
 *
 * The icon → file map is read from the package's own ESM barrel, so aliases (`Trash2Icon`, `LucideTrash2`) resolve
 * exactly as the package would. Type-only specifiers are left alone (TypeScript strips them), and an import that
 * names anything that is not an icon (e.g. `createLucideIcon`) is kept as it is.
 */
const fs = require('node:fs');
const path = require('node:path');

let map = null;
function iconMap() {
  if (map) return map;
  map = new Map();
  // The package's `exports` hides package.json; resolve the CJS entry and walk up to the package root instead.
  const root = path.dirname(path.dirname(path.dirname(require.resolve('lucide-react-native'))));
  const barrel = path.join(root, 'dist/esm/lucide-react-native.mjs');
  const src = fs.readFileSync(barrel, 'utf8');
  const re = /export \{([^}]+)\} from '\.\/icons\/([a-z0-9-]+)\.mjs';/g;
  for (let m; (m = re.exec(src)); ) {
    for (const part of m[1].split(',')) {
      const alias = /default as (\w+)/.exec(part);
      if (alias) map.set(alias[1], m[2]);
    }
  }
  return map;
}

module.exports = function lucideIcons({ types: t }) {
  return {
    name: 'rally-lucide-icons',
    visitor: {
      ImportDeclaration(p) {
        if (p.node.source.value !== 'lucide-react-native' || p.node.importKind === 'type') return;
        const icons = iconMap();
        const specs = p.node.specifiers;
        const values = specs.filter((s) => t.isImportSpecifier(s) && s.importKind !== 'type');
        if (values.length === 0) return; // type-only specifiers: nothing to rewrite
        if (specs.some((s) => !t.isImportSpecifier(s))) return; // default / namespace import: leave it
        if (!values.every((s) => icons.has(s.imported.name))) return;
        const out = values.map((s) =>
          t.importDeclaration([t.importDefaultSpecifier(s.local)], t.stringLiteral(`lucide-react-native/icons/${icons.get(s.imported.name)}`)),
        );
        const types = specs.filter((s) => s.importKind === 'type');
        if (types.length > 0) {
          const typeImport = t.importDeclaration(types, t.stringLiteral('lucide-react-native'));
          typeImport.importKind = 'type';
          out.push(typeImport);
        }
        p.replaceWithMultiple(out);
      },
    },
  };
};
