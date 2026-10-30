/** Installed/minified modules, synthetic Windows material, no source aliases or tsx runtime. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertInstalledUpgradeReport,
  checkInstalledCandidate,
  installedUpgradeChecks,
  sha256,
} from './security-install-contract.mjs';
const repository = fileURLToPath(new URL('../', import.meta.url));
export async function verifyInstalledUpgrade(releaseRoot) {
  assert.equal(process.platform, 'win32', 'INSTALL_WINDOWS_REQUIRED');
  const candidate = checkInstalledCandidate(releaseRoot),
    { root, consumer } = candidate;
  const serverRoot = realpathSync(join(consumer, 'node_modules/@mode-db/server'));
  const installed = (name) => import(pathToFileURL(join(serverRoot, 'dist', name + '.js')).href);
  const { SecurityRegistry, ensureModelDbLayoutAtRoot } = await installed('index');
  const { WindowsSecretProtector } = await installed('security/windows-secret-protector');
  const { LocalVaultKeyProvider } = await installed('security/local-vault-key-provider');
  const { RegistrationService } = await installed('security/registration-service');
  const { AuthenticationService } = await installed('security/authentication-service');
  const { dispatchLocalSecurity } = await installed('security/local-management-channel');
  const { answerRecipientChallenge } = await installed('security/recipient-keys');
  const requireInstalled = createRequire(join(serverRoot, 'package.json'));
  const { isoCBOR } = await import(
    pathToFileURL(requireInstalled.resolve('@simplewebauthn/server/helpers')).href
  );
  const { default: Fastify } = await import(
    pathToFileURL(requireInstalled.resolve('fastify')).href
  );
  const protector = new WindowsSecretProtector(),
    sid = protector.currentIdentity();
  const home = mkdtempSync(join(tmpdir(), 'ModeDB-Installed-Upgrade-'));
  const stateDir = join(home, 'state');
  protector.ensureDirectory(stateDir);
  const config = ensureModelDbLayoutAtRoot(stateDir),
    directory = join(stateDir, 'security');
  const checks = Object.fromEntries(installedUpgradeChecks.map((key) => [key, false]));
  checks.nativeDpapi = true;
  checks.installedModulesOnly = true;
  let registry, registration, authentication;
  const close = () => {
    registration?.close();
    authentication?.close();
    registry?.close();
  };
  const bytes = () =>
    Object.fromEntries(
      readdirSync(directory)
        .filter((n) => !n.endsWith('.lock'))
        .sort()
        .map((n) => [n, sha256(readFileSync(join(directory, n)))]),
    );
  try {
    const fixture = readFileSync(
      join(
        repository,
        'test/fixtures/security-registration-legacy/security-registry-v1.original.ts.txt',
      ),
    );
    assert.equal(
      sha256(fixture),
      'ca5c64f8b3c5559cefffc0e11dfa2aa3240f96775b90f4f2a4e6f532fb3bdf0c',
    );
    const typescript = createRequire(import.meta.url)('typescript');
    const frozenDirectory = mkdtempSync(join(consumer, 'frozen-reader-'));
    let compiled = typescript.transpileModule(fixture.toString('utf8'), {
      compilerOptions: {
        target: typescript.ScriptTarget.ES2022,
        module: typescript.ModuleKind.ES2022,
      },
    }).outputText;
    for (const name of [
      'local-vault-key-provider',
      'windows-secret-protector',
      'security-errors',
      'network-policy',
    ]) {
      compiled = compiled.replaceAll(
        "'./" + name + ".js'",
        JSON.stringify(pathToFileURL(join(serverRoot, 'dist/security', name + '.js')).href),
      );
    }
    const oldFile = join(frozenDirectory, 'reader.mjs');
    writeFileSync(oldFile, compiled, { flag: 'wx' });
    const old = await import(pathToFileURL(oldFile).href);
    registry = old.SecurityRegistry.open(directory);
    const instanceId = registry.status().instanceId;
    const principal = registry.createPrincipal('Synthetic original API');
    const api = registry.createCredential(principal.id, 'Synthetic original token', []);
    const revoked = registry.createCredential(principal.id, 'Synthetic revoked token', []);
    registry.revokeCredential(revoked.credential.id);
    const session = registry.createSession(api.token),
      pair = registry.createPairingForCredential(
        api.credential.id,
        5,
        'https://modeldb-a.example.test',
      );
    const provider = new LocalVaultKeyProvider(directory),
      material = provider.resolveKey('synthetic');
    registry.registerKeyReference(material.reference);
    material.key.fill(0);
    registry.close();
    const original = bytes();
    registry = old.SecurityRegistry.open(directory);
    registry.authenticate(api.token);
    registry.close();
    assert.deepEqual(bytes(), original);
    checks.legacyCompiledReaderBaseline = true;
    registry = SecurityRegistry.open(directory);
    assert.equal(registry.registrationStorageStatus().ledgerVersion, 1);
    assert.deepEqual(bytes(), original);
    const now = Date.now(),
      origin = 'https://modeldb-a.example.test',
      utc = (n) => new Date(n).toISOString();
    const descriptor = {
      format: 'modeldb.device-registration-connection.v1',
      version: 1,
      instanceId,
      serverOrigin: origin,
      rpId: 'modeldb-a.example.test',
      registrationMode: 'enabled',
      issuedAtUtc: utc(now - 1000),
      expiresAtUtc: utc(now + 3600000),
      deploymentDescriptorSha256: 'a'.repeat(64),
      tls: { mode: 'public-ca', minVersion: 'TLS1.2' },
    };
    new AuthenticationService(registry, { enabled: false }).close();
    assert.equal(registry.registrationStorageStatus().ledgerVersion, 1);
    assert.throws(
      () =>
        new RegistrationService(registry, { descriptor }, { mode: 'proxy', publicBaseUrl: origin }),
      { code: 'SECURITY_INVALID_CONFIG' },
    );
    const versions = [];
    const oldRejects = (version) => {
      registry.close();
      const before = bytes();
      assert.throws(() => old.SecurityRegistry.open(directory), { code: 'SECURITY_STORE_INVALID' });
      assert.deepEqual(bytes(), before);
      versions.push(version);
      registry = SecurityRegistry.open(directory);
    };
    registry.migrateRegistrationStorage(registry.status().revision);
    oldRejects(2);
    registry.migrateSessionStorage(registry.status().revision);
    oldRejects(3);
    registry.migrateAuthenticationStorage(registry.status().revision);
    oldRejects(4);
    const local = (r) => registry.withLocalActor(sid, () => dispatchLocalSecurity(registry, r));
    const recipient = (action, extra = {}) =>
      local({
        action: 'registration.recipient.' + action,
        instanceId,
        ...(action === 'list' ? {} : { revision: registry.status().revision, confirm: true }),
        ...extra,
      });
    recipient('initialize');
    oldRejects(5);
    checks.explicitV1ToV5 = true;
    assert.deepEqual(versions, [2, 3, 4, 5]);
    checks.legacyReaderRejectsV2ToV5 = true;
    const purpose = 'modeldb-registry-v1:' + instanceId;
    const readState = () =>
      JSON.parse(
        protector
          .unprotect(readFileSync(join(directory, 'registry.mds'), 'utf8'), purpose)
          .toString(),
      );
    const migrated = readState();
    assert.equal(migrated.instanceId, instanceId);
    assert.equal(bytes()['instance.key'], original['instance.key']);
    for (const name of Object.keys(original).filter((n) => n.endsWith('.dek'))) {
      assert.equal(bytes()[name], original[name]);
    }
    registry.authenticate(api.token);
    registry.verifySession(session.session);
    registry.consumePairing(pair.code, origin);
    assert.throws(() => registry.authenticate(revoked.token), {
      code: 'SECURITY_CREDENTIAL_REVOKED',
    });
    checks.identityAndKeysPreserved = true;
    registry.close();
    const valid = readFileSync(join(directory, 'registry.mds'));
    for (const version of [0, 6, 99]) {
      const raw = JSON.parse(protector.unprotect(valid.toString(), purpose).toString());
      raw.version = version;
      writeFileSync(
        join(directory, 'registry.mds'),
        protector.protect(Buffer.from(JSON.stringify(raw)), purpose),
      );
      const before = bytes();
      assert.throws(() => SecurityRegistry.open(directory), { code: 'SECURITY_STORE_INVALID' });
      assert.deepEqual(bytes(), before);
    }
    writeFileSync(join(directory, 'registry.mds'), valid);
    registry = SecurityRegistry.open(directory);
    checks.unknownLedgerRejectedUnchanged = true;
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const { openBackupPackage } = await installed('security/backup-package');
    const { openAnyAssetPackage } = await installed('security/asset-package');
    const fingerprint = sha256(keyPair.publicKey.export({ type: 'spki', format: 'der' }));
    assert.throws(() =>
      openBackupPackage(Buffer.from('{"format":"modeldb.backup.v99"}'), {
        recipientKey: keyPair.privateKey,
      }),
    );
    assert.throws(() =>
      openAnyAssetPackage(
        Buffer.from(
          JSON.stringify({
            format: 'modeldb.asset.v99',
            protected: '',
            payload: '',
            signature: '',
          }),
        ),
        keyPair.privateKey,
        keyPair.publicKey,
        fingerprint,
      ),
    );
    checks.unknownPackagesRejected = true;
    const context = {
      source: {
        peerIp: '127.0.0.1',
        clientIp: '192.0.2.10',
        clientIpBasis: 'trusted-proxy',
        secure: true,
      },
      requestId: 'synthetic-installed',
      recheck: () => {},
    };
    registration = new RegistrationService(
      registry,
      { descriptor },
      { mode: 'proxy', publicBaseUrl: origin },
    );
    const begun = await registration.begin(
      {
        format: 'modeldb.device-registration.v1',
        version: 1,
        instanceId,
        deploymentDescriptorSha256: 'a'.repeat(64),
        displayName: 'Synthetic installed identity',
        userVerification: 'required',
      },
      context,
    );
    const loginPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
      jwk = loginPair.publicKey.export({ format: 'jwk' }),
      rawId = randomBytes(32).toString('base64url');
    const cose = isoCBOR.encode(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );
    const size = Buffer.alloc(2);
    size.writeUInt16BE(32);
    const authData = Buffer.concat([
      createHash('sha256').update(descriptor.rpId).digest(),
      Buffer.from([0x45]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      size,
      Buffer.from(rawId, 'base64url'),
      Buffer.from(cose),
    ]);
    const attestation = isoCBOR.encode(
      new Map([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    await registration.complete(
      {
        format: 'modeldb.device-registration.v1',
        version: 1,
        instanceId,
        registrationId: begun.registrationId,
        continuationSecret: begun.continuationSecret,
        deploymentDescriptorSha256: 'a'.repeat(64),
        challengeId: begun.challengeId,
        credential: {
          id: rawId,
          rawId,
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            clientDataJSON: Buffer.from(
              JSON.stringify({
                type: 'webauthn.create',
                challenge: begun.publicKey.challenge,
                origin,
                crossOrigin: false,
              }),
            ).toString('base64url'),
            attestationObject: Buffer.from(attestation).toString('base64url'),
          },
        },
      },
      context,
    );
    const approved = local({
      action: 'registration.approve',
      instanceId,
      id: begun.registrationId,
      revision: registry.status().revision,
      confirm: true,
      name: 'Synthetic installed owner',
      grants: [],
    });
    const challenge = recipient('begin', {
      userId: approved.userId,
      publicKey: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }).challenge;
    recipient('complete', {
      response: answerRecipientChallenge(challenge, keyPair.privateKey, Date.now()),
    });
    const recipientKey = recipient('list').keys[0];
    let counter = 0;
    const binding = {
      format: 'modeldb.device-authentication.v1',
      version: 1,
      instanceId,
      deploymentDescriptorSha256: 'a'.repeat(64),
    };
    const assertion = (b) => {
      const clientData = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: b.publicKey.challenge,
          origin,
          crossOrigin: false,
        }),
      );
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const data = Buffer.concat([
        createHash('sha256').update(descriptor.rpId).digest(),
        Buffer.from([5]),
        count,
      ]);
      return {
        ...binding,
        challengeId: b.challengeId,
        credential: {
          id: rawId,
          rawId,
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            clientDataJSON: clientData.toString('base64url'),
            authenticatorData: data.toString('base64url'),
            signature: sign(
              'sha256',
              Buffer.concat([data, createHash('sha256').update(clientData).digest()]),
              loginPair.privateKey,
            ).toString('base64url'),
            userHandle: begun.publicKey.user.id,
          },
        },
      };
    };
    authentication = new AuthenticationService(registry, { enabled: true }, descriptor);
    const login = async () => {
      const b = await authentication.begin(binding, context);
      return authentication.complete(assertion(b.response), b.ceremonySecret, context);
    };
    const loggedIn = await login();
    registry.verifyBrowserSession(loggedIn.session, origin);
    checks.registeredSignatureLogin = true;
    registration.close();
    registration = new RegistrationService(
      registry,
      { descriptor: { ...descriptor, registrationMode: 'disabled' } },
      { mode: 'proxy', publicBaseUrl: origin },
    );
    await assert.rejects(() =>
      registration.begin(
        {
          format: 'modeldb.device-registration.v1',
          version: 1,
          instanceId,
          deploymentDescriptorSha256: 'a'.repeat(64),
          displayName: 'closed',
          userVerification: 'required',
        },
        context,
      ),
    );
    registry.verifyBrowserSession((await login()).session, origin);
    checks.registrationClosedLoginStillWorks = true;
    authentication.close();
    authentication = new AuthenticationService(registry, { enabled: false }, descriptor);
    await assert.rejects(() => authentication.begin(binding, context));
    checks.authenticationDisabled = true;
    local({
      action: 'registration.user.disable',
      instanceId,
      id: approved.userId,
      revision: registry.status().revision,
      confirm: true,
    });
    assert.throws(() => registry.verifySession(loggedIn.session));
    close();
    registry = SecurityRegistry.open(directory);
    authentication = new AuthenticationService(registry, { enabled: true }, descriptor);
    registration = undefined;
    assert.throws(() => registry.verifySession(loggedIn.session));
    await assert.rejects(login);
    checks.disabledIdentitySurvivesRestart = true;
    local({
      action: 'registration.user.enable',
      instanceId,
      id: approved.userId,
      revision: registry.status().revision,
      confirm: true,
    });
    assert.throws(() => registry.verifySession(loggedIn.session));
    registry.verifySession((await login()).session);
    checks.reenableRequiresFreshLogin = true;
    assert.equal(recipient('list').keys[0].fingerprint, recipientKey.fingerprint);
    checks.recipientHistoryPreserved = true;
    close();
    const cli = spawnSync(
      process.execPath,
      [
        join(serverRoot, 'dist/cli.js'),
        'security',
        'recipient-list',
        '-c',
        config,
        '--instance',
        instanceId,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
        cwd: consumer,
        env: { ...process.env, MODELDB_HOME: join(home, 'unused') },
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).keys[0].fingerprint, recipientKey.fingerprint);
    checks.installedRecipientCli = true;
    registry = SecurityRegistry.open(directory);
    registry.resetAccess();
    close();
    registry = SecurityRegistry.open(directory);
    assert.throws(() => registry.authenticate(api.token), { code: 'SECURITY_CREDENTIAL_REVOKED' });
    assert.equal(registry.readRegistrationStorage().users.length, 1);
    assert.ok(registry.readRegistrationStorage().credentials.every((c) => c.state === 'revoked'));
    assert.equal(recipient('list').keys[0].state, 'retired');
    assert.throws(() => registry.verifySession(loggedIn.session));
    checks.accessResetDoesNotRevive = true;
    const { loadHostedAssets, installHostedAssets } = await installed('security/browser-hosting');
    const assets = loadHostedAssets(join(root, 'apps/model-designer'), [
      directory,
      join(stateDir, 'vault'),
    ]);
    const app = Fastify({ logger: false });
    try {
      installHostedAssets(app, assets, '/designer/');
      await app.listen({ host: '127.0.0.1', port: 0 });
      const url = 'http://127.0.0.1:' + app.server.address().port;
      const response = await fetch(url + '/designer/');
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<html/);
      const file = candidate.manifest.apps
        .find((a) => a.name === 'model-designer')
        .files.find((f) => f.path.endsWith('.js'));
      const js = await fetch(url + '/' + file.path);
      assert.equal(js.status, 200);
      assert.equal(sha256(Buffer.from(await js.arrayBuffer())), file.sha256);
    } finally {
      await app.close();
    }
    checks.installedDesignerHosting = true;
    checkInstalledCandidate(root);
    const report = {
      format: 'modeldb.installed-upgrade.v1',
      task: 'DR-P4.3',
      ok: true,
      node: process.version,
      platform: process.platform,
      releaseManifestSha256: candidate.manifestSha256,
      legacy: {
        sourceSha256: sha256(fixture),
        compiledSha256: sha256(compiled),
        rejectedVersions: versions,
        scope:
          'frozen V1 registry reader compiled to JavaScript with current installed helper modules; not a complete historical release',
      },
      checks,
      scope: {
        temporarySyntheticOnly: true,
        liveMaterialRead: false,
        realTwoDeviceTested: false,
        hardwareAuthenticatorTested: false,
        fullHistoricalPackageDowngradeTested: false,
        performanceTested: false,
        frontendChanged: false,
      },
    };
    assertInstalledUpgradeReport(report);
    return report;
  } finally {
    close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 3);
    const report = await verifyInstalledUpgrade(process.argv[2]);
    writeFileSync(
      join(process.argv[2], 'installed-upgrade.json'),
      JSON.stringify(report, null, 2) + '\n',
      { flag: 'wx' },
    );
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (error) {
    // Stack locations help diagnose packaged code without printing assertion values or secrets.
    process.stderr.write(String(error.code ?? error.name) + '\n');
    process.stderr.write(
      String(error.stack)
        .split('\n')
        .filter((line) => /^\s+at /.test(line))
        .join('\n') + '\n',
    );
    process.exitCode = 1;
  }
}
