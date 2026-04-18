/**
 * Copies AI/workspace guidance into **`./modeldb/AGENTS.md`** at the consuming project root.
 * Uses **`INIT_CWD`** (npm/pnpm) when present so installs from nested **`node_modules`** still target the app workspace.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const template = join(pkgRoot, 'templates', 'modeldb', 'AGENTS.md');
const rawInit = process.env.INIT_CWD?.trim();
const cwd = rawInit && rawInit.length > 0 ? rawInit : process.cwd();
const destDir = join(cwd, 'modeldb');
const destFile = join(destDir, 'AGENTS.md');

if (!existsSync(template)) {
  process.exit(0);
}

if (existsSync(destFile)) {
  process.exit(0);
}

try {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(template, destFile);
} catch {
  process.exit(0);
}
