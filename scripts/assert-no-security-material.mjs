/** Reject tracked runtime security material using Git path metadata only. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));

export function assertNoSecurityMaterial(root = repository) {
  const inventory = spawnSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (inventory.error || inventory.status !== 0) {
    throw new Error('SECURITY_GIT_INDEX_UNAVAILABLE');
  }
  const entries = inventory.stdout.split('\0').filter((path) => /^security(?:\/|$)/i.test(path));
  if (entries.length) {
    throw new Error(`SECURITY_RUNTIME_MATERIAL_TRACKED: ${entries.length}`);
  }
  return { ok: true, trackedRuntimeEntries: 0, materialRead: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(assertNoSecurityMaterial()) + '\n');
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}
