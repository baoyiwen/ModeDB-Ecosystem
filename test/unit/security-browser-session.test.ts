import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';

function protector() {
  const key = randomBytes(32);
  return {
    id: 'test-aes-gcm-browser-session',
    ensureDirectory(path: string) {
      mkdirSync(path, { recursive: true });
    },
    protect(bytes: Uint8Array, purpose: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(purpose));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    },
    unprotect(value: string, purpose: string): Buffer {
      const bytes = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      decipher.setAAD(Buffer.from(purpose));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    },
  };
}

it('one-time browser pairing mints, rotates and revokes short sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-browser-session-'));
  let now = Date.parse('2026-10-20T12:00:00Z');
  const registry = SecurityRegistry.open(join(root, 'security'), { protector: protector(), now: () => now });
  try {
    const principal = registry.createPrincipal('designer', 'operator');
    const credential = registry.createCredential(principal.id, 'designer browser', [
      { database: 'graph', resource: '*', actions: ['model.read'] },
    ]);
    const origin = 'http://127.0.0.1:5175';
    const pairing = registry.createPairingForCredential(credential.credential.id, 5, origin);
    assert.match(pairing.code, /^mdbp_v1_/);
    assert.throws(() => registry.consumePairing(pairing.code, 'http://localhost:5175'), { code: 'SECURITY_ORIGIN_DENIED' });
    const session = registry.consumePairing(pairing.code, origin, 30);
    assert.match(session.session, /^mdbs_v1_/);
    assert.equal(registry.verifySession(session.session).credential.id, credential.credential.id);
    assert.throws(() => registry.consumePairing(pairing.code, origin), { code: 'SECURITY_CREDENTIAL_REVOKED' });
    const verified = registry.verifyBrowserSession(session.session, origin);
    assert.equal(verified.sessionExpiresAt, new Date(now + 30 * 60000).toISOString());
    assert.equal(verified.absoluteExpiresAt, new Date(now + 8 * 3600000).toISOString());
    assert.throws(() => registry.verifyBrowserSession(session.session, origin, 'forged'), { code: 'SECURITY_CSRF_REQUIRED' });
    assert.throws(() => registry.verifyBrowserSession(session.session, 'https://other.example'), { code: 'SECURITY_ORIGIN_DENIED' });

    const rotated = registry.rotateSession(session.session, 30);
    assert.throws(() => registry.verifyBrowserSession(rotated.session, origin, verified.csrf), { code: 'SECURITY_CSRF_REQUIRED' });
    assert.throws(() => registry.verifySession(session.session), { code: 'SECURITY_CREDENTIAL_REVOKED' });
    assert.equal(registry.verifySession(rotated.session).credential.id, credential.credential.id);
    registry.revokeSession(rotated.session);
    assert.throws(() => registry.verifySession(rotated.session), { code: 'SECURITY_CREDENTIAL_REVOKED' });

    const expired = registry.createPairingForCredential(credential.credential.id, 1, origin);
    now += 60_001;
    assert.throws(() => registry.consumePairing(expired.code, origin), { code: 'SECURITY_CREDENTIAL_EXPIRED' });

    const absolute = registry.consumePairing(registry.createPairingForCredential(credential.credential.id, 5, origin).code, origin);
    let active = absolute;
    for (let i = 0; i < 16; i++) {
      now += 29 * 60000;
      active = registry.rotateSession(active.session);
    }
    assert.equal(active.expiresAt, registry.verifyBrowserSession(active.session, origin).absoluteExpiresAt);
    now = Date.parse(active.expiresAt);
    assert.throws(() => registry.rotateSession(active.session), { code: 'SECURITY_CREDENTIAL_EXPIRED' });
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('security-admin pairing has no database grants and exposes only secret-free metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-security-admin-session-'));
  const registry = SecurityRegistry.open(join(root, 'security'), { protector: protector() });
  try {
    const origin = 'http://127.0.0.1:5175';
    const adminPairing = registry.createLocalBrowserPairing(origin, [], true);
    const adminSession = registry.consumePairing(adminPairing.code, origin);
    const verified = registry.verifyBrowserSession(adminSession.session, origin);
    assert.equal(verified.securityAdmin, true);
    assert.deepEqual(verified.credential.grants, []);

    const rotated = registry.rotateSession(adminSession.session);
    assert.equal(registry.verifyBrowserSession(rotated.session, origin).securityAdmin, true);

    const ordinary = registry.createLocalBrowserPairing(origin, ['graph']);
    const ordinarySession = registry.consumePairing(ordinary.code, origin);
    assert.notEqual(registry.verifyBrowserSession(ordinarySession.session, origin).securityAdmin, true);

    const snapshot = JSON.stringify(registry.securityCenterSnapshot());
    for (const secret of [adminPairing.code, adminSession.session, rotated.session, ordinarySession.session])
      assert.equal(snapshot.includes(secret), false);
    assert.equal(snapshot.includes('secretHash'), false);
    assert.equal(snapshot.includes('instance.key'), false);
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

