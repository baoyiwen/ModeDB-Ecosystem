import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { it } from 'node:test';
import {
  assertDeploymentBinding,
  assertDeploymentCertificate,
  assertInstanceBinding,
  canonicalOrigin,
  sampleDeploymentDescriptor,
  validateDeploymentDescriptor,
} from '../../scripts/security-registration-contract.mjs';

function valid() {
  return structuredClone(sampleDeploymentDescriptor());
}

it('accepts the frozen synthetic deployment contract and canonical origin', () => {
  const descriptor = validateDeploymentDescriptor(valid());
  assert.equal(descriptor.serverOrigin, 'https://modeldb-a.example.test');
  assert.equal(canonicalOrigin(descriptor.serverOrigin), descriptor.serverOrigin);
});

for (const [name, mutate, error] of [
  ['rejects HTTP origins', (d) => { d.serverOrigin = 'http://modeldb-a.example.test'; }, /ORIGIN_HTTPS_REQUIRED/],
  ['rejects IP origins', (d) => { d.serverOrigin = 'https://192.0.2.10'; d.rpId = '192.0.2.10'; }, /ORIGIN_IP_REJECTED/],
  ['rejects localhost origins', (d) => { d.serverOrigin = 'https://localhost'; d.rpId = 'localhost'; }, /ORIGIN_LOCALHOST_REJECTED/],
  ['rejects paths and query strings', (d) => { d.serverOrigin = 'https://modeldb-a.example.test/app?x=1'; }, /ORIGIN_PATH_REJECTED/],
  ['rejects RP ID drift', (d) => { d.rpId = 'other.example.test'; }, /RP_ID_ORIGIN_MISMATCH/],
  ['rejects owner-pinned TLS without an SPKI pin', (d) => { d.tls = { mode: 'owner-pinned', minVersion: 'TLS1.2' }; }, /TLS_SPKI_PIN_REQUIRED/],
  ['rejects host-derived identity', (d) => { d.binding.allowHostDerivedIdentity = true; }, /HOST_DERIVED_IDENTITY_FORBIDDEN/],
  ['rejects public descriptor secrets and grants', (d) => { d.token = 'synthetic'; }, /DEPLOYMENT_DESCRIPTOR_UNKNOWN_FIELD:token/],
  ['rejects invalid performance samples', (d) => { d.performanceBaseline.samples.login = 0; }, /PERFORMANCE_SAMPLE_login_POSITIVE_INTEGER_REQUIRED/],
]) {
  it(name, () => {
    const descriptor = valid();
    mutate(descriptor);
    assert.throws(() => validateDeploymentDescriptor(descriptor), error);
  });
}

it('requires exact instance binding and rejects a different instance', () => {
  const descriptor = valid();
  assert.equal(assertInstanceBinding(descriptor.instanceId, descriptor.instanceId), true);
  assert.throws(() => assertInstanceBinding(descriptor.instanceId, '8b0c8c6c-8f3c-4a30-9d8e-18be6e6f4c02'), /INSTANCE_BINDING_MISMATCH/);
});

it('rejects simultaneous Origin/RP substitution and port drift against trusted deployment state', () => {
  const trusted = valid();
  assert.equal(assertDeploymentBinding(trusted, valid()), true);
  for (const [origin, rpId] of [
    ['https://other.example.test', 'other.example.test'],
    ['https://modeldb-a.example.test:9443', trusted.rpId],
  ]) {
    const presented = valid();
    presented.serverOrigin = origin;
    presented.rpId = rpId;
    assert.throws(() => assertDeploymentBinding(trusted, presented), /ORIGIN_BINDING_MISMATCH/);
  }
});

it('rejects non-canonical origins and wildcard DNS names', () => {
  assert.throws(() => canonicalOrigin('https://MODELDB-A.example.test'), /ORIGIN_NOT_CANONICAL|ORIGIN_HOST_NOT_LOWERCASE/);
  const descriptor = valid();
  descriptor.serverOrigin = 'https://*.example.test';
  descriptor.rpId = '*.example.test';
  assert.throws(() => validateDeploymentDescriptor(descriptor), /ORIGIN_DNS_NAME_REQUIRED/);
});

it('keeps the documented JSON example identical to the checked synthetic contract', () => {
  const example = JSON.parse(readFileSync(new URL('../../docs/security-v1/examples/device-registration.deployment.v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateDeploymentDescriptor(example), valid());
});

it('rejects origin aliases, user information, query strings and fragments', () => {
  for (const origin of [
    'https://modeldb-a.example.test?token=synthetic',
    'https://modeldb-a.example.test#synthetic',
    'https://user:synthetic@modeldb-a.example.test',
    'https://modeldb-a.example.test/',
    'https://modeldb-a.example.test:443',
    'https://modeldb-a.example.test.',
    'https://device.localhost',
    'https://127.1',
    'https://[::1]',
  ]) assert.throws(() => canonicalOrigin(origin));
});

it('rejects sensitive fields at all descriptor object boundaries', () => {
  for (const field of ['token', 'secret', 'privateKey', 'passphrase', 'grant', 'database', 'command']) {
    for (const target of [
      (d) => d, (d) => d.registration, (d) => d.tls, (d) => d.binding,
      (d) => d.supportMatrix, (d) => d.supportMatrix.node, (d) => d.supportMatrix.browsers[0],
      (d) => d.performanceBaseline, (d) => d.performanceBaseline.samples, (d) => d.performanceBaseline.p95LimitsMs,
    ]) {
      const descriptor = valid();
      target(descriptor)[field] = 'synthetic';
      assert.throws(() => validateDeploymentDescriptor(descriptor), /UNKNOWN_FIELD/);
    }
  }
});

it('requires secure user verification, distinct runtime versions and finite positive baseline values', () => {
  for (const mutate of [
    (d) => { d.supportMatrix.browsers[0].secureContext = false; },
    (d) => { d.supportMatrix.browsers[0].userVerification = 'preferred'; },
    (d) => { d.supportMatrix.browsers.push(d.supportMatrix.browsers[0]); },
    (d) => { d.supportMatrix.node.supportedMajors.push(d.supportMatrix.node.minimumMajor); },
    (d) => { d.supportMatrix.node.supportedMajors = []; },
    (d) => { d.performanceBaseline.samples.login = Number.MAX_SAFE_INTEGER + 1; },
    (d) => { d.performanceBaseline.p95LimitsMs.login = Infinity; },
    (d) => { d.tls.spkiSha256 = 'a'.repeat(64); },
    (d) => { d.descriptorVersion = 2; },
    (d) => { d.instanceId = 'not-an-instance'; },
  ]) {
    const descriptor = valid();
    mutate(descriptor);
    assert.throws(() => validateDeploymentDescriptor(descriptor));
  }
});

const cert = readFileSync(new URL('../fixtures/security-registration-tls/modeldb-a.crt', import.meta.url));
const key = readFileSync(new URL('../fixtures/security-registration-tls/modeldb-a.key', import.meta.url));
const certificate = new X509Certificate(cert);
const pin = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

it('checks certificate SAN, validity and the owner-approved SPKI pin without trusting the descriptor itself', () => {
  const descriptor = valid();
  descriptor.tls = { mode: 'owner-pinned', minVersion: 'TLS1.2', spkiSha256: pin };
  assert.equal(assertDeploymentCertificate(descriptor, cert), true);
  for (const invalidPin of [undefined, 'invalid', 123]) {
    assert.throws(() => validateDeploymentDescriptor({ ...descriptor, tls: { ...descriptor.tls, spkiSha256: invalidPin } }), /TLS_SPKI_PIN_REQUIRED/);
  }
  assert.throws(() => assertDeploymentCertificate(descriptor, cert, Date.parse(certificate.validFrom) - 1), /TLS_CERTIFICATE_TIME_INVALID/);
  assert.throws(() => assertDeploymentCertificate(descriptor, cert, Date.parse(certificate.validTo)), /TLS_CERTIFICATE_TIME_INVALID/);
  descriptor.tls.spkiSha256 = '0'.repeat(64);
  assert.throws(() => assertDeploymentCertificate(descriptor, cert), /TLS_CERTIFICATE_PIN_MISMATCH/);
  descriptor.serverOrigin = 'https://other.example.test';
  descriptor.rpId = 'other.example.test';
  assert.throws(() => assertDeploymentCertificate(descriptor, cert), /TLS_CERTIFICATE_HOST_MISMATCH/);
});

it('uses isolated DNS/TLS to reject an untrusted root, wrong SAN and wrong pin before any HTTP request', { timeout: 15000 }, async () => {
  let received = 0;
  let lookups = 0;
  const server = createServer({ cert, key, minVersion: 'TLSv1.2' }, (_req, res) => {
    received++;
    res.end('synthetic-only');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object' && address.port !== 9091);
  const descriptor = valid();
  descriptor.serverOrigin += ':' + address.port;
  const get = (deployment, trust = true) => new Promise((resolve, reject) => {
    const req = request(deployment.serverOrigin, {
      agent: false,
      ca: trust ? cert : [],
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      lookup(hostname, options, done) {
        assert.ok(['modeldb-a.example.test', 'other.example.test'].includes(hostname));
        lookups++;
        // No OS DNS changes or external DNS traffic. Both test names resolve only here.
        if (options.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
        else done(null, '127.0.0.1', 4);
      },
      checkServerIdentity(hostname, peer) {
        const error = checkServerIdentity(hostname, peer);
        if (error) return error;
        try { assertDeploymentCertificate(deployment, peer.raw); }
        catch (failure) { return failure; }
      },
    }, (response) => {
      assert.equal(response.socket.authorized, true);
      response.resume();
      response.once('error', reject);
      response.once('end', resolve);
    });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('ISOLATED_TLS_TIMEOUT')));
    req.end();
  });
  try {
    await get(descriptor);
    await assert.rejects(get(descriptor, false), /self-signed|certificate/i);
    const wrongHost = { ...descriptor, serverOrigin: 'https://other.example.test:' + address.port, rpId: 'other.example.test' };
    await assert.rejects(get(wrongHost), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    descriptor.tls = { mode: 'owner-pinned', minVersion: 'TLS1.2', spkiSha256: '0'.repeat(64) };
    await assert.rejects(get(descriptor), /TLS_CERTIFICATE_PIN_MISMATCH/);
    descriptor.tls.spkiSha256 = pin;
    await get(descriptor);
    assert.equal(received, 2);
    assert.equal(lookups, 5);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
