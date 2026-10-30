/** Probe an isolated, locked installation. Does not open a ModelDB instance or use the network. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = fileURLToPath(new URL('./security-registration-dependencies/', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function checkRegistrationLibrary(installation) {
  const root = resolve(installation);
  const bytes = readFileSync(join(root, 'pnpm-lock.yaml'));
  assert.equal(
    bytes.toString().replace(/\r\n/g, '\n'),
    readFileSync(join(fixture, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n'),
    'DEPENDENCY_LOCK_MISMATCH',
  );
  const pkgRoot = join(root, 'node_modules/@simplewebauthn/server');
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '14.0.3');
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(
    readFileSync(join(pkgRoot, 'LICENSE.md')),
    readFileSync(join(fixture, 'LICENSE.simplewebauthn.md')),
  );
  const library = await import(pathToFileURL(join(pkgRoot, 'esm/index.js')).href);
  const registration = await library.generateRegistrationOptions({
    rpName: 'Synthetic ModelDB',
    rpID: 'modeldb-a.example.test',
    userID: new Uint8Array(32),
    userName: 'synthetic-registration',
    userDisplayName: 'Synthetic B',
    attestationType: 'none',
    timeout: 60000,
    supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  assert.equal(Buffer.from(registration.challenge, 'base64url').byteLength, 32);
  assert.equal(registration.rp.id, 'modeldb-a.example.test');
  assert.equal(registration.authenticatorSelection.userVerification, 'required');
  assert.deepEqual(
    registration.pubKeyCredParams.map((value) => value.alg),
    [-7, -257],
  );
  const authentication = await library.generateAuthenticationOptions({
    rpID: registration.rp.id,
    userVerification: 'required',
  });
  assert.equal(Buffer.from(authentication.challenge, 'base64url').byteLength, 32);
  const response = {
    id: 'AA',
    rawId: 'AA',
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON: 'AA', attestationObject: 'AA' },
  };
  await assert.rejects(
    library.verifyRegistrationResponse({
      response,
      expectedChallenge: registration.challenge,
      expectedOrigin: 'https://modeldb-a.example.test',
      expectedRPID: registration.rp.id,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    }),
  );
  assert.equal(typeof library.verifyAuthenticationResponse, 'function');
  const packages = [];
  for (const item of readdirSync(join(root, 'node_modules/.pnpm'), { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const entry = item.name;
    if (!item.isDirectory() || entry === 'node_modules' || entry.startsWith('.')) {
      continue;
    }
    const directory = join(root, 'node_modules/.pnpm', entry, 'node_modules');
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const names = name.name.startsWith('@')
        ? readdirSync(join(directory, name.name)).map((child) => name.name + '/' + child)
        : [name.name];
      for (const moduleName of names) {
        // The physical package belongs to this store entry; ignore dependency links.
        if (!entry.startsWith(moduleName.replace('/', '+') + '@')) {
          continue;
        }
        const metadata = JSON.parse(
          readFileSync(join(directory, moduleName, 'package.json'), 'utf8'),
        );
        packages.push({
          name: metadata.name,
          version: metadata.version,
          license: metadata.license,
          engines: metadata.engines ?? null,
        });
      }
    }
  }
  assert.equal(packages.length, 25);
  assert.ok(packages.every((pkg) => typeof pkg.license === 'string' && pkg.license.length > 0));
  return {
    format: 'modeldb.registration-library-check.v1',
    ok: true,
    node: process.version,
    library: { name: pkg.name, version: pkg.version, license: pkg.license, engines: pkg.engines },
    lockSha256: hash(bytes),
    lockSha256Lf: hash(bytes.toString().replace(/\r\n/g, '\n')),
    licenseSha256: hash(readFileSync(join(pkgRoot, 'LICENSE.md'))),
    packages,
    checks: {
      import: true,
      creationOptions: true,
      authenticationOptions: true,
      malformedProofRejected: true,
      exactLock: true,
      licenseText: true,
    },
    runtimeRegistrationImplemented: false,
    authenticatorVerified: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(
      process.argv.length,
      4,
      'Usage: node scripts/security-registration-library-check.mjs --installation <isolated-folder>',
    );
    assert.equal(process.argv[2], '--installation');
    process.stdout.write(
      JSON.stringify(await checkRegistrationLibrary(process.argv[3]), null, 2) + '\n',
    );
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}
