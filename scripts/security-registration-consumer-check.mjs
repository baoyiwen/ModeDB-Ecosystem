/** Fresh declarations, strict SDK consumption and browser-only bundles; no server/config access. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const repository = fileURLToPath(new URL('../', import.meta.url));
// tsx is a declared root development dependency and already includes esbuild.
const { build } = createRequire(realpathSync(join(repository, 'node_modules/tsx/package.json')))(
  'esbuild',
);

export async function checkRegistrationConsumers() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Registration-Consumers-'));
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  const tsc = (...args) => {
    const result = spawnSync(
      process.execPath,
      [join(repository, 'node_modules/typescript/bin/tsc'), ...args],
      { cwd: repository, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  };
  tsc('-p', 'packages/shared/tsconfig.build.json', '--outDir', join(root, 'shared'));
  writeFileSync(
    join(root, 'consumer.ts'),
    `
import { loginBrowserSession, type BrowserPublicKeyLoginConfig, type DeviceAuthenticationBindingV1 } from '@mode-db/sdk';
import type { DeviceRegistrationProofV1, DeviceRegistrationBeginRequestV1 } from '@mode-db/sdk';
import { assertDeviceRegistrationBeginRequest, DEVICE_REGISTRATION_CAPACITY_V1 } from '@mode-db/shared';
import { manageRegisteredIdentity, type ConnectionEndpoint } from '@mode-db/sdk';
import { manageRecipientKey } from '@mode-db/sdk';
export async function recipients(endpoint:ConnectionEndpoint, instanceId:string) { const page=await manageRecipientKey(endpoint,{action:'registration.recipient.list',instanceId}); return page.keys.map(k=>k.fingerprint); }
import { createBrowserIdentityClient, browserIdentityIssue, type BrowserIdentityClient } from '@mode-db/sdk';
export function identity(endpoint: ConnectionEndpoint): BrowserIdentityClient { const client=createBrowserIdentityClient(endpoint); void client.load(); void client.importDescriptor('{}'); client.dispose(); browserIdentityIssue({}); return client; }
import { deploymentWizard } from '@mode-db/sdk';
export async function deployment(endpoint: ConnectionEndpoint) {
  const status = await deploymentWizard(endpoint, {action:'deployment.status'});
  const preview = await deploymentWizard(endpoint, {action:'deployment.preview',draft:{mode:'local',port:9090}});
  return {eligible:status.eligible, hash:preview.digest};
}
export async function admin(endpoint: ConnectionEndpoint, instanceId: string) {
  const page = await manageRegisteredIdentity(endpoint, {action:'registration.users.list',instanceId});
  return page.users.map(user => user.principalId);
}
export function consume(input: unknown): DeviceRegistrationBeginRequestV1 {
  assertDeviceRegistrationBeginRequest(input); return input;
}
export function proofId(input: DeviceRegistrationProofV1): string { return input.id; }
export function login(config: BrowserPublicKeyLoginConfig, binding: DeviceAuthenticationBindingV1) { return loginBrowserSession(config, binding); }
export const capacity: 1000 = DEVICE_REGISTRATION_CAPACITY_V1.maxPendingApplications;
`,
  );
  const sdk = join(repository, 'packages/sdk/src/index.ts');
  const shared = join(root, 'shared/index.d.ts');
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        lib: ['ES2022', 'DOM'],
        types: [],
        paths: { '@mode-db/shared': [shared], '@mode-db/sdk': [sdk] },
      },
      files: [join(root, 'consumer.ts')],
    }),
  );
  tsc('-p', join(root, 'tsconfig.json'));
  for (const app of ['model-designer', 'data-studio', 'web']) {
    writeFileSync(
      join(root, app + '.json'),
      JSON.stringify({
        extends: join(repository, 'apps', app, 'tsconfig.json'),
        compilerOptions: {
          paths: {
            '@mode-db/shared': [shared],
            '@mode-db/sdk': [sdk],
            '@mode-db/data-kit': [join(repository, 'packages/data-kit/src/index.ts')],
            '@mode-db/data-ui': [join(repository, 'packages/data-ui/src/index.ts')],
          },
        },
      }),
    );
    tsc('-p', join(root, app + '.json'));
  }
  const bundles = [];
  for (const entry of ['packages/shared/src/index.ts', 'packages/sdk/src/index.ts']) {
    const result = await build({
      absWorkingDir: repository,
      entryPoints: [entry],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      write: false,
      metafile: true,
      alias: { '@mode-db/shared': join(repository, 'packages/shared/src/index.ts') },
      logLevel: 'silent',
    });
    assert.ok(
      Object.keys(result.metafile.inputs).every(
        (path) => !/packages\/(server|core)\/|simplewebauthn/.test(path),
      ),
      'BROWSER_SERVER_DEPENDENCY_REJECTED',
    );
    bundles.push({
      entry,
      bytes: result.outputFiles[0].contents.byteLength,
      sha256: createHash('sha256').update(result.outputFiles[0].contents).digest('hex'),
    });
  }
  return {
    ok: true,
    format: 'modeldb.registration-consumer-check.v1',
    node: process.version,
    root,
    checks: {
      freshSharedDeclarations: true,
      strictSdkConsumer: true,
      entireDesignerTypecheck: true,
      entireDataStudioTypecheck: true,
      entireWebTypecheck: true,
      publicIdentityClientConsumer: true,
      domTypesWithoutNode: true,
      sharedBrowserBundle: true,
      sdkBrowserBundle: true,
      serverLibraryExcluded: true,
    },
    bundles,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(
      process.argv.length,
      2,
      'Usage: node scripts/security-registration-consumer-check.mjs',
    );
    process.stdout.write(JSON.stringify(await checkRegistrationConsumers(), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}
