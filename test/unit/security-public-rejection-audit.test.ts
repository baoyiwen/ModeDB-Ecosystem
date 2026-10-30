import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { test } from 'node:test';
import { integrationFixture } from '../fixtures/security-registration-integration.js';
import { MAX_PUBLIC_REJECTION_AUDITS } from '../../packages/server/src/security/public-rejection-audit.js';
import { AuthenticationService } from '../../packages/server/src/security/authentication-service.js';
const context = {
  source: {
    peerIp: '127.0.0.1',
    clientIp: '127.0.0.1',
    clientIpBasis: 'socket' as const,
    secure: true,
  },
  requestId: 'synthetic-rejection-audit',
  recheck() {},
};
const count = (f: Awaited<ReturnType<typeof integrationFixture>>) =>
  f.registry
    .auditEvents()
    .filter((e) => e.action === 'authentication.reject')
    .reduce((sum, e) => sum + (e.aggregation?.observedCount ?? 1), 0);

test('rejection waits for durable audit, yields for local maintenance and preserves every aggregation count', async () => {
  const f = await integrationFixture();
  try {
    const requests = Array.from({ length: 16 }, () =>
      f.service.deny(context, 'SECURITY_REGISTRATION_RATE_LIMITED'),
    );
    assert.equal(count(f), 0);
    await turn();
    const observed = count(f);
    assert.ok(observed >= 1 && observed < 16, 'Local work must run between durable writes');
    f.local({ action: 'principal.create', name: 'Synthetic interleaved repair', kind: 'operator' });
    await Promise.all(requests);
    assert.equal(count(f), 16);
  } finally {
    await f.stop();
  }
});
test('one instance has a bounded queue and overflow rejects without claiming persistence', async () => {
  const f = await integrationFixture(),
    auth = new AuthenticationService(
      f.registry,
      { enabled: true, allowStorageMigration: true },
      f.descriptor,
      () => f.now,
    );
  try {
    const requests = Array.from({ length: MAX_PUBLIC_REJECTION_AUDITS }, () =>
      f.service.deny(context, 'SECURITY_REGISTRATION_RATE_LIMITED'),
    );
    await assert.rejects(f.service.deny(context, 'SECURITY_REGISTRATION_RATE_LIMITED'), {
      code: 'SECURITY_AUDIT_CAPACITY',
    });
    await assert.rejects(auth.deny(context, 'SECURITY_AUTHENTICATION_RATE_LIMITED'), {
      code: 'SECURITY_AUDIT_CAPACITY',
    });
    await Promise.all(requests);
    assert.equal(count(f), MAX_PUBLIC_REJECTION_AUDITS);
  } finally {
    auth.close();
    await f.stop();
  }
});
test('protection failure closes the registry; explicit reopen preserves failure and permits new audited work', async () => {
  const f = await integrationFixture();
  try {
    f.fail(true);
    await assert.rejects(f.service.deny(context, 'SECURITY_REGISTRATION_RATE_LIMITED'));
    await assert.rejects(
      async () => f.service.deny(context, 'SECURITY_REGISTRATION_RATE_LIMITED'),
      { code: 'SECURITY_CLOSED' },
    );
    f.fail(false);
    await f.reopen();
    assert.equal(count(f), 0);
    await f.service.deny(context, 'SECURITY_REGISTRATION_RATE_LIMITED');
    assert.equal(count(f), 1);
  } finally {
    await f.stop();
  }
});
test('closing the registry rejects queued writes instead of returning unaudited success', async () => {
  const f = await integrationFixture();
  try {
    const pending = f.service.deny(context, 'SECURITY_REGISTRATION_RATE_LIMITED');
    f.registry.close();
    await assert.rejects(pending, { code: 'SECURITY_CLOSED' });
  } finally {
    await f.stop();
  }
});
