/** Focused development verification; the final candidate reruns this test on all shared builds. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostedDesigner } from '../../../../scripts/security-hosting-build.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D28/';
const root = mkdtempSync(join(tmpdir(), 'ModeDB-Hostile-Preview-')), output = join(root, 'build');
await buildHostedDesigner(output);
const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--test', '--test-reporter=tap', 'test/integration/security-hostile-browser.test.ts'], { encoding: 'utf8', windowsHide: true, timeout: 210000, env: { ...process.env, MODELDB_HOSTING_TEST_BUILD: output } });
const name = 'hostile-preview-' + Date.now() + '.original.txt';
writeFileSync(base + name, (result.stdout ?? '') + (result.stderr ?? ''), { flag: 'wx' });
console.log(JSON.stringify({ exitCode: result.status, root, log: base + name }));
process.exitCode = result.status === 0 ? 0 : 1;
