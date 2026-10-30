/** Offline export selection. No local IPC/HTTP command exposes recipient PEM or accepts private keys. */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { readBackupBytes } from './backup-manager.js';
import {
  recipientDeliverySelection,
  type RecipientDeliverySelection,
  type RecipientDeliveryInfo,
} from './security/recipient-delivery.js';
import type { SecurityRegistry } from './security/security-registry.js';
import { SecurityError } from './security/security-errors.js';
import type { WindowsSecretProtector } from './security/windows-secret-protector.js';

export function selectCliExportRecipient(
  registry: SecurityRegistry,
  options: ReadonlyMap<string, string>,
  instanceId: string,
  confirm: boolean,
  protector: WindowsSecretProtector,
):
  | { key: KeyObject; selection?: undefined; recipient?: undefined; sid?: undefined }
  | {
      key: KeyObject;
      selection: RecipientDeliverySelection;
      recipient: RecipientDeliveryInfo;
      sid: string;
    } {
  const selection = recipientDeliverySelection(options, instanceId, confirm);
  if (selection) {
    const sid = protector.currentIdentity();
    const selected = registry.withLocalActor(sid, () =>
      registry.selectDeliveryRecipient(selection),
    );
    return { ...selected, selection, sid };
  }
  // Once V5 is explicitly enabled, every export must use a verified active recipient.
  if (registry.registrationStorageStatus().ledgerVersion >= 5 || !options.get('--public-key')) {
    throw new SecurityError('SECURITY_FORBIDDEN');
  }
  return { key: createPublicKey(readBackupBytes(options.get('--public-key')!, 8192)) };
}
