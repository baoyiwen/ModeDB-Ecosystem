/** Check current server and storage tests against fresh public declarations, without changing dist. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
export function checkRegistrationStorageTypes() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Registration-Storage-Types-'));
  symlinkSync(
    realpathSync(join(repository, 'node_modules')),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const compile = (args) => {
    const result = spawnSync(
      process.execPath,
      [join(repository, 'node_modules/typescript/bin/tsc'), ...args],
      { cwd: repository, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  };
  compile(['-p', 'packages/shared/tsconfig.build.json', '--outDir', join(root, 'shared')]);
  writeFileSync(
    join(root, 'core.json'),
    JSON.stringify({
      extends: join(repository, 'packages/core/tsconfig.build.json'),
      compilerOptions: {
        outDir: join(root, 'core'),
        emitDeclarationOnly: true,
        paths: {
          '@mode-db/shared': [join(root, 'shared/index.d.ts')],
          '@mode-db/sdk': [join(repository, 'packages/sdk/src/index.ts')],
        },
      },
    }),
  );
  compile(['-p', join(root, 'core.json')]);
  writeFileSync(
    join(root, 'server.json'),
    JSON.stringify({
      extends: join(repository, 'packages/server/tsconfig.json'),
      compilerOptions: {
        noEmit: true,
        paths: {
          '@mode-db/shared': [join(root, 'shared/index.d.ts')],
          '@mode-db/core': [join(root, 'core/index.d.ts')],
          '@mode-db/server': [join(repository, 'packages/server/src/index.ts')],
        },
      },
    }),
  );
  compile(['-p', join(root, 'server.json')]);
  writeFileSync(
    join(root, 'test.json'),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        types: ['node'],
        skipLibCheck: true,
        paths: {
          '@mode-db/shared': [join(root, 'shared/index.d.ts')],
          '@mode-db/core': [join(root, 'core/index.d.ts')],
          '@mode-db/sdk': [join(repository, 'packages/sdk/src/index.ts')],
        },
      },
      files: [
        join(repository, 'test/unit/security-public-rejection-audit.test.ts'),
        join(repository, 'test/unit/security-registered-recovery.test.ts'),
        join(repository, 'test/unit/security-recipient-delivery.test.ts'),
        join(repository, 'test/integration/security-recipient-delivery-native.test.ts'),
        join(repository, 'test/unit/security-recipient-keys.test.ts'),
        join(repository, 'test/integration/security-recipient-keys-browser.test.ts'),
        join(repository, 'scripts/security-recipient-key.ts'),
        join(repository, 'test/unit/security-deployment-wizard.test.ts'),
        join(repository, 'test/integration/security-deployment-wizard-browser.test.ts'),
        join(repository, 'test/unit/security-registration-storage.test.ts'),
        join(repository, 'test/unit/security-session-parent.test.ts'),
        join(repository, 'test/unit/security-authentication.test.ts'),
        join(repository, 'test/unit/security-dynamic-authorization.test.ts'),
        join(repository, 'test/unit/security-data-discovery.test.ts'),
        join(repository, 'test/unit/security-authentication-storage.test.ts'),
        join(repository, 'test/unit/security-authentication-resilience.test.ts'),
        join(repository, 'test/unit/security-hosting.test.ts'),
        join(repository, 'test/unit/security-identity-admin.test.ts'),
        join(repository, 'test/integration/security-identity-admin-browser.test.ts'),
        join(repository, 'test/integration/security-hosting-browser.test.ts'),
        join(repository, 'test/integration/security-designer-identity-browser.test.ts'),
        join(repository, 'test/integration/security-public-clients-browser.test.ts'),
        join(repository, 'test/integration/security-hostile-browser.test.ts'),
        join(repository, 'test/integration/security-browser-apps.test.ts'),
        join(repository, 'test/unit/security-designer-identity.test.ts'),
        join(repository, 'test/fixtures/security-authentication-exit-child.ts'),
        join(repository, 'test/integration/security-authentication-browser.test.ts'),
        join(repository, 'test/unit/security-registration-runtime.test.ts'),
        join(repository, 'test/unit/security-registration-approval.test.ts'),
        join(repository, 'test/unit/security-registration-maintenance.test.ts'),
        join(repository, 'test/integration/security-registration-flow.test.ts'),
        join(repository, 'test/integration/security-registration-browser.test.ts'),
        join(repository, 'test/fixtures/security-registration-approval-child.ts'),
      ],
    }),
  );
  compile(['-p', join(root, 'test.json')]);
  return {
    format: 'modeldb.registration-storage-types.v1',
    ok: true,
    node: process.version,
    root,
    checks: {
      freshSharedDeclarations: true,
      freshCoreDeclarations: true,
      entireServerTypecheck: true,
      strictStorageTestTypecheck: true,
      strictSessionParentTypecheck: true,
      strictAuthenticationTypecheck: true,
      strictAuthenticationResilienceTypecheck: true,
      strictRegisteredRecoveryTypecheck: true,
      strictHostingTypecheck: true,
      strictDeploymentWizardTypecheck: true,
      strictIdentityAdminTypecheck: true,
      strictDesignerIdentityTypecheck: true,
      strictPublicClientsTypecheck: true,
      strictHostileBrowserTypecheck: true,
      strictRegistrationRuntimeTypecheck: true,
      strictRegistrationApprovalTypecheck: true,
      strictRegistrationIntegrationTypecheck: true,
      existingDistUnchanged: true,
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(
      process.argv.length,
      2,
      'Usage: node scripts/security-registration-storage-check.mjs',
    );
    process.stdout.write(JSON.stringify(checkRegistrationStorageTypes(), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}
