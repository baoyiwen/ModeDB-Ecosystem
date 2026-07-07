import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  ['src/components/data-table.css', 'dist/components/data-table.css'],
  ['src/components/pivot-table.css', 'dist/components/pivot-table.css'],
  ['src/components/import-panel.css', 'dist/components/import-panel.css'],
  ['src/components/data-view-panel.css', 'dist/components/data-view-panel.css'],
  ['src/components/app-shell.css', 'dist/components/app-shell.css'],
];

for (const [fromRel, toRel] of pairs) {
  const toAbs = join(pkgRoot, toRel);
  mkdirSync(dirname(toAbs), { recursive: true });
  cpSync(join(pkgRoot, fromRel), toAbs);
}
