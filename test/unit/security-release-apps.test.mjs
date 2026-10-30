import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { buildReleaseApplication } from '../../scripts/security-release-apps.mjs';

it('builds a synthetic page without executing Vite config or loading local env files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Release-App-Test-'));
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot);
  const marker = join(root, 'config-was-executed');
  writeFileSync(join(sourceRoot, 'vite.config.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('LOCAL_CONFIG_EXECUTED');`);
  writeFileSync(join(sourceRoot, '.env.production'), 'VITE_SYNTHETIC_SECRET=ENV_FILE_MUST_NOT_BE_BUNDLED\n');
  writeFileSync(join(sourceRoot, 'index.html'), '<script type="module" src="/main.js"></script>');
  writeFileSync(join(sourceRoot, 'main.js'), 'document.title=String(import.meta.env.VITE_SYNTHETIC_SECRET);');
  const output = join(root, 'output');
  await buildReleaseApplication({ name: 'model-designer', sourceRoot, toolingRoot: resolve('apps/model-designer'), output, aliases: {} });
  assert.equal(existsSync(marker), false);
  assert.ok(existsSync(join(output, 'index.html')));
  const bundle = readdirSync(join(output, 'assets')).map(name => readFileSync(join(output, 'assets', name), 'utf8')).join('\n');
  assert.ok(!bundle.includes('ENV_FILE_MUST_NOT_BE_BUNDLED'));
  assert.match(bundle, /undefined|void 0/);
  await assert.rejects(buildReleaseApplication({ name: 'model-designer', sourceRoot, toolingRoot: resolve('apps/model-designer'), output, aliases: {} }), /RELEASE_APP_OUTPUT_EXISTS/);
  await assert.rejects(buildReleaseApplication({ name: 'unknown', sourceRoot, toolingRoot: resolve('apps/model-designer'), output: join(root, 'other'), aliases: {} }), /RELEASE_APP_UNKNOWN/);
});
