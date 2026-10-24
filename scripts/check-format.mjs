import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

// Enumerate versioned/development files without globbing through protected runtime
// directories. Keep the existing Prettier ignore policy and check untracked code too.
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const inventory = spawnSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--exclude=/security/'],
  { cwd: root, encoding: 'utf8', windowsHide: true },
);
if (inventory.status !== 0 || inventory.error) {
  process.stderr.write('FORMAT_INVENTORY_UNAVAILABLE\n');
  process.exit(1);
}
const files = [...new Set(inventory.stdout.split('\0'))]
  .filter((path) => /\.(js|ts|tsx|mjs|json|md)$/.test(path) && !path.startsWith('security/'))
  .sort();
let checked = 0,
  failed = false;
for (const path of files) {
  const info = await prettier.getFileInfo(path, { ignorePath: '.prettierignore' });
  if (info.ignored) {
    continue;
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    process.stderr.write(`FORMAT_UNSAFE_PATH: ${path}\n`);
    failed = true;
    continue;
  }
  const options = await prettier.resolveConfig(path);
  checked++;
  if (!(await prettier.check(await readFile(path, 'utf8'), { ...options, filepath: path }))) {
    process.stderr.write(`FORMAT_MISMATCH: ${path}\n`);
    failed = true;
  }
}
process.stdout.write(`Format checked ${checked} development files.\n`);
process.exitCode = failed ? 1 : 0;
