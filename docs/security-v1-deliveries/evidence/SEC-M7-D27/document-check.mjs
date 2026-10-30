/** Evidence-local, read-only documentation verification. No runtime/configuration reads. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const documents = [
  'docs/security-v1/device-registration-deployment-contract.md',
  'docs/modeldb-config-guide.md',
  'docs/security-v1/device-registration-protocol-contract.md',
  'docs/security-v1/device-registration-runtime-guide.md',
  'docs/security-v1/overview.md',
  'docs/security-v1/user-guide.md',
  'docs/security-v1-identity-contract.md',
  'docs/security-v1-authorization-contract.md',
  'docs/security-browser-sessions.md',
  'docs/security-v1-plan.md',
  'docs/security-v1/AGENTS.md',
  'docs/security-v1-milestones.md',
  'docs/security-v1-deliveries/SEC-M7.md',
  'test/README.md',
];
const failures = [];
let links = 0;
const slug = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
for (const path of documents) {
  const source = readFileSync(path, 'utf8');
  for (const [, link] of source.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
    if (/^[a-z]+:/i.test(link)) continue;
    const [relative, anchor] = link.split('#'), target = resolve(dirname(path), decodeURIComponent(relative || path.split('/').at(-1)));
    links++;
    if (!existsSync(target)) {failures.push({path, link, reason: 'missing'}); continue;}
    if (anchor && target.endsWith('.md')) {
      const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => slug(m[1]));
      if (!headings.includes(decodeURIComponent(anchor))) failures.push({path, link, reason: 'anchor'});
    }
  }
}
const milestone = readFileSync('docs/security-v1-milestones.md', 'utf8');
const rows = milestone.split(/\r?\n/).filter(line => /^\| DR-P[1-4]\.\d+\s*\|/.test(line));
const completed = rows.filter(line => /完成（D\d+）/.test(line));
assert.equal(rows.length, 23); assert.equal(completed.length, 16);
assert.match(milestone, /下一项开发任务 \| DR-P3\.6/);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.scripts['test:security:resilience'], 'node scripts/security-authentication-resilience-check.mjs');
assert.equal(pkg.scripts['test:security:deployment:integration'], 'node scripts/security-deployment-wizard-check.mjs');
const localeKeys=['zh','en','ja'].map(locale=>Object.keys(JSON.parse(readFileSync(`apps/model-designer/src/i18n/locales/${locale}/ui.json`,'utf8'))).filter(key=>key.startsWith('identity_')).sort());
assert.ok(localeKeys[0].length>40);assert.deepEqual(localeKeys[0],localeKeys[1]);assert.deepEqual(localeKeys[0],localeKeys[2]);
const expected=localeKeys[0];
for(const locale of ['zh','en','ja']){const messages=JSON.parse(readFileSync('apps/data-studio/src/i18n/locales/'+locale+'/ui.json','utf8'));assert.deepEqual(Object.keys(messages).filter(k=>k.startsWith('identity_')&&k!=='identity_advanced').sort(),expected);for(const key of expected)assert.ok(messages[key].trim());}
const webKeys=[...new Set([...readFileSync('apps/web/src/i18n/messages.ts','utf8').matchAll(/['"]?(identity_[A-Za-z]+)['"]?:/g)].map(m=>m[1]))].filter(k=>k!=='identity_advanced').sort();assert.deepEqual(webKeys,expected);
assert.equal(pkg.scripts['test:security:public-clients'],'node scripts/security-public-clients-check.mjs');
const report = {ok: failures.length === 0, documentFiles: documents.length, localLinksAndAnchors: links, failures, registrationTaskRows: rows.length, completedRegistrationTasks: completed.length, cliExamplesKnown: true};
writeFileSync('docs/security-v1-deliveries/evidence/SEC-M7-D27/documents.original.json.txt', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
assert.equal(failures.length, 0, 'DOCUMENT_LINK_CHECK_FAILED');
