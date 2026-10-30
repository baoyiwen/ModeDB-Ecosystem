/** Check D33 public documentation, task counts and reproducible command examples. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertNoPublicSecrets } from '../../../../scripts/security-full-contract.mjs';

const documents = [
  'docs/security-v1/performance-guide.md',
  'docs/security-v1/overview.md',
  'docs/security-v1/user-guide.md',
  'docs/security-v1/release-guide.md',
  'docs/security-v1/device-registration-runtime-guide.md',
  'docs/security-v1/device-registration-deployment-contract.md',
  'docs/security-v1-plan.md',
  'docs/security-v1/AGENTS.md',
  'docs/security-v1-milestones.md',
  'docs/security-v1-deliveries/SEC-M7.md',
  'test/README.md',
];
const read = (path) => readFileSync(path, 'utf8');
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
const failures = [];
let links = 0;
for (const path of documents) {
  const source = read(path);
  assertNoPublicSecrets(Buffer.from(source));
  for (const [, link] of source.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
    if (/^[a-z]+:/i.test(link)) continue;
    const [relative, anchor] = link.split('#');
    const target = resolve(dirname(path), decodeURIComponent(relative || path.split('/').at(-1)));
    links++;
    if (!existsSync(target)) {
      failures.push({ path, link, reason: 'missing' });
      continue;
    }
    if (anchor && target.endsWith('.md')) {
      const headings = [...read(target).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]));
      if (!headings.includes(decodeURIComponent(anchor)))
        failures.push({ path, link, reason: 'anchor' });
    }
  }
}
const milestone = read('docs/security-v1-milestones.md');
const rows = milestone.split(/\r?\n/).filter((line) => /^\| DR-P[1-4]\.\d+\s*\|/.test(line));
const completed = rows.filter((line) => /完成（D\d+）/.test(line));
assert.equal(rows.length, 23);
assert.equal(completed.length, 22);
assert.match(milestone, /下一项开发任务 \| DR-P4\.6/);
assert.match(milestone, /DR-P4\.5[^\r\n]+完成（D33）/);
assert.match(milestone, /DR-P4\.6[^\r\n]+未开始/);
const pkg = JSON.parse(read('package.json'));
assert.equal(
  pkg.scripts['test:security:performance'],
  'node scripts/security-performance-check.mjs',
);
const guide = read('docs/security-v1/performance-guide.md');
for (const command of ['explore', 'register', 'confirm'])
  assert.ok(guide.includes('security-performance-check.mjs ' + command));
for (const text of ['1000', '48', '64', '15000ms', '60000ms', 'CPU/RSS', 'DR-P4.6'])
  assert.ok(guide.includes(text));
for (const path of ['docs/security-v1/user-guide.md', 'docs/security-v1/release-guide.md'])
  assert.ok(read(path).includes('performance-guide.md'));
const report = {
  ok: failures.length === 0,
  documentFiles: documents.length,
  localLinksAndAnchors: links,
  failures,
  registrationTaskRows: rows.length,
  completedRegistrationTasks: completed.length,
  nextTask: 'DR-P4.6',
  cliExamplesKnown: true,
  boundedSecretScan: true,
};
writeFileSync(
  'docs/security-v1-deliveries/evidence/SEC-M7-D33/documents.json',
  JSON.stringify(report, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(report) + '\n');
assert.equal(failures.length, 0, 'DOCUMENT_LINK_CHECK_FAILED');
