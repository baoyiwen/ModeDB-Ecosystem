/** Check current instructions and counts; no runtime files. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertNoPublicSecrets } from '../../../../scripts/security-full-contract.mjs';
const documents = ['docs/security-v1/windows-device-drill-guide.md', 'docs/security-v1/AGENTS.md', 'docs/security-v1-plan.md', 'docs/security-v1-milestones.md', 'docs/security-v1-deliveries/SEC-M7.md', 'docs/security-v1/overview.md', 'docs/security-v1/user-guide.md', 'docs/security-v1/release-guide.md', 'docs/security-v1/device-registration-runtime-guide.md', 'test/README.md'];
const read = (path) => readFileSync(path, 'utf8');
const failures = [];
let links = 0;
const slug = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
for (const path of documents) {
  const text = read(path); assertNoPublicSecrets(Buffer.from(text));
  for (const [, link] of text.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
    if (/^[a-z]+:/i.test(link)) continue;
    const [relative, anchor] = link.split('#');
    const target = resolve(dirname(path), decodeURIComponent(relative || path.split('/').at(-1))); links++;
    if (!existsSync(target)) failures.push({ path, link, reason: 'missing' });
    else if (anchor && target.endsWith('.md') && ![...read(target).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])).includes(decodeURIComponent(anchor))) failures.push({ path, link, reason: 'anchor' });
  }
}
const rows = read('docs/security-v1-milestones.md').split(/\r?\n/).filter((line) => /^\| DR-P[1-4]\.\d+\s*\|/.test(line));
assert.equal(rows.length, 23); assert.equal(rows.filter((line) => /完成（D\d+）/.test(line)).length, 22);
assert.match(rows.find((line) => /^\| DR-P4\.6\s*\|/.test(line)), /进行中（D34/);
for (const action of ['Prepare', 'Serve', 'Client']) assert.ok(read(documents[0]).includes('-Action ' + action));
for (const token of ['taskComplete', 'attestation none', 'Windows Hello', 'transfer', 'stop', 'restart', '恢复']) assert.ok(read(documents[0]).includes(token));
const result = { ok: failures.length === 0, documentFiles: documents.length, links, tasks: '22/23', taskStatus: 'waiting-for-actual-devices', failures };
writeFileSync('docs/security-v1-deliveries/evidence/SEC-M7-D34/documents.json', JSON.stringify(result, null, 2) + '\n');
assert.deepEqual(failures, []); process.stdout.write(JSON.stringify(result) + '\n');
