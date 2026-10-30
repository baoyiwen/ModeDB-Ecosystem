/** Validate the non-secret deployment contract used by the future registration flow. */
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const FORMAT = 'modeldb.device-registration-deployment.v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DNS_LABEL =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const BROWSERS = new Set(['chrome', 'edge', 'firefox', 'safari']);
const TOP_LEVEL_KEYS = new Set([
  'format',
  'descriptorVersion',
  'instanceId',
  'serverOrigin',
  'rpId',
  'registration',
  'tls',
  'binding',
  'supportMatrix',
  'performanceBaseline',
]);

function object(value, name) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${name}_OBJECT_REQUIRED`);
  return value;
}

function keys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    assert.ok(allowed.has(key), `${name}_UNKNOWN_FIELD:${key}`);
  }
}

function positiveInteger(value, name) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name}_POSITIVE_INTEGER_REQUIRED`);
}

export function canonicalOrigin(value) {
  assert.equal(typeof value, 'string', 'ORIGIN_STRING_REQUIRED');
  assert.equal(value.trim(), value, 'ORIGIN_WHITESPACE_REJECTED');
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', 'ORIGIN_HTTPS_REQUIRED');
  assert.equal(url.username, '', 'ORIGIN_USERINFO_REJECTED');
  assert.equal(url.password, '', 'ORIGIN_USERINFO_REJECTED');
  assert.equal(url.pathname, '/', 'ORIGIN_PATH_REJECTED');
  assert.equal(url.search, '', 'ORIGIN_QUERY_REJECTED');
  assert.equal(url.hash, '', 'ORIGIN_FRAGMENT_REJECTED');
  assert.equal(url.origin, value, 'ORIGIN_NOT_CANONICAL');
  const hostname = url.hostname.toLowerCase();
  assert.equal(hostname, url.hostname, 'ORIGIN_HOST_NOT_LOWERCASE');
  assert.ok(
    hostname !== 'localhost' && !hostname.endsWith('.localhost'),
    'ORIGIN_LOCALHOST_REJECTED',
  );
  assert.ok(!hostname.endsWith('.'), 'ORIGIN_TRAILING_DOT_REJECTED');
  assert.equal(isIP(hostname), 0, 'ORIGIN_IP_REJECTED');
  assert.match(hostname, DNS_LABEL, 'ORIGIN_DNS_NAME_REQUIRED');
  return url.origin;
}

function validateTls(value) {
  const tls = object(value, 'TLS');
  keys(tls, new Set(['mode', 'minVersion', 'spkiSha256']), 'TLS');
  assert.ok(tls.mode === 'public-ca' || tls.mode === 'owner-pinned', 'TLS_MODE_INVALID');
  assert.equal(tls.minVersion, 'TLS1.2', 'TLS_MIN_VERSION_INVALID');
  if (tls.mode === 'owner-pinned') {
    assert.ok(
      typeof tls.spkiSha256 === 'string' && HEX_64.test(tls.spkiSha256),
      'TLS_SPKI_PIN_REQUIRED',
    );
  } else {
    assert.equal(tls.spkiSha256, undefined, 'TLS_PUBLIC_CA_PIN_UNEXPECTED');
  }
  return tls;
}

function validateSupportMatrix(value) {
  const support = object(value, 'SUPPORT_MATRIX');
  keys(support, new Set(['browsers', 'node']), 'SUPPORT_MATRIX');
  assert.ok(Array.isArray(support.browsers) && support.browsers.length > 0, 'BROWSERS_REQUIRED');
  const seen = new Set();
  for (const item of support.browsers) {
    const browser = object(item, 'BROWSER');
    keys(
      browser,
      new Set(['name', 'minimumMajor', 'secureContext', 'userVerification']),
      'BROWSER',
    );
    assert.ok(BROWSERS.has(browser.name), 'BROWSER_NAME_INVALID');
    assert.ok(!seen.has(browser.name), 'BROWSER_DUPLICATE');
    seen.add(browser.name);
    positiveInteger(browser.minimumMajor, 'BROWSER_MINIMUM_MAJOR');
    assert.equal(browser.secureContext, true, 'BROWSER_SECURE_CONTEXT_REQUIRED');
    assert.equal(browser.userVerification, 'required', 'BROWSER_USER_VERIFICATION_REQUIRED');
  }
  const node = object(support.node, 'NODE_SUPPORT');
  keys(node, new Set(['runtime', 'minimumMajor', 'supportedMajors']), 'NODE_SUPPORT');
  assert.equal(node.runtime, 'node', 'NODE_RUNTIME_INVALID');
  positiveInteger(node.minimumMajor, 'NODE_MINIMUM_MAJOR');
  assert.ok(
    Array.isArray(node.supportedMajors) && node.supportedMajors.length > 0,
    'NODE_SUPPORTED_MAJORS_REQUIRED',
  );
  assert.ok(
    node.supportedMajors.every(
      (major) => Number.isSafeInteger(major) && major >= node.minimumMajor,
    ) &&
      new Set(node.supportedMajors).size === node.supportedMajors.length &&
      node.supportedMajors.includes(node.minimumMajor),
    'NODE_SUPPORTED_MAJOR_INVALID',
  );
  return support;
}

function validatePerformance(value) {
  const baseline = object(value, 'PERFORMANCE_BASELINE');
  keys(
    baseline,
    new Set(['version', 'method', 'samples', 'p95LimitsMs', 'excluded']),
    'PERFORMANCE_BASELINE',
  );
  assert.equal(baseline.version, 1, 'PERFORMANCE_VERSION_INVALID');
  assert.equal(baseline.method, 'isolated-synthetic-ab', 'PERFORMANCE_METHOD_INVALID');
  const scenarios = [
    'registrationBegin',
    'registrationVerify',
    'login',
    'revoke',
    'queryAfterLogin',
  ];
  const samples = object(baseline.samples, 'PERFORMANCE_SAMPLES');
  const limits = object(baseline.p95LimitsMs, 'PERFORMANCE_LIMITS');
  keys(samples, new Set(scenarios), 'PERFORMANCE_SAMPLES');
  keys(limits, new Set(scenarios), 'PERFORMANCE_LIMITS');
  for (const scenario of scenarios) {
    positiveInteger(samples[scenario], `PERFORMANCE_SAMPLE_${scenario}`);
    positiveInteger(limits[scenario], `PERFORMANCE_LIMIT_${scenario}`);
  }
  assert.equal(baseline.excluded, 'user-verification-prompt', 'PERFORMANCE_EXCLUSION_INVALID');
  return baseline;
}

export function assertInstanceBinding(expectedInstanceId, presentedInstanceId) {
  assert.match(expectedInstanceId, UUID_V4, 'EXPECTED_INSTANCE_ID_INVALID');
  assert.equal(presentedInstanceId, expectedInstanceId, 'INSTANCE_BINDING_MISMATCH');
  return true;
}

export function validateDeploymentDescriptor(input) {
  const descriptor = object(input, 'DEPLOYMENT_DESCRIPTOR');
  keys(descriptor, TOP_LEVEL_KEYS, 'DEPLOYMENT_DESCRIPTOR');
  assert.equal(descriptor.format, FORMAT, 'DEPLOYMENT_FORMAT_INVALID');
  assert.equal(descriptor.descriptorVersion, 1, 'DEPLOYMENT_VERSION_INVALID');
  assert.match(descriptor.instanceId, UUID_V4, 'INSTANCE_ID_INVALID');
  const origin = canonicalOrigin(descriptor.serverOrigin);
  assert.equal(descriptor.rpId, new URL(origin).hostname, 'RP_ID_ORIGIN_MISMATCH');
  assert.match(descriptor.rpId, DNS_LABEL, 'RP_ID_DNS_NAME_REQUIRED');
  const registration = object(descriptor.registration, 'REGISTRATION');
  keys(registration, new Set(['mode', 'publicDownload']), 'REGISTRATION');
  assert.ok(
    ['planned', 'enabled', 'disabled'].includes(registration.mode),
    'REGISTRATION_MODE_INVALID',
  );
  assert.equal(registration.publicDownload, true, 'PUBLIC_DOWNLOAD_REQUIRED');
  validateTls(descriptor.tls);
  const binding = object(descriptor.binding, 'BINDING');
  keys(
    binding,
    new Set(['strategy', 'requireExactInstanceId', 'allowHostDerivedIdentity']),
    'BINDING',
  );
  assert.equal(binding.strategy, 'instance-id-exact', 'BINDING_STRATEGY_INVALID');
  assert.equal(binding.requireExactInstanceId, true, 'EXACT_INSTANCE_BINDING_REQUIRED');
  assert.equal(binding.allowHostDerivedIdentity, false, 'HOST_DERIVED_IDENTITY_FORBIDDEN');
  validateSupportMatrix(descriptor.supportMatrix);
  validatePerformance(descriptor.performanceBaseline);
  return { ...descriptor, serverOrigin: origin };
}

/** Compare against independently trusted deployment state, never a client-provided baseline. */
export function assertDeploymentBinding(expected, presented) {
  const trusted = validateDeploymentDescriptor(expected);
  const candidate = validateDeploymentDescriptor(presented);
  assertInstanceBinding(trusted.instanceId, candidate.instanceId);
  assert.equal(candidate.serverOrigin, trusted.serverOrigin, 'ORIGIN_BINDING_MISMATCH');
  assert.equal(candidate.rpId, trusted.rpId, 'RP_ID_BINDING_MISMATCH');
  return true;
}

/** Offline name/validity/pin check. The caller must separately enforce TLS chain validation. */
export function assertDeploymentCertificate(input, certificateBytes, now = Date.now()) {
  const descriptor = validateDeploymentDescriptor(input);
  const certificate = new X509Certificate(certificateBytes);
  assert.ok(
    certificate.checkHost(descriptor.rpId, { subject: 'never' }),
    'TLS_CERTIFICATE_HOST_MISMATCH',
  );
  assert.ok(
    Number.isFinite(now) &&
      now >= Date.parse(certificate.validFrom) &&
      now < Date.parse(certificate.validTo),
    'TLS_CERTIFICATE_TIME_INVALID',
  );
  if (descriptor.tls.mode === 'owner-pinned') {
    const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
    assert.equal(
      createHash('sha256').update(spki).digest('hex'),
      descriptor.tls.spkiSha256,
      'TLS_CERTIFICATE_PIN_MISMATCH',
    );
  }
  return true;
}

export function sampleDeploymentDescriptor() {
  return {
    format: FORMAT,
    descriptorVersion: 1,
    instanceId: '3f1d6f1f-b6c8-4b6a-9d72-6c9b4d5c7e10',
    serverOrigin: 'https://modeldb-a.example.test',
    rpId: 'modeldb-a.example.test',
    registration: { mode: 'planned', publicDownload: true },
    tls: { mode: 'public-ca', minVersion: 'TLS1.2' },
    binding: {
      strategy: 'instance-id-exact',
      requireExactInstanceId: true,
      allowHostDerivedIdentity: false,
    },
    supportMatrix: {
      browsers: [
        { name: 'chrome', minimumMajor: 120, secureContext: true, userVerification: 'required' },
        { name: 'edge', minimumMajor: 120, secureContext: true, userVerification: 'required' },
        { name: 'firefox', minimumMajor: 122, secureContext: true, userVerification: 'required' },
        { name: 'safari', minimumMajor: 17, secureContext: true, userVerification: 'required' },
      ],
      node: { runtime: 'node', minimumMajor: 22, supportedMajors: [22, 24] },
    },
    performanceBaseline: {
      version: 1,
      method: 'isolated-synthetic-ab',
      samples: {
        registrationBegin: 30,
        registrationVerify: 30,
        login: 60,
        revoke: 30,
        queryAfterLogin: 60,
      },
      p95LimitsMs: {
        registrationBegin: 500,
        registrationVerify: 1500,
        login: 1000,
        revoke: 1000,
        queryAfterLogin: 1500,
      },
      excluded: 'user-verification-prompt',
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/security-registration-contract.mjs');
    process.stdout.write(
      JSON.stringify(validateDeploymentDescriptor(sampleDeploymentDescriptor()), null, 2) + '\n',
    );
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}
