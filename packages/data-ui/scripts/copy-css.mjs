import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  ['src/components/browser-identity-panel.css', 'dist/components/browser-identity-panel.css'],
  ['src/components/data-table.css', 'dist/components/data-table.css'],
  ['src/components/pivot-table.css', 'dist/components/pivot-table.css'],
  ['src/components/import-panel.css', 'dist/components/import-panel.css'],
  ['src/components/data-view-panel.css', 'dist/components/data-view-panel.css'],
  ['src/components/app-shell.css', 'dist/components/app-shell.css'],
  ['src/components/binding-surface.css', 'dist/components/binding-surface.css'],
  ['src/components/query-result-view.css', 'dist/components/query-result-view.css'],
  ['src/components/import-failure-panel.css', 'dist/components/import-failure-panel.css'],
];

for (const [fromRel, toRel] of pairs) {
  const toAbs = join(pkgRoot, toRel);
  mkdirSync(dirname(toAbs), { recursive: true });
  cpSync(join(pkgRoot, fromRel), toAbs);
}
