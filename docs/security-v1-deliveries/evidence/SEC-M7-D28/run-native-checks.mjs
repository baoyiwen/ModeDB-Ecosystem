/** Reproducible candidate acceptance. Every run is retained under a new evidence subdirectory. */
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkBrowserCandidate } from '../../../../scripts/security-browser-candidate-check.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D28/';
const result = await checkBrowserCandidate();
const directory = join(base, 'run-' + Date.now()); mkdirSync(directory);
writeFileSync(join(directory, 'original-result.json.txt'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
for (const name of ['candidate-check.json', 'candidate-manifest.json', ...result.groups.map(g => g.log)]) if (existsSync(join(result.root, name))) copyFileSync(join(result.root, name), join(directory, name));
if (existsSync(join(result.root, 'screenshots'))) cpSync(join(result.root, 'screenshots'), join(directory, 'screenshots'), { recursive: true });
console.log(JSON.stringify({ ok: result.ok, directory, root: result.root, totalNativePass: result.totalNativePass }));
if (result.ok) writeFileSync(base + 'selected-candidate.json', JSON.stringify({ directory: directory.replaceAll('\\', '/'), candidateSha256: result.candidateSha256 }, null, 2) + '\n');
assert.equal(result.ok, true, result.failureCode);
