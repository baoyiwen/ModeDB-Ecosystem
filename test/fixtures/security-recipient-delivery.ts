/** Generated registration and recipient materials only; never opens a user instance. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { integrationFixture, syntheticProof, SID } from './security-registration-integration.js';
import { DEVICE_REGISTRATION_API_V1 as API } from '../../packages/shared/src/device-registration-contracts.js';
import type { RecipientChallenge, RecipientKeyPage } from '../../packages/shared/src/recipient-keys.js';
import { answerRecipientChallenge } from '../../packages/server/src/security/recipient-keys.js';
import type { RecipientDeliverySelection } from '../../packages/server/src/security/recipient-delivery.js';

export async function deliveryFixture(protector?: Parameters<typeof integrationFixture>[2], onPoint?: Parameters<typeof integrationFixture>[1]) {
  const f = await integrationFixture(undefined, onPoint, protector);
  f.registry.migrateAuthenticationStorage(f.registry.status().revision);
  const b = await f.begin();
  assert.equal((await f.post(API.complete, syntheticProof(f.instanceId, b))).statusCode, 202);
  const approved = f.local(f.decision(b.registrationId)) as { userId: string; credentialId: string; principalId: string };
  const call = (action: string, extra: Record<string, unknown> = {}) => f.local({
    action: 'registration.recipient.' + action, instanceId: f.instanceId,
    ...(action === 'list' ? {} : { revision: f.registry.status().revision, confirm: true }), ...extra,
  });
  call('initialize');
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const associate = (keys = pair) => {
    const response = call('begin', { userId: approved.userId, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }) as { challenge: RecipientChallenge };
    call('complete', { response: answerRecipientChallenge(response.challenge, keys.privateKey, f.now) });
    return (call('list') as RecipientKeyPage).keys.at(-1)!;
  };
  const recipient = associate();
  const selection = (): RecipientDeliverySelection => ({ instanceId: f.instanceId, revision: f.registry.status().revision, id: recipient.id, userId: approved.userId, keyVersion: recipient.keyVersion, fingerprint: recipient.fingerprint, confirm: true });
  const select = (extra: Record<string, unknown> = {}) => f.registry.withLocalActor(SID, () => f.registry.selectDeliveryRecipient({ ...selection(), ...extra }));
  const maintain = (action: string, id: string) => f.local({ action, instanceId: f.instanceId, id, revision: f.registry.status().revision, confirm: true });
  return { f, pair, recipient, ...approved, call, selection, select, associate, maintain };
}
