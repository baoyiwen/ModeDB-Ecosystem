/** Read-only development document checks; output contains counts and public links only. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const documents = [
  'docs/security-v1/recipient-key-contract.md',
  'docs/security-v1/device-registration-proposal.md',
  'docs/security-v1/release-guide.md',
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
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
for (const path of documents) {
  const source = readFileSync(path, 'utf8');
  for (const [, link] of source.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
    if (/^[a-z]+:/i.test(link)) continue;
    const [relative, anchor] = link.split('#'),
      target = resolve(dirname(path), decodeURIComponent(relative || path.split('/').at(-1)));
    links++;
    if (!existsSync(target)) {
      failures.push({ path, link, reason: 'missing' });
      continue;
    }
    if (anchor && target.endsWith('.md')) {
      const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
        slug(m[1]),
      );
      if (!headings.includes(decodeURIComponent(anchor)))
        failures.push({ path, link, reason: 'anchor' });
    }
  }
}
const milestone = readFileSync('docs/security-v1-milestones.md', 'utf8');
const rows = milestone.split(/\r?\n/).filter((line) => /^\| DR-P[1-4]\.\d+\s*\|/.test(line)),
  completed = rows.filter((line) => /完成（D\d+）/.test(line));
assert.equal(rows.length, 23);
assert.equal(completed.length, 21);
assert.match(milestone, /下一项开发任务 \| DR-P4\.5/);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(
  pkg.scripts['test:security:browser-candidate'],
  'node scripts/security-browser-candidate-check.mjs',
);
assert.equal(pkg.scripts['test:security:install'], 'node scripts/security-install-check.mjs');
assert.equal(pkg.scripts['test:security:full'], 'node scripts/security-full-check.mjs');
for (const path of ['docs/security-v1/user-guide.md', 'docs/security-v1/release-guide.md']) {
  assert.ok(readFileSync(path, 'utf8').includes('security-full-check.mjs'));
}
const guide = readFileSync('docs/security-v1/device-registration-runtime-guide.md', 'utf8');
for (const option of [
  '--recipient-id',
  '--recipient-user',
  '--recipient-version',
  '--recipient-fingerprint',
  '--revision',
])
  assert.ok(guide.includes(option));
const report = {
  ok: failures.length === 0,
  documentFiles: documents.length,
  localLinksAndAnchors: links,
  failures,
  registrationTaskRows: rows.length,
  completedRegistrationTasks: completed.length,
  cliExamplesKnown: true,
};
writeFileSync(
  'docs/security-v1-deliveries/evidence/SEC-M7-D32/documents.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report));
assert.equal(failures.length, 0, 'DOCUMENT_LINK_CHECK_FAILED');
