/** Public DR-P4.6 tickets and isolated paths. Never accepts an existing database. */
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, webcrypto, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullSourceSnapshot } from './security-full-contract.mjs';

export const repository = fileURLToPath(new URL('../', import.meta.url));
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function deviceFailureCode(error) {
  // AssertionError appends actual/expected details. Preserve only a symbolic first line.
  const first = String(error?.message ?? '').split(/\r?\n/)[0];
  return /^(?:DEVICE|SECURITY|VAULT)_[A-Z0-9_]+$/.test(first) ? first : 'DEVICE_STEP_FAILED';
}
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const ticketKeys = [
  'format',
  'runId',
  'serverAddress',
  'clientAddress',
  'port',
  'rpId',
  'origin',
  'spkiSha256',
  'sourceSha256',
  'expiresAtUtc',
];
export function privateIPv4(value) {
  if (typeof value !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return false;
  }
  const parts = value.split('.').map(Number);
  if (parts.some((n, i) => n > 255 || String(n) !== value.split('.')[i])) {
    return false;
  }
  const [a, b, , d] = parts;
  return (
    d !== 0 &&
    d !== 255 &&
    (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
  );
}
export function validateTicket(ticket, now = Date.now()) {
  assert.deepEqual(Object.keys(ticket).sort(), [...ticketKeys].sort(), 'DEVICE_TICKET_SCHEMA');
  assert.equal(ticket.format, 'modeldb.windows-device-drill.v1');
  assert.match(ticket.runId, uuidPattern);
  const local = ticket.serverAddress === '127.0.0.1' && ticket.clientAddress === '127.0.0.1';
  assert.ok(
    local ||
      (privateIPv4(ticket.serverAddress) &&
        privateIPv4(ticket.clientAddress) &&
        ticket.serverAddress !== ticket.clientAddress),
    'DEVICE_PRIVATE_ADDRESSES_REQUIRED',
  );
  assert.ok(
    Number.isSafeInteger(ticket.port) &&
      ticket.port >= 1024 &&
      ticket.port <= 65535 &&
      ticket.port !== 9091,
    'DEVICE_PORT_REJECTED',
  );
  assert.equal(ticket.rpId, `drill-${ticket.runId}.example.test`);
  assert.equal(ticket.origin, `https://${ticket.rpId}:${ticket.port}`);
  for (const name of ['spkiSha256', 'sourceSha256']) {
    assert.match(ticket[name], hashPattern);
  }
  const expires = Date.parse(ticket.expiresAtUtc);
  assert.ok(expires > now && expires <= now + 25 * 3600000, 'DEVICE_TICKET_EXPIRED');
  assert.equal(new Date(expires).toISOString(), ticket.expiresAtUtc);
  return ticket;
}
export function readTicket(path) {
  assert.equal(basename(path), 'connection.json', 'DEVICE_PUBLIC_TICKET_REQUIRED');
  assert.ok(
    !lstatSync(path).isSymbolicLink() && lstatSync(path).size <= 8192,
    'DEVICE_TICKET_FILE_REJECTED',
  );
  return validateTicket(JSON.parse(readFileSync(path, 'utf8')));
}
export function drillRoot(path) {
  const absolute = resolve(path);
  assert.equal(
    dirname(absolute).toLowerCase(),
    realpathSync(tmpdir()).toLowerCase(),
    'DEVICE_TEMP_ROOT_REQUIRED',
  );
  assert.match(basename(absolute), /^ModeDB-Device-Drill-[A-Za-z0-9]+$/);
  assert.ok(
    !lstatSync(absolute).isSymbolicLink() && lstatSync(absolute).isDirectory(),
    'DEVICE_ROOT_LINK_REJECTED',
  );
  assert.equal(
    realpathSync(absolute).toLowerCase(),
    absolute.toLowerCase(),
    'DEVICE_ROOT_LINK_REJECTED',
  );
  return absolute;
}
export function ownFile(root, path) {
  drillRoot(root);
  assert.ok(
    typeof path === 'string' &&
      path.split('/').every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== '.' && p !== '..'),
    'DEVICE_RELATIVE_PATH_REQUIRED',
  );
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), 'DEVICE_FILE_LINK_REJECTED');
  }
  assert.ok(lstatSync(current).isFile(), 'DEVICE_FILE_REQUIRED');
  return current;
}
export function sourceFingerprint() {
  const files = fullSourceSnapshot(repository).map(({ path }) => ({
    path,
    sha256: digest(readFileSync(join(repository, path), 'utf8').replace(/\r\n/g, '\n')),
  }));
  return digest(JSON.stringify(files));
}
export async function createDrillCertificate(rpId) {
  assert.match(rpId, /^drill-[0-9a-f-]{36}\.example\.test$/);
  // Resolve the already installed transitive library from its real pnpm location.
  const dependency = createRequire(
    realpathSync(
      join(repository, 'packages/server/node_modules/@simplewebauthn/server/package.json'),
    ),
  );
  const requireX509 = createRequire(dependency.resolve('@peculiar/x509'));
  requireX509('reflect-metadata');
  const x509 = requireX509('@peculiar/x509');
  const keys = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      name: `CN=${rpId}`,
      keys,
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 24 * 3600000),
      extensions: [
        new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: rpId }]),
        new x509.BasicConstraintsExtension(false),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        ),
        new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']),
      ],
    },
    webcrypto,
  );
  const key = createPrivateKey({
    key: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)),
    format: 'der',
    type: 'pkcs8',
  });
  const certificate = cert.toString('pem');
  const parsed = new X509Certificate(certificate);
  assert.equal(parsed.checkHost(rpId, { subject: 'never' }), rpId);
  assert.ok(parsed.checkPrivateKey(key) && parsed.verify(parsed.publicKey));
  return {
    certificate,
    privateKey: key.export({ type: 'pkcs8', format: 'pem' }),
    spkiSha256: digest(parsed.publicKey.export({ type: 'spki', format: 'der' })),
  };
}

export function assertProbe(result) {
  assert.deepEqual(result, {
    saved: true,
    readBack: true,
    csrfDenied: true,
    crossDatabaseDenied: true,
    managementDenied: true,
  });
}
export function assertIsolatedConfig(config) {
  // Fixed freshly generated layout only; reject every additional configuration field.
  assert.deepEqual(
    config,
    {
      port: 9090,
      host: '127.0.0.1',
      advertisedHost: '',
      publicBaseUrl: '',
      logDir: 'logs',
      workspace: 'vault',
      bufferThreshold: 50000,
      cacheSize: '2GB',
      mode: 'development',
      designerWorkspace: 'model_designer_workspace',
      security: { version: 1 },
      autoBackup: { enabled: false, intervalMinutes: 60, runOnStart: false, reason: 'auto' },
      dev: false,
    },
    'DEVICE_GENERATED_CONFIG_REQUIRED',
  );
}
// Only fixed, synthetic RPC operations; CSRF/cookies/data never leave the page.
export function saveExpression(write) {
  assert.equal(typeof write, 'boolean');
  return `(async()=>{
    const session=await fetch('/api/v1/security/session').then(r=>r.json());
    const rpc=(database,operation,csrf=true)=>fetch('/api/v1/rpc',{method:'POST',headers:{'content-type':'application/json',...(csrf?{'x-modeldb-csrf':session.csrf}:{})},body:JSON.stringify({version:1,database,operation})});
    const insert={op:'insert',model:'SyntheticItem',data:{label:'device-drill-saved'},sync:true};
    const csrfDenied=${write}?(await rpc('synthetic_business',insert,false)).status===403:true;
    const saved=${write}?(await rpc('synthetic_business',insert)).status===200:true;
    const query={op:'executeQuery',snapshot:{plan:{version:2,originModel:'SyntheticItem',start:{kind:'all'},hops:[],trailing:{type:'atom',field:'label',op:'eq',value:'device-drill-saved'}},execute:{},analysis:{groupBy:null,compute:null}}};
    const response=await rpc('synthetic_business',query),rows=await response.json();
    return {saved,readBack:response.status===200&&JSON.stringify(rows).includes('device-drill-saved'),csrfDenied,crossDatabaseDenied:(await rpc('synthetic_other',query)).status===403,managementDenied:(await fetch('/api/v1/security/admin/overview')).status===404};
  })()`;
}
