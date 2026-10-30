/** Build the public Designer into an explicit new directory; no local Vite/config/env loading. */
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReleaseApplication } from './security-release-apps.mjs';
const repository = fileURLToPath(new URL('../', import.meta.url));
export async function buildHostedDesigner(output) {
  assert.ok(typeof output === 'string' && output.trim(), 'HOSTING_OUTPUT_REQUIRED');
  await buildReleaseApplication({
    name: 'model-designer',
    sourceRoot: join(repository, 'apps/model-designer'),
    toolingRoot: join(repository, 'apps/model-designer'),
    output: resolve(output),
    aliases: Object.fromEntries(
      ['sdk', 'shared', 'data-kit', 'data-ui'].map((p) => [
        '@mode-db/' + p,
        join(repository, 'packages', p, 'src/index.ts'),
      ]),
    ),
  });
  return {
    ok: true,
    output: resolve(output),
    configFile: false,
    envFile: false,
    existingDistUnchanged: true,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(
      process.argv.length,
      4,
      'Usage: node scripts/security-hosting-build.mjs --output <new-directory>',
    );
    assert.equal(process.argv[2], '--output');
    process.stdout.write(
      JSON.stringify(await buildHostedDesigner(process.argv[3]), null, 2) + '\n',
    );
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}
