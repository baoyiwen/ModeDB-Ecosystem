import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from '../fixtures/security-recipient-delivery.js';
import { SID } from '../fixtures/security-registration-integration.js';
import { parseRecipientDelivery, recipientDeliverySelection } from '../../packages/server/src/security/recipient-delivery.js';
import { selectCliExportRecipient } from '../../packages/server/src/cli-recipient-delivery.js';
import { runBackupSecurityCli } from '../../packages/server/src/cli-backup-security.js';
import { runAssetCli } from '../../packages/server/src/cli-asset.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { backupRecipientId } from '../../packages/server/src/security/backup-package.js';

test('delivery requires exact verified owner, instance, version, fingerprint, confirmation and CAS', async () => {
  const x = await deliveryFixture(); try {
    assert.equal(backupRecipientId(x.select().key), x.recipient.fingerprint);
    assert.throws(() => x.f.registry.selectDeliveryRecipient(x.selection()), { code: 'SECURITY_LOCAL_IDENTITY_DENIED' });
    for (const extra of [{ instanceId: randomUUID() }, { id: randomUUID() }, { userId: randomUUID() }, { keyVersion: 2 }, { fingerprint: '0'.repeat(64) }, { confirm: false }, { revision: x.selection().revision - 1 }, { publicKey: 'forged' }]) assert.throws(() => x.select(extra));
    const stale = x.selection(); x.call('list');
    assert.throws(() => x.f.registry.withLocalActor(SID, () => x.f.registry.selectDeliveryRecipient(stale)), { code: 'SECURITY_POLICY_CONFLICT' });
    assert.equal(x.select().recipient.userId, x.userId);
  } finally { await x.f.stop(); }
});

for (const [action, field] of [['registration.user.disable', 'userId'], ['registration.credential.disable', 'credentialId'], ['registration.credential.revoke', 'credentialId']] as const) test('new delivery rejects ' + action + ' while preserving recipient history', async () => {
  const x = await deliveryFixture(); try {
    x.maintain(action, x[field]); assert.throws(() => x.select(), { code: 'SECURITY_FORBIDDEN' });
    const page = x.call('list') as { keys: { state: string }[] }; assert.equal(page.keys[0].state, 'active');
    await x.f.reopen(); assert.throws(() => x.select(), { code: 'SECURITY_FORBIDDEN' });
  } finally { await x.f.stop(); }
});

test('retired and replaced recipients cannot receive new packages; historical private keys stay independent', async () => {
  const x = await deliveryFixture(); try {
    x.associate(generateKeyPairSync('rsa', { modulusLength: 3072 }));
    assert.throws(() => x.select(), { code: 'SECURITY_FORBIDDEN' });
    assert.equal((x.call('list') as { keys: unknown[] }).keys.length, 2);
  } finally { await x.f.stop(); }
});

test('sealed delivery audit binds recipient and ciphertext hash, with no keys, proof or body', async () => {
  const x = await deliveryFixture(); try {
    x.f.registry.withLocalActor(SID, () => x.f.registry.recordSealedRecipientDelivery(x.selection(), '合成库', 'asset', 'a'.repeat(64)));
    await x.f.reopen(); const event = x.f.registry.auditEvents().find(e => e.action === 'recipient.delivery.sealed')!;
    assert.equal(event.actor.principalId, SID); assert.equal(event.resource?.database, '合成库');
    assert.deepEqual(event.delivery, { recipientKeyId: x.recipient.id, userId: x.userId, keyVersion: 1, fingerprint: x.recipient.fingerprint, packageSha256: 'a'.repeat(64), kind: 'asset' });
    assert.doesNotMatch(JSON.stringify(event), /BEGIN PUBLIC KEY|private|proof|ciphertext|passphrase/);
    assert.throws(() => x.f.registry.withLocalActor(SID, () => x.f.registry.recordSealedRecipientDelivery(x.selection(), 'graph', 'asset', 'bad')));
  } finally { await x.f.stop(); }
});

for (const operation of ['retire', 'access-reset'] as const) test(operation + ' permanently blocks new delivery without deleting recipient history', async () => {
  const x = await deliveryFixture(); try {
    if (operation === 'retire') x.call('retire', { id: x.recipient.id });
    else x.f.registry.resetAccess();
    assert.throws(() => x.select(), { code: 'SECURITY_FORBIDDEN' });
    assert.equal((x.call('list') as { keys: { state: string }[] }).keys[0].state, 'retired');
    await x.f.reopen();
    assert.throws(() => x.select(), { code: 'SECURITY_FORBIDDEN' });
  } finally { await x.f.stop(); }
});

for (const point of ['staged', 'journaled', 'replaced'] as const) test('sealed audit at ' + point + ' never falsely reports success and recovers exact metadata', async () => {
  let fail = false; const x = await deliveryFixture(undefined, at => { if (fail && at === point) throw Error('synthetic'); });
  try {
    fail = true;
    assert.throws(() => x.f.registry.withLocalActor(SID, () => x.f.registry.recordSealedRecipientDelivery(x.selection(), 'graph', 'backup', 'b'.repeat(64))), { code: 'SECURITY_STORE_WRITE_FAILED' });
    await x.f.reopen(); assert.equal(x.f.registry.auditEvents().some(e => e.delivery?.packageSha256 === 'b'.repeat(64)), point !== 'staged');
    assert.equal(x.select().recipient.fingerprint, x.recipient.fingerprint);
  } finally { await x.f.stop(); }
});

test('audit capacity refuses sealing before external publication', async () => {
  const x = await deliveryFixture(); try {
    const registry = x.f.registry as unknown as { auditLimit: number }; const old = registry.auditLimit; registry.auditLimit = x.f.registry.auditEvents().length;
    assert.throws(() => x.f.registry.withLocalActor(SID, () => x.f.registry.recordSealedRecipientDelivery(x.selection(), 'graph', 'backup', 'c'.repeat(64))), { code: 'SECURITY_AUDIT_CAPACITY' });
    registry.auditLimit = old; assert.ok(!x.f.registry.auditEvents().some(e => e.delivery));
  } finally { await x.f.stop(); }
});

test('CLI selection forbids incomplete, mixed or forged selectors and raw PEM fallback in V5', async () => {
  const x = await deliveryFixture(); try {
    const options = new Map<string,string>([['--recipient-id',x.recipient.id],['--recipient-user',x.userId],['--recipient-version','1'],['--recipient-fingerprint',x.recipient.fingerprint],['--revision',String(x.selection().revision)]]);
    assert.deepEqual(recipientDeliverySelection(options,x.f.instanceId,true),x.selection());
    for (const key of options.keys()) { const bad = new Map(options); bad.delete(key); assert.throws(() => recipientDeliverySelection(bad,x.f.instanceId,true)); }
    for (const value of ['1e0','01','1.0','+1','1\n','Infinity']) { const bad=new Map(options);bad.set('--revision',value);assert.throws(()=>recipientDeliverySelection(bad,x.f.instanceId,true)); }
    const mixed=new Map(options);mixed.set('--public-key','ignored.pem');assert.throws(()=>recipientDeliverySelection(mixed,x.f.instanceId,true));
    const path=join(x.f.root,'public.pem');writeFileSync(path,x.pair.publicKey.export({type:'spki',format:'pem'}));
    assert.throws(()=>selectCliExportRecipient(x.f.registry,new Map([['--public-key',path]]),x.f.instanceId,true,new WindowsSecretProtector()),{code:'SECURITY_FORBIDDEN'});
    assert.throws(()=>parseRecipientDelivery({...x.selection(),fingerprint:x.recipient.fingerprint+'\n'}));
  } finally { await x.f.stop(); }
});

test('private key/import options cannot be smuggled into export or recipient selectors into import', async () => {
  for (const args of [['backup-export','--private-key','never-read'],['backup-import','--recipient-id','never-read'],['backup-key-create','--config','never-read'],['backup-key-create','--yes']]) await assert.rejects(() => runBackupSecurityCli(args), {code:'SECURITY_INVALID_REQUEST'});
  await assert.rejects(() => runAssetCli(['asset-import','--recipient-id','never-read']), {code:'SECURITY_INVALID_REQUEST'});
});
