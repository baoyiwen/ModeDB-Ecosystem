import { parsePublicClientsTap, publicClientChecks } from './security-public-clients-check.mjs';
import { verifyBrowserCandidateEvidence } from './security-browser-candidate-evidence.mjs';
import { verifyRecipientEvidence } from './security-recipient-evidence.mjs';
import { verifyRecipientDeliveryEvidence } from './security-recipient-delivery-evidence.mjs';
import { verifyInstallEvidence } from './security-install-evidence.mjs';
import { verifyFullEvidence } from './security-full-evidence.mjs';
import { verifyPerformanceEvidence } from './security-performance-evidence.mjs';
import { verifyDevicePreparationEvidence } from './security-device-drill-evidence.mjs';
/** Read-only acceptance integrity checks; never opens an instance or runtime directory. */
import assert from 'node:assert/strict';
import { parseDeploymentTap, deploymentChecks } from './security-deployment-wizard-check.mjs';
import { parseIdentityAdminTap, identityAdminChecks } from './security-identity-admin-check.mjs';
import { parseAuthenticationIntegrationTap } from './security-authentication-integration-check.mjs';
import { parseAuthenticationResilienceTap } from './security-authentication-resilience-check.mjs';
import {
  parseIdentityBrowserTap,
  identityBrowserChecks,
} from './security-designer-identity-check.mjs';
import {
  parseHostingIntegrationTap,
  nativeChecks,
  browserChecks,
} from './security-hosting-integration-check.mjs';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const receipts = [
  'SEC-M7-D34',
  'SEC-M7-D33',
  'SEC-M7-D32',
  'SEC-M7-D31',
  'SEC-M7-D30',
  'SEC-M7-D29',
  'SEC-M7-D28',
  'SEC-M7-D27',
  'SEC-M7-D26',
  'SEC-M7-D25',
  'SEC-M7-D24',
  'SEC-M7-D23',
  'SEC-M7-D22',
  'SEC-M7-D21',
  'SEC-M7-D20',
  'SEC-M7-D19',
  'SEC-M7-D18',
  'SEC-M7-D17',
  'SEC-M7-D16',
  'SEC-M7-D15',
  'SEC-M7-D14',
  'SEC-M7-D13',
  'SEC-M7-D12',
  'SEC-M7-D11',
  'SEC-M7-D05',
  'SEC-M7-D04',
  'SEC-M7-D03',
].map((revision) => `docs/security-v1-deliveries/evidence/${revision}/acceptance.json`);
const historicalRoot = 'docs/security-v1-deliveries/evidence/SEC-M7-D02/';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readDevelopment(root, relative) {
  assert.ok(
    typeof relative === 'string' &&
      !relative.includes('\\') &&
      !relative.includes(':') &&
      relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
      (/^(docs|scripts|test|apps|packages)\/.+\.(json|md|mjs|js|ts|tsx|css|txt|ps1|html|svg)$/.test(
        relative,
      ) ||
        /^test\/fixtures\/security-registration-tls\/modeldb-a\.(crt|key)$/.test(relative) ||
        /^test\/fixtures\/security-tls\/localhost\.(crt|key)$/.test(relative) ||
        relative === 'scripts/security-registration-dependencies/pnpm-lock.yaml' ||
        /^docs\/security-v1-deliveries\/evidence\/SEC-M7-D\d+\/.+\.png$/.test(relative) ||
        /^docs\/security-v1-deliveries\/evidence\/SEC-M7-D28\/run-\d+\/(?:hosting|identity|admin|deployment|public|hostile)\.tap$/.test(
          relative,
        ) ||
        /^docs\/security-v1-deliveries\/evidence\/SEC-M7-D32\/browser\/(?:hosting|identity|admin|deployment|public|hostile)\.tap$/.test(
          relative,
        ) ||
        [
          'package.json',
          'tsconfig.json',
          'pnpm-lock.yaml',
          'eslint.config.js',
          '.gitignore',
          '.gitattributes',
        ].includes(relative)) &&
      !relative.split('/').includes('modeldb.config.json'),
    'EVIDENCE_DEVELOPMENT_PATH_REQUIRED',
  );
  let current = root;
  for (const part of relative.split('/')) {
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), 'EVIDENCE_LINK_REJECTED');
  }
  assert.ok(lstatSync(current).isFile(), 'EVIDENCE_FILE_REQUIRED');
  return readFileSync(current);
}

export function verifyReleaseEvidence(root = repository) {
  root = realpathSync(root);
  const read = (path) => readDevelopment(root, path);
  const json = (path) => JSON.parse(read(path).toString('utf8'));
  const receiptPath = receipts.find((path) => existsSync(join(root, path)));
  assert.ok(receiptPath, 'EVIDENCE_RECEIPT_REQUIRED');
  const receipt = json(receiptPath);
  assert.equal(receipt.format, 'modeldb.security-release-recheck.v1');
  if (
    [
      'SEC-M7-D04',
      'SEC-M7-D05',
      'SEC-M7-D11',
      'SEC-M7-D12',
      'SEC-M7-D13',
      'SEC-M7-D14',
      'SEC-M7-D15',
      'SEC-M7-D16',
      'SEC-M7-D17',
      'SEC-M7-D18',
      'SEC-M7-D19',
      'SEC-M7-D20',
      'SEC-M7-D21',
      'SEC-M7-D22',
      'SEC-M7-D23',
      'SEC-M7-D24',
      'SEC-M7-D25',
      'SEC-M7-D26',
      'SEC-M7-D27',
      'SEC-M7-D28',
      'SEC-M7-D29',
      'SEC-M7-D30',
      'SEC-M7-D31',
      'SEC-M7-D32',
      'SEC-M7-D33',
    ].includes(receipt.revision)
  ) {
    assert.equal(receipt.verification?.status, 'passed', 'EVIDENCE_VERIFICATION_INCOMPLETE');
  }
  assert.ok(receipt.files.length > 0 && receipt.historicalEvidence.length > 0);
  const seen = new Set();
  let normalizedFiles = 0;
  for (const file of receipt.files) {
    assert.ok(!seen.has(file.path), 'EVIDENCE_DUPLICATE_PATH');
    seen.add(file.path);
    const bytes = read(file.path);
    if (sha256(bytes) !== file.sha256) {
      assert.match(file.sha256Lf, /^[a-f0-9]{64}$/);
      assert.equal(
        sha256(bytes.toString('utf8').replace(/\r\n/g, '\n')),
        file.sha256Lf,
        `EVIDENCE_SOURCE_CHANGED: ${file.path}`,
      );
      normalizedFiles++;
    }
  }
  for (const file of receipt.historicalEvidence) {
    assert.ok(
      file.path.startsWith(historicalRoot) ||
        /^docs\/security-v1-deliveries\/evidence\/SEC-M7-D(?:04|05|09|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29|30|31|32|33)\//.test(
          file.path,
        ) ||
        file.path === 'docs/security-v1-deliveries/evidence/SEC-M7-D03/acceptance.json',
      'EVIDENCE_HISTORICAL_PATH_REQUIRED',
    );
    assert.equal(sha256(read(file.path)), file.sha256, `EVIDENCE_REPORT_CHANGED: ${file.path}`);
  }
  for (const file of receipt.verificationArtifacts ?? []) {
    assert.ok(
      file.path.startsWith(receiptPath.slice(0, -'acceptance.json'.length)) &&
        file.path !== receiptPath,
      'EVIDENCE_VERIFICATION_PATH_REQUIRED',
    );
    assert.equal(sha256(read(file.path)), file.sha256, `EVIDENCE_REPORT_CHANGED: ${file.path}`);
  }
  for (const transition of receipt.eolReconciliation ?? []) {
    const current = read(transition.path);
    const reconstructed = read(transition.reconstructedCopy);
    assert.equal(sha256(current), transition.committedSha256);
    assert.equal(sha256(reconstructed), transition.recordedD03Sha256);
    assert.equal(
      current.toString('utf8').replace(/\r\n/g, '\n'),
      reconstructed.toString('utf8').replace(/\r\n/g, '\n'),
      'EVIDENCE_RECONSTRUCTED_CONTENT_CHANGED',
    );
  }

  let currentVerification;
  if (receipt.revision === 'SEC-M7-D34') {
    currentVerification = verifyDevicePreparationEvidence({
      read,
      receipt,
      base: receiptPath.slice(0, -'acceptance.json'.length),
    });
  } else if (receipt.revision === 'SEC-M7-D33') {
    currentVerification = verifyPerformanceEvidence({
      read,
      receipt,
      base: receiptPath.slice(0, -'acceptance.json'.length),
    });
  } else if (receipt.revision === 'SEC-M7-D32') {
    currentVerification = verifyFullEvidence({
      read,
      receipt,
      base: receiptPath.slice(0, -'acceptance.json'.length),
    });
  } else if (receipt.revision === 'SEC-M7-D31') {
    currentVerification = verifyInstallEvidence({
      read,
      receipt,
      base: receiptPath.slice(0, -'acceptance.json'.length),
    });
  } else if (receipt.revision === 'SEC-M7-D30') {
    currentVerification = verifyRecipientDeliveryEvidence({
      read,
      receipt,
      base: receiptPath.slice(0, -'acceptance.json'.length),
    });
  } else if (receipt.revision === 'SEC-M7-D29') {
    currentVerification = verifyRecipientEvidence({
      read,
      receipt,
      base: receiptPath.slice(0, -'acceptance.json'.length),
    });
  } else if (receipt.revision === 'SEC-M7-D28') {
    currentVerification = verifyBrowserCandidateEvidence({
      read,
      receipt,
      base: receiptPath.slice(0, -'acceptance.json'.length),
    });
  } else if (
    ['SEC-M7-D23', 'SEC-M7-D24', 'SEC-M7-D25', 'SEC-M7-D26', 'SEC-M7-D27'].includes(
      receipt.revision,
    )
  ) {
    const publicClients = receipt.revision === 'SEC-M7-D27';
    const deployment = publicClients || receipt.revision === 'SEC-M7-D26';
    const admin = deployment || receipt.revision === 'SEC-M7-D25';
    const identity = admin || receipt.revision === 'SEC-M7-D24';
    const base = receiptPath.slice(0, -'acceptance.json'.length);
    assert.equal(receipt.verification.report, base + 'verification.json');
    const groups = [
      ['hostingUnit', 'hosting', 36],
      ['authenticationUnit', 'authentication', 55],
      ['dynamicUnit', 'dynamic', 42],
      ['regressionUnit', 'regression', 169],
      ['maintenanceUnit', 'maintenance', 33],
      [
        'toolsUnit',
        'tools',
        publicClients ? 47 : deployment ? 45 : admin ? 43 : identity ? 41 : 39,
      ],
      ['launchCompatibilityUnit', 'launch-compat', 19],
      ...(identity ? [['identityUnit', 'identity', publicClients ? 31 : 24]] : []),
      ...(admin ? [['identityAdminUnit', 'identity-admin', 14]] : []),
      ...(deployment ? [['deploymentUnit', 'deployment', 22]] : []),
      ...(publicClients ? [['publicReportUnit', 'public-report', 4]] : []),
    ];
    for (const name of [
      'verification.json',
      'integration-check.json',
      'native.original.txt',
      'types.original.txt',
      'consumer-native.original.txt',
      'static-commands.json',
      'documents.original.json.txt',
      ...groups.map(([, name]) => name + '.original.txt'),
    ]) {
      assert.ok(
        receipt.verificationArtifacts.some((f) => f.path === base + name),
        'EVIDENCE_HOSTING_ARTIFACT_REQUIRED',
      );
    }
    currentVerification = json(base + 'verification.json');
    assert.equal(
      currentVerification.format,
      publicClients
        ? 'modeldb.security-public-clients-verification.v1'
        : deployment
          ? 'modeldb.security-deployment-wizard-verification.v1'
          : admin
            ? 'modeldb.security-identity-admin-verification.v1'
            : identity
              ? 'modeldb.security-designer-identity-verification.v1'
              : 'modeldb.security-hosting-verification.v1',
    );
    assert.equal(
      currentVerification.task,
      publicClients
        ? 'DR-P3.5'
        : deployment
          ? 'DR-P3.4'
          : admin
            ? 'DR-P3.3'
            : identity
              ? 'DR-P3.2'
              : 'DR-P3.1',
    );
    assert.equal(
      currentVerification.tasks.registration,
      publicClients
        ? '16/23'
        : deployment
          ? '15/23'
          : admin
            ? '14/23'
            : identity
              ? '13/23'
              : '12/23',
    );
    assert.equal(
      currentVerification.tasks.registrationP3,
      publicClients ? '5/6' : deployment ? '4/6' : admin ? '3/6' : identity ? '2/6' : '1/6',
    );
    assert.equal(currentVerification.tasks.registrationWorkPackages, '2/4');
    for (const [key, name, count] of groups) {
      const unit = currentVerification[key],
        tap = read(base + name + '.original.txt').toString('utf8');
      assert.equal(unit.pass, count, 'EVIDENCE_HOSTING_COUNT_REQUIRED');
      assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
      for (const [label, expected] of [
        ['tests', count],
        ['pass', count],
        ['fail', 0],
        ['cancelled', 0],
        ['skipped', 0],
        ['todo', 0],
      ]) {
        const lines = [...tap.matchAll(new RegExp('^# ' + label + ' (\\d+)\\s*$', 'gm'))];
        assert.equal(lines.length, 1);
        assert.equal(Number(lines[0][1]), expected);
        if (label !== 'tests' && label !== 'pass') {
          assert.equal(unit[label === 'skipped' ? 'skip' : label], 0);
        }
      }
    }
    const report = json(base + 'integration-check.json');
    assert.equal(report.format, 'modeldb.hosting-integration-check.v1');
    assert.equal(report.task, 'DR-P3.1');
    assert.equal(report.ok, true);
    assert.equal(report.platform, 'win32');
    const parsed = parseHostingIntegrationTap(
      read(base + 'native.original.txt').toString('utf8'),
      report.exitCode,
    );
    assert.deepEqual(parsed.unit, currentVerification.nativeUnit);
    assert.deepEqual(parsed.unit, report.unit);
    assert.deepEqual(parsed.native, report.native);
    assert.deepEqual(parsed.browser, report.browser);
    for (const key of ['configFile', 'envFile']) {
      assert.equal(report.build[key], false);
    }
    assert.equal(report.build.existingDistUnchanged, true);
    assert.equal(report.scope.temporarySyntheticOnly, true);
    for (const key of [
      'liveMaterialRead',
      'hardwareAuthenticatorTested',
      'systemTrustInstalled',
      'productionRegistrationUiTested',
    ]) {
      assert.equal(report.scope[key], false);
    }
    for (const key of [
      ...nativeChecks,
      ...browserChecks,
      'strictHostingTypes',
      'serverTypecheck',
      'designerTypecheck',
      'browserBoundary',
      'scopedFormatting',
      'scopedLint',
      'staticSnapshot',
      'managementLifetimes',
      'materialGuard',
    ]) {
      assert.equal(
        currentVerification.checks[key],
        true,
        'EVIDENCE_HOSTING_CHECK_REQUIRED: ' + key,
      );
    }
    for (const key of [
      'liveMaterialRead',
      'productionMigrationPerformed',
      'physicalAuthenticatorTested',
      'performanceTested',
      'fullReleaseInstallTested',
    ]) {
      assert.equal(currentVerification.scope[key], false);
    }
    assert.equal(currentVerification.documentValidation.ok, true);
    assert.equal(
      currentVerification.documentValidation.completedRegistrationTasks,
      publicClients ? 16 : deployment ? 15 : admin ? 14 : identity ? 13 : 12,
    );
    assert.deepEqual(
      json(base + 'documents.original.json.txt'),
      currentVerification.documentValidation,
    );
    const types = json(base + 'types.original.txt'),
      consumer = json(base + 'consumer-native.original.txt');
    assert.equal(types.ok, true);
    assert.equal(types.checks.entireServerTypecheck, true);
    assert.equal(types.checks.strictHostingTypecheck, true);
    if (identity) {
      assert.equal(types.checks.strictDesignerIdentityTypecheck, true);
    }
    if (admin) {
      assert.equal(types.checks.strictIdentityAdminTypecheck, true);
    }
    if (deployment) {
      assert.equal(types.checks.strictDeploymentWizardTypecheck, true);
    }
    assert.equal(types.checks.existingDistUnchanged, true);
    assert.equal(consumer.ok, true);
    for (const key of [
      'entireDesignerTypecheck',
      'strictSdkConsumer',
      'domTypesWithoutNode',
      'serverLibraryExcluded',
    ]) {
      assert.equal(consumer.checks[key], true);
    }
    const staticCommands = json(base + 'static-commands.json');
    assert.equal(staticCommands.length, 4);
    assert.ok(staticCommands.every((c) => c.exitCode === 0));
    for (const entry of ['connection', 'security']) {
      for (const locale of ['zh', 'en', 'ja']) {
        for (const width of [1280, 390]) {
          assert.ok(
            receipt.verificationArtifacts.some(
              (f) => f.path === base + 'screenshots/' + entry + '-' + locale + '-' + width + '.png',
            ),
            'EVIDENCE_HOSTING_SCREENSHOT_REQUIRED',
          );
        }
      }
    }
    let additionalNative = 0;
    if (identity) {
      for (const name of ['identity-integration-check.json', 'identity-native.original.txt']) {
        assert.ok(
          receipt.verificationArtifacts.some((f) => f.path === base + name),
          'EVIDENCE_IDENTITY_ARTIFACT_REQUIRED',
        );
      }
      const report = json(base + 'identity-integration-check.json');
      assert.equal(report.format, 'modeldb.designer-identity-check.v1');
      assert.equal(report.task, 'DR-P3.2');
      assert.equal(report.ok, true);
      assert.equal(report.platform, 'win32');
      const identityParsed = parseIdentityBrowserTap(
        read(base + 'identity-native.original.txt').toString('utf8'),
        report.exitCode,
      );
      assert.deepEqual(report.unit, identityParsed.unit);
      assert.deepEqual(report.browser, identityParsed.browser);
      assert.deepEqual(currentVerification.identityNativeUnit, identityParsed.unit);
      for (const key of identityBrowserChecks) {
        assert.equal(currentVerification.checks[key], true, 'EVIDENCE_IDENTITY_CHECK_REQUIRED');
      }
      for (const key of ['configFile', 'envFile']) {
        assert.equal(report.build[key], false);
      }
      assert.equal(report.build.existingDistUnchanged, true);
      assert.equal(report.scope.temporarySyntheticOnly, true);
      assert.equal(report.scope.formalRegistrationUiTested, true);
      for (const key of [
        'liveMaterialRead',
        'hardwareAuthenticatorTested',
        'systemTrustInstalled',
      ]) {
        assert.equal(report.scope[key], false);
      }
      for (const scene of ['login', 'pending', 'approved', 'rejected']) {
        for (const locale of ['zh', 'en', 'ja']) {
          for (const width of [1280, 390]) {
            assert.ok(
              receipt.verificationArtifacts.some(
                (f) => f.path === `${base}screenshots/identity/${scene}-${locale}-${width}.png`,
              ),
              'EVIDENCE_IDENTITY_SCREENSHOT_REQUIRED',
            );
          }
        }
      }
      additionalNative = identityParsed.unit.pass;
    }
    if (admin) {
      for (const name of ['admin-integration-check.json', 'admin-native.original.txt']) {
        assert.ok(
          receipt.verificationArtifacts.some((f) => f.path === base + name),
          'EVIDENCE_ADMIN_ARTIFACT_REQUIRED',
        );
      }
      const report = json(base + 'admin-integration-check.json');
      assert.equal(report.format, 'modeldb.identity-admin-check.v1');
      assert.equal(report.task, 'DR-P3.3');
      assert.equal(report.ok, true);
      assert.equal(report.platform, 'win32');
      const parsed = parseIdentityAdminTap(
        read(base + 'admin-native.original.txt').toString('utf8'),
        report.exitCode,
      );
      assert.deepEqual(report.unit, parsed.unit);
      assert.deepEqual(report.browser, parsed.browser);
      assert.deepEqual(currentVerification.identityAdminNativeUnit, parsed.unit);
      for (const key of identityAdminChecks) {
        assert.equal(currentVerification.checks[key], true, 'EVIDENCE_ADMIN_CHECK_REQUIRED');
      }
      for (const key of ['configFile', 'envFile']) {
        assert.equal(report.build[key], false);
      }
      assert.equal(report.build.existingDistUnchanged, true);
      assert.equal(report.scope.temporarySyntheticOnly, true);
      assert.equal(report.scope.identityMaintenanceUiTested, true);
      for (const key of [
        'liveMaterialRead',
        'hardwareAuthenticatorTested',
        'systemTrustInstalled',
      ]) {
        assert.equal(report.scope[key], false);
      }
      for (const scene of ['applications', 'approval-review', 'conflict', 'credentials']) {
        for (const locale of ['zh', 'en', 'ja']) {
          for (const width of [1280, 390]) {
            assert.ok(
              receipt.verificationArtifacts.some(
                (f) => f.path === `${base}screenshots/admin/${scene}-${locale}-${width}.png`,
              ),
              'EVIDENCE_ADMIN_SCREENSHOT_REQUIRED',
            );
          }
        }
      }
      additionalNative += parsed.unit.pass;
    }
    if (deployment) {
      for (const name of ['deployment-integration-check.json', 'deployment-native.original.txt']) {
        assert.ok(
          receipt.verificationArtifacts.some((f) => f.path === base + name),
          'EVIDENCE_DEPLOYMENT_ARTIFACT_REQUIRED',
        );
      }
      const report = json(base + 'deployment-integration-check.json');
      assert.equal(report.format, 'modeldb.deployment-wizard-check.v1');
      assert.equal(report.task, 'DR-P3.4');
      assert.equal(report.ok, true);
      assert.equal(report.platform, 'win32');
      const parsed = parseDeploymentTap(
        read(base + 'deployment-native.original.txt').toString('utf8'),
        report.exitCode,
      );
      assert.deepEqual(report.unit, parsed.unit);
      assert.deepEqual(report.browser, parsed.browser);
      assert.deepEqual(currentVerification.deploymentNativeUnit, parsed.unit);
      for (const key of deploymentChecks) {
        assert.equal(currentVerification.checks[key], true, 'EVIDENCE_DEPLOYMENT_CHECK_REQUIRED');
      }
      for (const key of ['configFile', 'envFile']) {
        assert.equal(report.build[key], false);
      }
      assert.equal(report.build.existingDistUnchanged, true);
      assert.equal(report.scope.temporarySyntheticOnly, true);
      assert.equal(report.scope.deploymentWizardTested, true);
      for (const key of [
        'liveMaterialRead',
        'hardwareAuthenticatorTested',
        'systemTrustInstalled',
      ]) {
        assert.equal(report.scope[key], false);
      }
      for (const scene of ['local', 'lan', 'review', 'existing']) {
        for (const locale of ['zh', 'en', 'ja']) {
          for (const width of [1280, 390]) {
            assert.ok(
              receipt.verificationArtifacts.some(
                (f) => f.path === `${base}screenshots/deployment/${scene}-${locale}-${width}.png`,
              ),
              'EVIDENCE_DEPLOYMENT_SCREENSHOT_REQUIRED',
            );
          }
        }
      }
      additionalNative += parsed.unit.pass;
    }
    if (publicClients) {
      for (const name of ['public-integration-check.json', 'public-native.original.txt']) {
        assert.ok(
          receipt.verificationArtifacts.some((f) => f.path === base + name),
          'EVIDENCE_PUBLIC_ARTIFACT_REQUIRED',
        );
      }
      const report = json(base + 'public-integration-check.json');
      assert.equal(report.format, 'modeldb.public-clients-check.v1');
      assert.equal(report.task, 'DR-P3.5');
      assert.equal(report.ok, true);
      assert.equal(report.platform, 'win32');
      const result = parsePublicClientsTap(
        read(base + 'public-native.original.txt').toString('utf8'),
        report.exitCode,
      );
      assert.deepEqual(report.unit, result.unit);
      assert.deepEqual(report.browsers, result.browsers);
      assert.deepEqual(currentVerification.publicNativeUnit, result.unit);
      assert.equal(report.applicationCredentialMode, true);
      assert.equal(report.legacyThreeApplications, true);
      assert.deepEqual(report.build.applications, ['model-designer', 'data-studio', 'web']);
      assert.equal(report.build.configFile, false);
      assert.equal(report.build.envFile, false);
      assert.equal(report.build.existingDistUnchanged, true);
      assert.equal(report.scope.temporarySyntheticOnly, true);
      for (const key of [
        'liveMaterialRead',
        'hardwareAuthenticatorTested',
        'systemTrustInstalled',
      ]) {
        assert.equal(report.scope[key], false);
      }
      for (const key of [
        'entireDataStudioTypecheck',
        'entireWebTypecheck',
        'publicIdentityClientConsumer',
      ]) {
        assert.equal(consumer.checks[key], true);
      }
      assert.equal(types.checks.strictPublicClientsTypecheck, true);
      for (const key of publicClientChecks) {
        assert.equal(currentVerification.checks[key], true, 'EVIDENCE_PUBLIC_CHECK_REQUIRED');
      }
      for (const app of ['data-studio', 'web']) {
        for (const scene of ['login', 'pending', 'approved', 'rejected']) {
          for (const locale of app === 'web' ? ['zh-CN', 'en'] : ['zh', 'en', 'ja']) {
            for (const width of [1280, 390]) {
              assert.ok(
                receipt.verificationArtifacts.some(
                  (f) =>
                    f.path ===
                    base +
                      'screenshots/public/' +
                      app +
                      '/' +
                      scene +
                      '-' +
                      locale +
                      '-' +
                      width +
                      '.png',
                ),
                'EVIDENCE_PUBLIC_SCREENSHOT_REQUIRED',
              );
            }
          }
        }
      }
      additionalNative += result.unit.pass;
    }
    assert.equal(
      currentVerification.totalTargetedPass,
      groups.reduce(
        (n, [key]) => n + currentVerification[key].pass,
        parsed.unit.pass + additionalNative,
      ),
    );
  }
  if (['SEC-M7-D20', 'SEC-M7-D21', 'SEC-M7-D22'].includes(receipt.revision)) {
    const resilience = receipt.revision === 'SEC-M7-D22';
    const maintenance = receipt.revision !== 'SEC-M7-D20';
    const base = receiptPath.slice(0, -'acceptance.json'.length);
    assert.equal(receipt.verification.report, base + 'verification.json');
    for (const name of [
      'verification.json',
      'dynamic.original.txt',
      'authentication.original.txt',
      'regression.original.txt',
      'tools.original.txt',
      'browser.original.txt',
      'integration-check.json',
      ...(maintenance ? ['maintenance.original.txt'] : []),
      ...(resilience ? ['resilience.original.txt', 'resilience-check.json'] : []),
    ]) {
      assert.ok(
        receipt.verificationArtifacts.some((file) => file.path === base + name),
        'EVIDENCE_DYNAMIC_ARTIFACT_REQUIRED',
      );
    }
    currentVerification = json(base + 'verification.json');
    assert.equal(
      currentVerification.format,
      resilience
        ? 'modeldb.security-authentication-resilience-verification.v1'
        : maintenance
          ? 'modeldb.security-registration-maintenance-verification.v1'
          : 'modeldb.security-dynamic-authorization-verification.v1',
    );
    assert.equal(
      currentVerification.task,
      resilience ? 'DR-P2.5' : maintenance ? 'DR-P2.4' : 'DR-P2.3',
    );
    assert.equal(
      currentVerification.tasks.registration,
      resilience ? '11/23' : maintenance ? '10/23' : '9/23',
    );
    assert.equal(
      currentVerification.tasks.registrationP2,
      resilience ? '5/5' : maintenance ? '4/5' : '3/5',
    );
    assert.equal(currentVerification.tasks.registrationWorkPackages, resilience ? '2/4' : '1/4');
    const groups = [
      ['dynamicUnit', 'dynamic', 42],
      ['authenticationUnit', 'authentication', 55],
      ['regressionUnit', 'regression', 169],
      ['toolsUnit', 'tools', resilience ? 37 : maintenance ? 32 : 30],
      ...(maintenance ? [['maintenanceUnit', 'maintenance', 33]] : []),
      ...(resilience ? [['resilienceUnit', 'resilience', 55]] : []),
    ];
    for (const [group, name, minimum] of groups) {
      const unit = currentVerification[group],
        tap = read(base + name + '.original.txt').toString('utf8');
      assert.ok(unit.pass >= minimum);
      assert.equal([...tap.matchAll(/^# pass /gm)].length, 1);
      assert.match(tap, new RegExp('^# pass ' + unit.pass + '$', 'm'));
      assert.match(tap, new RegExp('^# tests ' + unit.pass + '$', 'm'));
      assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
      for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
        assert.equal(unit[key], 0);
        assert.match(tap, new RegExp('^# ' + (key === 'skip' ? 'skipped' : key) + ' 0$', 'm'));
      }
    }
    if (resilience) {
      const report = json(base + 'resilience-check.json');
      assert.equal(report.format, 'modeldb.authentication-resilience-check.v1');
      assert.equal(report.task, 'DR-P2.5');
      assert.equal(report.ok, true);
      const parsed = parseAuthenticationResilienceTap(
        read(base + 'resilience.original.txt').toString('utf8'),
        report.exitCode,
      );
      assert.deepEqual(parsed.unit, report.unit);
      assert.deepEqual(parsed.unit, currentVerification.resilienceUnit);
      assert.deepEqual(parsed.matrix, report.matrix);
      for (const key of ['temporarySyntheticOnly', 'hardProcessExitTested']) {
        assert.equal(report.scope[key], true);
      }
      for (const key of [
        'liveMaterialRead',
        'nativeDpapiTested',
        'hardwareAuthenticatorTested',
        'physicalDiskFullTested',
        'productionRegistrationUiTested',
      ]) {
        assert.equal(report.scope[key], false);
      }
      assert.equal(currentVerification.scope.hardProcessExitTested, true);
      assert.equal(currentVerification.scope.physicalAuthenticatorTested, false);
      assert.equal(currentVerification.scope.physicalDiskFullTested, false);
      for (const key of Object.keys(parsed.matrix.checks)) {
        assert.equal(currentVerification.checks[key], true);
      }
    }
    const report = json(base + 'integration-check.json');
    assert.equal(report.ok, true);
    assert.equal(report.exitCode, 0);
    const browser = parseAuthenticationIntegrationTap(
      read(base + 'browser.original.txt').toString('utf8'),
      report.exitCode,
    );
    assert.deepEqual(browser.unit, report.unit);
    assert.deepEqual(browser.browser, report.browser);
    assert.equal(report.scope.liveMaterialRead, false);
    assert.equal(report.scope.systemTrustInstalled, false);
    for (const key of [
      'ownLiveGrants',
      'credentialSubscriptions',
      'userFanout',
      'durableSessionRevocation',
      'idleWsDeadline',
      'queuedBeforeEngine',
      'asyncFinalGuard',
      'publicationScopeSet',
      'compositeDelegation',
      'partialCommitHonest',
      'atomicRestrictionRecovery',
      'auditFailureClosed',
      'serverTypecheck',
      'strictDynamicTypes',
      'browserBoundary',
      'scopedFormatting',
      'scopedLint',
      ...(maintenance
        ? [
            'verifiedOsLocalOnly',
            'credentialUserSeparation',
            'boundedMetadata',
            'atomicReplacement',
            'lostCredentialReapproval',
            'newSignatureLogin',
            'terminalRevocation',
            'nativeDpapiCliMaintenance',
            'maintenanceFaultRecovery',
            'strictMaintenanceTypes',
          ]
        : []),
    ]) {
      assert.equal(currentVerification.checks[key], true, 'EVIDENCE_CURRENT_CHECK_FAILED: ' + key);
    }
    assert.equal(currentVerification.documentValidation.ok, true);
    assert.equal(
      currentVerification.documentValidation.completedRegistrationTasks,
      resilience ? 11 : maintenance ? 10 : 9,
    );
    assert.equal(currentVerification.scope.liveMaterialRead, false);
    assert.equal(currentVerification.scope.productionMigrationPerformed, false);
    assert.equal(currentVerification.scope.managementMaintenanceImplemented, maintenance);
    assert.equal(
      currentVerification.totalTargetedPass,
      groups.reduce((n, [key]) => n + currentVerification[key].pass, browser.unit.pass),
    );
  }
  if (receipt.revision === 'SEC-M7-D19') {
    const base = receiptPath.slice(0, -'acceptance.json'.length);
    assert.equal(receipt.verification.report, base + 'verification.json');
    for (const name of [
      'verification.json',
      'integration-check.json',
      'browser.original.txt',
      'authentication.original.txt',
      'regression.original.txt',
      'tools.original.txt',
    ]) {
      assert.ok(
        receipt.verificationArtifacts.some((file) => file.path === base + name),
        'EVIDENCE_AUTHENTICATION_ARTIFACT_REQUIRED',
      );
    }
    currentVerification = json(base + 'verification.json');
    assert.equal(currentVerification.format, 'modeldb.security-authentication-verification.v1');
    assert.equal(currentVerification.task, 'DR-P2.2');
    assert.equal(currentVerification.tasks.registration, '8/23');
    assert.equal(currentVerification.tasks.registrationP2, '2/5');
    assert.equal(currentVerification.tasks.registrationWorkPackages, '1/4');
    assert.equal(currentVerification.publicKeyLoginImplemented, true);
    for (const [group, log, minimum] of [
      ['authenticationUnit', 'authentication.original.txt', 54],
      ['regressionUnit', 'regression.original.txt', 169],
      ['toolsUnit', 'tools.original.txt', 28],
    ]) {
      const unit = currentVerification[group],
        tap = read(base + log).toString('utf8');
      assert.ok(unit.pass >= minimum);
      assert.equal([...tap.matchAll(/^# pass /gm)].length, 1);
      assert.match(tap, new RegExp('^# pass ' + unit.pass + '$', 'm'));
      assert.match(tap, new RegExp('^# tests ' + unit.pass + '$', 'm'));
      assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
      for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
        assert.equal(unit[key], 0);
        assert.match(tap, new RegExp('^# ' + (key === 'skip' ? 'skipped' : key) + ' 0$', 'm'));
      }
    }
    const report = json(base + 'integration-check.json');
    assert.equal(report.ok, true);
    assert.equal(report.task, 'DR-P2.2');
    assert.equal(report.exitCode, 0);
    const browser = parseAuthenticationIntegrationTap(
      read(base + 'browser.original.txt').toString('utf8'),
      report.exitCode,
    );
    assert.deepEqual(browser.unit, report.unit);
    assert.deepEqual(browser.browser, report.browser);
    assert.equal(report.scope.liveMaterialRead, false);
    assert.equal(report.scope.systemTrustInstalled, false);
    for (const key of [
      'explicitV4Migration',
      'realSignatures',
      'singleUse',
      'counterCompetition',
      'proofQueueBounded',
      'atomicLoginRecovery',
      'httpCookieCsrf',
      'registrationWindowIndependent',
      'dataLifecycleManagementBoundary',
      'serverTypecheck',
      'strictAuthenticationTypes',
      'browserBoundary',
      'scopedFormatting',
      'scopedLint',
    ]) {
      assert.equal(currentVerification.checks[key], true, 'EVIDENCE_CURRENT_CHECK_FAILED: ' + key);
    }
    assert.equal(currentVerification.documentValidation.ok, true);
    assert.equal(currentVerification.scope.liveMaterialRead, false);
    assert.equal(currentVerification.scope.productionMigrationPerformed, false);
  }
  if (receipt.revision === 'SEC-M7-D18') {
    const base = receiptPath.slice(0, -'acceptance.json'.length);
    assert.equal(receipt.verification.report, base + 'verification.json');
    for (const name of [
      'verification.json',
      'session-parent.original.txt',
      'registration.original.txt',
      'registry.original.txt',
      'compatibility.original.txt',
      'tools.original.txt',
    ]) {
      assert.ok(receipt.verificationArtifacts.some((file) => file.path === base + name));
    }
    currentVerification = json(base + 'verification.json');
    assert.equal(currentVerification.format, 'modeldb.security-session-parent-verification.v1');
    assert.equal(currentVerification.task, 'DR-P2.1');
    assert.equal(currentVerification.tasks.registration, '7/23');
    assert.equal(currentVerification.tasks.registrationP2, '1/5');
    assert.equal(currentVerification.tasks.registrationWorkPackages, '1/4');
    assert.equal(currentVerification.publicKeyLoginImplemented, false);
    for (const [group, log, minimum] of [
      ['sessionParentUnit', 'session-parent.original.txt', 35],
      ['registrationUnit', 'registration.original.txt', 95],
      ['registryUnit', 'registry.original.txt', 13],
      ['compatibilityUnit', 'compatibility.original.txt', 9],
      ['toolsUnit', 'tools.original.txt', 22],
    ]) {
      assert.ok(currentVerification[group].pass >= minimum);
      const tap = read(base + log).toString('utf8');
      assert.match(tap, new RegExp('^# pass ' + currentVerification[group].pass + '$', 'm'));
      assert.match(tap, new RegExp('^# tests ' + currentVerification[group].pass + '$', 'm'));
      assert.equal([...tap.matchAll(/^# pass /gm)].length, 1);
      assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
      for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
        assert.equal(currentVerification[group][key], 0, 'EVIDENCE_CURRENT_UNIT_INCOMPLETE');
        assert.match(tap, new RegExp('^# ' + (key === 'skip' ? 'skipped' : key) + ' 0$', 'm'));
      }
    }
    for (const key of [
      'explicitMigration',
      'namespaceSeparation',
      'nativeWindowsMigration',
      'legacyReaderRefusal',
      'atomicMigrationRecovery',
      'noPublicKeyIssuance',
      'managementEmptyScope',
      'offlineExpiryRecovery',
      'serverTypecheck',
      'strictSessionParentTypes',
      'browserBoundary',
      'scopedFormatting',
      'scopedLint',
    ]) {
      assert.equal(currentVerification.checks[key], true, 'EVIDENCE_CURRENT_CHECK_FAILED: ' + key);
    }
    assert.equal(currentVerification.documentValidation.ok, true);
    assert.equal(currentVerification.scope.liveMaterialRead, false);
    assert.equal(currentVerification.scope.productionMigrationPerformed, false);
  }
  if (receipt.revision === 'SEC-M7-D17') {
    const base = receiptPath.slice(0, -'acceptance.json'.length);
    assert.equal(receipt.verification.report, base + 'verification.json');
    for (const name of [
      'verification.json',
      'integration-check.json',
      'integration.original.txt',
    ]) {
      assert.ok(receipt.verificationArtifacts.some((file) => file.path === base + name));
    }
    currentVerification = json(base + 'verification.json');
    assert.equal(
      currentVerification.format,
      'modeldb.security-registration-integration-verification.v1',
    );
    assert.equal(currentVerification.task, 'DR-P1.6');
    assert.equal(currentVerification.tasks.registration, '6/23');
    assert.equal(currentVerification.tasks.registrationP1, '6/6');
    assert.equal(currentVerification.tasks.registrationWorkPackages, '1/4');
    assert.equal(currentVerification.runtimeRegistrationImplemented, true);
    assert.equal(currentVerification.approvalImplemented, true);
    assert.equal(currentVerification.publicKeyLoginImplemented, false);
    for (const group of [
      'unit',
      'integrationUnit',
      'legacyRegistryUnit',
      'networkUnit',
      'evidenceToolUnit',
      'reportToolUnit',
    ]) {
      assert.ok(currentVerification[group].pass > 0);
      for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
        assert.equal(currentVerification[group][key], 0, 'EVIDENCE_CURRENT_UNIT_INCOMPLETE');
      }
    }
    assert.equal(currentVerification.integrationUnit.pass, 9);
    for (const key of [
      'fullRegistrationApproval',
      'actualVirtualAuthenticator',
      'nativeHttpsDpapiCli',
      'pendingAndChallengeCapacity',
      'localRepairAtCapacity',
      'hardExitRecovery',
      'atomicIdentityAndAudit',
      'noBusinessSession',
      'stableFailureReport',
      'serverTypecheck',
      'strictIntegrationTypes',
      'browserBoundary',
      'scopedFormatting',
      'scopedLint',
    ]) {
      assert.equal(currentVerification.checks[key], true, 'EVIDENCE_CURRENT_CHECK_FAILED: ' + key);
    }
    assert.equal(currentVerification.documentValidation.ok, true);
    const integration = json(base + 'integration-check.json');
    assert.equal(integration.ok, true);
    assert.equal(integration.task, 'DR-P1.6');
    assert.equal(integration.exitCode, 0);
    assert.equal(integration.unit.pass, 9);
    for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
      assert.equal(integration.unit[key], 0);
    }
    assert.equal(integration.browser.ok, true);
    assert.match(integration.browser.browser, /^Chrome\/\d/);
    for (const key of [
      'actualBrowserWebAuthn',
      'nativeHttpsDpapiCli',
      'approval',
      'proofRejected',
      'singleUseCompetition',
      'revisionConflict',
      'outstandingChallengeCapacity1000',
      'localRepairAtCapacity',
      'restartWithRegistrationDisabled',
      'noBusinessSession',
      'instanceKeyUnchanged',
    ]) {
      assert.equal(integration.browser.checks[key], true);
    }
    assert.equal(integration.browser.hardwareAuthenticatorTested, false);
    assert.equal(integration.scope.publicKeyLoginImplemented, false);
    assert.equal(integration.scope.liveMaterialRead, false);
    assert.equal(integration.scope.systemTrustInstalled, false);
  }
  if (receipt.revision === 'SEC-M7-D16') {
    const path = receiptPath.replace('acceptance.json', 'verification.json');
    assert.equal(receipt.verification.report, path);
    assert.ok(receipt.verificationArtifacts.some((file) => file.path === path));
    currentVerification = json(path);
    assert.equal(
      currentVerification.format,
      'modeldb.security-registration-approval-verification.v1',
    );
    assert.equal(currentVerification.task, 'DR-P1.5');
    assert.equal(currentVerification.tasks.registration, '5/23');
    assert.equal(currentVerification.runtimeRegistrationImplemented, true);
    assert.equal(currentVerification.approvalImplemented, true);
    assert.equal(currentVerification.publicKeyLoginImplemented, false);
    for (const group of [
      'unit',
      'approvalUnit',
      'legacyRegistryUnit',
      'networkUnit',
      'evidenceToolUnit',
    ]) {
      assert.ok(currentVerification[group].pass > 0);
      for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
        assert.equal(currentVerification[group][key], 0, 'EVIDENCE_CURRENT_UNIT_INCOMPLETE');
      }
    }
    assert.ok(currentVerification.approvalUnit.pass >= 21);
    for (const key of [
      'verifiedOsLocalOnly',
      'exactScopes',
      'atomicIdentityAndAudit',
      'revisionConflicts',
      'terminalRejection',
      'noPollingSession',
      'approvalWriteFaults',
      'legacyMissingGrantsDeny',
      'nativeDpapiCli',
      'serverTypecheck',
      'strictApprovalTypes',
      'browserBoundary',
      'scopedFormatting',
      'scopedLint',
    ]) {
      assert.equal(currentVerification.checks[key], true, 'EVIDENCE_CURRENT_CHECK_FAILED: ' + key);
    }
    assert.equal(currentVerification.documentValidation.ok, true);
  }
  if (receipt.revision === 'SEC-M7-D15') {
    const base = receiptPath.slice(0, -'acceptance.json'.length);
    const path = base + 'verification.json';
    assert.equal(receipt.verification.report, path);
    for (const name of ['verification.json', 'dependency-check.json']) {
      assert.ok(receipt.verificationArtifacts.some((file) => file.path === base + name));
    }
    currentVerification = json(path);
    assert.equal(currentVerification.format, 'modeldb.security-registration-api-verification.v1');
    assert.equal(currentVerification.task, 'DR-P1.4');
    assert.equal(currentVerification.tasks.registration, '4/23');
    assert.equal(currentVerification.runtimeRegistrationImplemented, true);
    assert.equal(currentVerification.approvalImplemented, false);
    assert.equal(currentVerification.publicKeyLoginImplemented, false);
    for (const group of [
      'unit',
      'runtimeUnit',
      'legacyRegistryUnit',
      'networkUnit',
      'evidenceToolUnit',
    ]) {
      assert.ok(currentVerification[group].pass > 0);
      for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
        assert.equal(currentVerification[group][key], 0);
      }
    }
    assert.ok(currentVerification.runtimeUnit.pass >= 20);
    for (const key of [
      'defaultDisabled',
      'sameOriginBeforeParsing',
      'singleUseClaims',
      'noSessionsOrGrants',
      'privateStatus',
      'expiryReclamation',
      'boundedBudgetsAndQueue',
      'nativeDpapiHttps',
      'serverTypecheck',
      'strictRuntimeTypes',
      'browserBoundary',
      'scopedFormatting',
      'scopedLint',
    ]) {
      assert.equal(currentVerification.checks[key], true, 'EVIDENCE_CURRENT_CHECK_FAILED: ' + key);
    }
    assert.equal(currentVerification.documentValidation.ok, true);
    const dependency = json(base + 'dependency-check.json');
    assert.equal(dependency.ok, true);
    assert.equal(dependency.library.version, '14.0.3');
    assert.equal(dependency.packages.length, 25);
    assert.equal(dependency.rootImporterExact, true);
    assert.equal(dependency.graphMatchesSelection, true);
    const rootLock = receipt.files.find((file) => file.path === 'pnpm-lock.yaml');
    assert.ok(rootLock);
    assert.equal(dependency.rootLockSha256, rootLock.sha256);
    assert.equal(dependency.rootLockSha256Lf, rootLock.sha256Lf);
    assert.equal(
      dependency.rootLockSha256Lf,
      sha256(read('pnpm-lock.yaml').toString('utf8').replace(/\r\n/g, '\n')),
    );
    assert.equal(dependency.offlineInstall.exitCode, 0);
    assert.equal(dependency.offlineInstall.downloaded, 0);
  }
  if (receipt.revision === 'SEC-M7-D14') {
    const path = receiptPath.replace('acceptance.json', 'verification.json');
    assert.equal(receipt.verification.report, path);
    assert.ok(receipt.verificationArtifacts.some((file) => file.path === path));
    currentVerification = json(path);
    assert.equal(
      currentVerification.format,
      'modeldb.security-registration-storage-verification.v1',
    );
    assert.equal(currentVerification.task, 'DR-P1.3');
    assert.equal(currentVerification.tasks.registration, '3/23');
    assert.equal(currentVerification.runtimeRegistrationImplemented, false);
    assert.equal(currentVerification.registrationStorageImplemented, true);
    for (const group of ['unit', 'storageUnit', 'legacyRegistryUnit', 'evidenceToolUnit']) {
      assert.ok(currentVerification[group].pass > 0);
      for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
        assert.equal(currentVerification[group][key], 0, 'EVIDENCE_CURRENT_UNIT_INCOMPLETE');
      }
    }
    assert.ok(currentVerification.storageUnit.pass >= 23);
    for (const key of [
      'defaultDisabled',
      'atomicMigration',
      'oldReaderRefusesV2',
      'isolatedDpapi',
      'hardExitRecovery',
      'serverTypecheck',
      'strictStorageTypes',
      'browserBoundary',
      'scopedFormatting',
      'scopedLint',
    ]) {
      assert.equal(currentVerification.checks[key], true, 'EVIDENCE_CURRENT_CHECK_FAILED: ' + key);
    }
    assert.equal(currentVerification.documentValidation.ok, true);
  }
  if (receipt.revision === 'SEC-M7-D13') {
    const base = receiptPath.slice(0, -'acceptance.json'.length);
    const path = base + 'verification.json';
    assert.equal(receipt.verification.report, path);
    for (const name of ['verification.json', 'dependency-check.json']) {
      assert.ok(
        receipt.verificationArtifacts.some((file) => file.path === base + name),
        'EVIDENCE_CURRENT_ARTIFACT_REQUIRED',
      );
    }
    currentVerification = json(path);
    assert.equal(
      currentVerification.format,
      'modeldb.security-registration-protocol-verification.v1',
    );
    assert.equal(currentVerification.task, 'DR-P1.2');
    assert.equal(currentVerification.tasks.registration, '2/23');
    assert.equal(currentVerification.runtimeRegistrationImplemented, false);
    assert.ok(currentVerification.unit.pass >= 29);
    for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
      assert.equal(currentVerification.unit[key], 0, 'EVIDENCE_CURRENT_UNIT_INCOMPLETE');
    }
    for (const key of [
      'scopedFormatting',
      'scopedLint',
      'sharedTypecheck',
      'sdkTypecheck',
      'browserBoundary',
      'offlineDependencyInstall',
    ]) {
      assert.equal(currentVerification.checks[key], true, 'EVIDENCE_CURRENT_CHECK_FAILED: ' + key);
    }
    assert.equal(currentVerification.documentValidation.ok, true);
    const dependency = json(base + 'dependency-check.json');
    assert.equal(dependency.ok, true);
    assert.equal(dependency.library.version, '14.0.3');
    assert.equal(dependency.packages.length, 25);
    assert.equal(dependency.offlineInstall.exitCode, 0);
    assert.equal(dependency.offlineInstall.downloaded, 0);
    assert.equal(dependency.checks.malformedProofRejected, true);
    assert.equal(
      dependency.lockSha256Lf,
      sha256(
        read('scripts/security-registration-dependencies/pnpm-lock.yaml')
          .toString('utf8')
          .replace(/\r\n/g, '\n'),
      ),
      'EVIDENCE_DEPENDENCY_LOCK_CHANGED',
    );
  }
  if (receipt.revision === 'SEC-M7-D12') {
    const path = receiptPath.replace('acceptance.json', 'verification.json');
    assert.equal(receipt.verification.report, path);
    assert.ok(receipt.verificationArtifacts.some((file) => file.path === path));
    currentVerification = json(path);
    assert.equal(
      currentVerification.format,
      'modeldb.security-registration-contract-verification.v1',
    );
    assert.equal(currentVerification.task, 'DR-P1.1');
    assert.equal(currentVerification.tasks.registration, '1/23');
    assert.equal(currentVerification.runtimeRegistrationImplemented, false);
    assert.ok(currentVerification.unit.pass > 0);
    for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
      assert.equal(currentVerification.unit[key], 0, 'EVIDENCE_CURRENT_UNIT_INCOMPLETE');
    }
    assert.equal(currentVerification.checks.isolatedDnsTls, true);
    assert.equal(currentVerification.checks.scopedFormatting, true);
    assert.equal(currentVerification.checks.scopedLint, true);
    assert.equal(currentVerification.documentValidation.ok, true);
  }
  if (receipt.revision === 'SEC-M7-D11') {
    const base = receiptPath.slice(0, -'acceptance.json'.length);
    const artifactPaths = new Set((receipt.verificationArtifacts ?? []).map((file) => file.path));
    for (const name of [
      'verification',
      'release-candidate',
      'regression',
      'browser',
      'performance',
    ]) {
      assert.ok(artifactPaths.has(base + name + '.json'), 'EVIDENCE_CURRENT_ARTIFACT_REQUIRED');
    }
    for (const name of ['release-candidate', 'performance']) {
      assert.ok(
        artifactPaths.has(base + name + '.original.json.txt'),
        'EVIDENCE_CURRENT_ORIGINAL_REQUIRED',
      );
      assert.deepEqual(
        json(base + name + '.json'),
        json(base + name + '.original.json.txt'),
        'EVIDENCE_CURRENT_ORIGINAL_CONTENT_CHANGED',
      );
    }
    assert.equal(receipt.verification.report, base + 'verification.json');
    currentVerification = json(receipt.verification.report);
    assert.equal(currentVerification.format, 'modeldb.security-s72-revalidation.v1');
    for (const name of [
      'unitRegression',
      'engineIntegrations',
      'browserAcceptance',
      'typechecks',
      'isolatedCandidate',
      'installedLifecycle',
      'performanceWithinBaseline',
      'documentsAndI18n',
    ]) {
      assert.equal(
        currentVerification.checks[name],
        true,
        'EVIDENCE_CURRENT_CHECK_FAILED: ' + name,
      );
    }
    const candidate = json(base + 'release-candidate.json');
    assert.equal(
      sha256(read(base + 'release-candidate.original.json.txt')),
      currentVerification.candidateSha256,
    );
    assert.equal(candidate.packages.length, 7);
    assert.equal(candidate.apps.length, 3);
    assert.equal(candidate.checks.frontendBuild.configFile, false);
    assert.equal(candidate.checks.frontendBuild.envFile, false);
    const currentRegression = json(base + 'regression.json');
    assert.ok(currentRegression.unit.pass > 0);
    for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
      assert.equal(currentRegression.unit[key], 0, 'EVIDENCE_CURRENT_UNIT_INCOMPLETE');
    }
    assert.equal(currentRegression.results.length, 7);
    assert.ok(currentRegression.results.every((result) => result.exitCode === 0));
    const currentBrowser = json(base + 'browser.json');
    assert.equal(currentBrowser.pass, 2);
    assert.equal(currentBrowser.fail, 0);
    assert.equal(currentBrowser.skip, 0);
    const currentPerformance = json(base + 'performance.json');
    assert.equal(currentPerformance.releaseManifestSha256, currentVerification.candidateSha256);
    for (const name of [
      'installedPackageHashes',
      'frontendAndDocumentHashes',
      'performanceWithinBaseline',
    ]) {
      assert.equal(
        currentPerformance.checks[name],
        true,
        'EVIDENCE_CURRENT_INSTALL_OR_PERFORMANCE_FAILED',
      );
    }
    assert.ok(Object.values(currentPerformance.checks).every((value) => value === true));
  }

  const acceptance = json(historicalRoot + 'acceptance.json');
  const regression = json(historicalRoot + 'regression.json');
  const browser = json(historicalRoot + 'browser.json');
  const performance = json(historicalRoot + 'performance.json');
  const originalPerformance = json(historicalRoot + 'performance.original.json.txt');
  const equivalence = json(historicalRoot + 'equivalence.json');
  const originalCandidate = json(historicalRoot + 'release-candidate.original.json.txt');
  assert.deepEqual(json(historicalRoot + 'release-candidate.json'), originalCandidate);
  assert.deepEqual(performance, originalPerformance);
  assert.deepEqual(
    json(historicalRoot + 'performance-exploratory.json'),
    json(historicalRoot + 'performance-exploratory.original.json.txt'),
  );
  for (const descriptor of [
    equivalence.testedManifest,
    equivalence.deliveryManifest,
    equivalence.verificationReport,
  ]) {
    assert.equal(sha256(read(historicalRoot + descriptor.path)), descriptor.sha256);
  }
  assert.equal(performance.releaseManifestSha256, equivalence.testedManifest.sha256);
  assert.ok(Object.values(performance.checks).every((passed) => passed === true));
  assert.ok(Object.values(equivalence.checks).every((passed) => passed === true));
  assert.equal(acceptance.finalStaticChecks.status, 'passed');
  assert.equal(acceptance.finalStaticChecks.exitCode, 0);
  assert.equal(regression.unit.pass, 424);
  assert.equal(regression.unit.fail, 0);
  assert.equal(regression.unit.skip, 0);
  assert.equal(regression.unitFiles.length, 63);
  assert.equal(regression.results.length, 7);
  assert.ok(regression.results.every((result) => result.exitCode === 0));
  assert.equal(browser.pass, 2);
  assert.equal(browser.fail, 0);
  assert.equal(browser.skip, 0);
  assert.equal(originalCandidate.packages.length, 7);
  assert.equal(originalCandidate.apps.length, 3);
  for (const metric of Object.values(performance.metrics)) {
    assert.ok(metric.registry.samplesMs.length > 0 && metric.legacy.samplesMs.length > 0);
  }
  return {
    ok: true,
    revision: receipt.revision,
    developmentFiles: receipt.files.length,
    normalizedFiles,
    historicalEvidenceFiles: receipt.historicalEvidence.length,
    currentVerificationArtifacts: receipt.verificationArtifacts?.length ?? 0,
    historicalUnitPass: regression.unit.pass,
    historicalBrowserPass: browser.pass,
    currentRevalidation:
      receipt.revision === 'SEC-M7-D34'
        ? 'preparation-passed-device-pending'
        : currentVerification
          ? 'passed'
          : 'not-recorded-in-this-receipt',
    ...(receipt.revision === 'SEC-M7-D34'
      ? { taskComplete: false, currentTaskStatus: currentVerification.taskStatus }
      : {}),
    currentTask: currentVerification?.task ?? null,
    runtimeMaterialRead: false,
    scope: 'Recorded evidence and current development files; does not rerun functional acceptance.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/security-release-evidence.mjs');
    process.stdout.write(JSON.stringify(verifyReleaseEvidence(), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}
