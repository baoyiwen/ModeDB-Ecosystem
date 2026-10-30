/** Focused save-path development check; final acceptance always rebuilds all three applications. */
import { checkDesignerIdentity } from '../../../../scripts/security-designer-identity-check.mjs';
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
const result = await checkDesignerIdentity();
const directory = 'docs/security-v1-deliveries/evidence/SEC-M7-D28/save-preview-' + Date.now(); mkdirSync(directory);
writeFileSync(directory + '/report.json', JSON.stringify(result, null, 2) + '\n');
copyFileSync(result.log, directory + '/original.txt'); cpSync(result.screenshots, directory + '/screenshots', { recursive: true });
console.log(JSON.stringify({ ok: result.ok, directory, root: result.root })); if (!result.ok) process.exitCode = 1;
