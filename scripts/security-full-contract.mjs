/** DR-P4.4 metadata and public-output checks. Never accepts an instance/configuration path. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './security-install-contract.mjs';
import { assertRegressionReport } from './security-regression-contract.mjs';
import { validateCandidateResults } from './security-browser-candidate-check.mjs';
export function fullSourceSnapshot(repository) {
  const inventory = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--exclude=/security/'],
    { cwd: repository, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(inventory.status, 0, 'FULL_SOURCE_INVENTORY_REQUIRED');
  const allow = (path) =>
    !/(^|\/)(dist|node_modules|modeldb)(\/|$)/.test(path) &&
    !/modeldb\.config|\.local\.|(^|\/)\.env/.test(path) &&
    (/^(package\.json|pnpm-lock\.yaml|tsconfig\.json)$/.test(path) ||
      (/^packages\/(shared|common|core|server|sdk|data-kit|data-ui)\/(src\/|authoring\/|facade\/|index\.ts$|package\.json$|tsconfig(?:\.build)?\.json$)/.test(
        path,
      ) &&
        /\.(?:ts|tsx|json|css)$/.test(path)) ||
      (/^apps\/(model-designer|data-studio|web)\/(src\/|public\/|index\.html$|package\.json$|tsconfig(?:\.app)?\.json$)/.test(
        path,
      ) &&
        /\.(?:ts|tsx|json|css|svg|html)$/.test(path)) ||
      /^scripts\/(?:security-[^/]+|assert-[^/]+|minify-module|obfuscate-dist)\.(?:ts|mjs|ps1)$/.test(
        path,
      ) ||
      /^test\/(?:unit|integration|fixtures|helpers)\/.+\.(?:ts|tsx|mjs|json|txt|crt|key)$/.test(
        path,
      ) ||
      path === 'test/vault-keys.ts');
  return [...new Set(inventory.stdout.split('\0').filter(allow))].sort().map((path) => {
    let current = repository;
    for (const part of path.split('/')) {
      current = join(current, part);
      assert.equal(lstatSync(current).isSymbolicLink(), false, 'FULL_SOURCE_LINK_REJECTED');
    }
    assert.equal(lstatSync(current).isFile(), true);
    return { path, sha256: sha256(readFileSync(current)) };
  });
}
export function assertNoPublicSecrets(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  // Bounded known patterns plus dynamic-material assertions in the actual recovery/auth tests.
  assert.doesNotMatch(
    text,
    /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]{20,}?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/,
    'FULL_PRIVATE_KEY_EXPOSURE',
  );
  assert.doesNotMatch(
    text,
    /Bearer\s+(?:mdb[a-z_-]*[.:])?[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]+)*/,
    'FULL_BEARER_EXPOSURE',
  );
  assert.doesNotMatch(
    text,
    /[?&](?:token|pairingCode|session|csrf)=[A-Za-z0-9_-]{24,}/i,
    'FULL_URL_SECRET_EXPOSURE',
  );
}
export const extraNativeNames = [
  'registration',
  'authentication',
  'recipients',
  'asset',
  'delivery',
];
export function assertFullCheckReport(report) {
  assert.equal(report.format, 'modeldb.security-full-check.v1');
  assert.equal(report.task, 'DR-P4.4');
  assert.equal(report.ok, true);
  assert.equal(report.platform, 'win32');
  assertRegressionReport(report.regression);
  validateCandidateResults(report.browser);
  assert.deepEqual(
    report.native.map((g) => g.name),
    extraNativeNames,
  );
  assert.deepEqual(
    report.native.map((g) => g.unit.pass),
    [9, 1, 1, 1, 1],
  );
  for (const group of report.native) {
    assert.equal(group.exitCode, 0);
    assert.equal(group.timedOut, false);
    for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
      assert.equal(group.unit[key], 0);
    }
  }
  assert.equal(report.totalPass, report.regression.unit.pass + report.browser.totalNativePass + 13);
  for (const key of [
    'sourceUnchanged',
    'allUnitFiles',
    'sixEngineFlows',
    'authenticationRecovery',
    'registeredRecovery',
    'publicArtifactsScanned',
    'strictTypes',
    'browserBoundary',
  ]) {
    assert.equal(report.checks[key], true);
  }
  assert.equal(report.scope.temporarySyntheticOnly, true);
  for (const key of [
    'liveMaterialRead',
    'hardwareAuthenticatorTested',
    'realTwoDeviceTested',
    'systemTrustInstalled',
    'performanceTested',
    'productionMigrationPerformed',
    'frontendChanged',
  ]) {
    assert.equal(report.scope[key], false);
  }
}
