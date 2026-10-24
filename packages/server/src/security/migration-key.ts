import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  type KeyObject,
} from 'node:crypto';
import { backupRecipientId } from './backup-package.js';
import { SecurityError } from './security-errors.js';

const FORMAT = 'modeldb.migration-key.v1';
const SIGNING_FORMAT = 'modeldb.asset-signing-key.v1';
function phrase(value: string): void {
  if (value.length < 12 || value.length > 1024) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
}
/** Password-protected PKCS8 with fixed scrypt and authenticated recipient identity. */
export function createMigrationKey(passphrase: string): {
  recipientId: string;
  publicKey: string;
  privateKey: Buffer;
} {
  return createProtectedKey(passphrase, FORMAT);
}
export function createAssetSigningKey(passphrase: string): ReturnType<typeof createMigrationKey> {
  return createProtectedKey(passphrase, SIGNING_FORMAT);
}
function createProtectedKey(
  passphrase: string,
  format: string,
): ReturnType<typeof createMigrationKey> {
  phrase(passphrase);
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const recipientId = backupRecipientId(pair.publicKey),
    salt = randomBytes(16),
    iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(format + ':' + recipientId));
    const ciphertext = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
    return {
      recipientId,
      publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey: Buffer.from(
        JSON.stringify({
          format,
          recipientId,
          kdf: 'scrypt',
          N: 16384,
          r: 8,
          p: 1,
          salt: salt.toString('base64url'),
          iv: iv.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
          ciphertext: ciphertext.toString('base64url'),
        }),
      ),
    };
  } finally {
    key.fill(0);
    pkcs8.fill(0);
  }
}
export function openMigrationKey(bytes: Buffer, passphrase: string): KeyObject {
  return openProtectedKey(bytes, passphrase, FORMAT);
}
export function openAssetSigningKey(bytes: Buffer, passphrase: string): KeyObject {
  return openProtectedKey(bytes, passphrase, SIGNING_FORMAT);
}
function openProtectedKey(bytes: Buffer, passphrase: string, format: string): KeyObject {
  phrase(passphrase);
  let key: Buffer | undefined, plain: Buffer | undefined;
  try {
    if (bytes.length > 16384) {
      throw new Error();
    }
    const object = JSON.parse(bytes.toString('utf8'));
    const fields = [
      'format',
      'recipientId',
      'kdf',
      'N',
      'r',
      'p',
      'salt',
      'iv',
      'tag',
      'ciphertext',
    ];
    if (
      !object ||
      Object.keys(object).length !== fields.length ||
      fields.some((field) => !(field in object)) ||
      object.format !== format ||
      object.kdf !== 'scrypt' ||
      object.N !== 16384 ||
      object.r !== 8 ||
      object.p !== 1 ||
      !/^[a-f0-9]{64}$/.test(object.recipientId)
    ) {
      throw new Error();
    }
    const decode = (value: unknown, length?: number): Buffer => {
      if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error();
      }
      const decoded = Buffer.from(value, 'base64url');
      if (
        decoded.toString('base64url') !== value ||
        (length !== undefined && decoded.length !== length)
      ) {
        throw new Error();
      }
      return decoded;
    };
    key = scryptSync(passphrase, decode(object.salt, 16), 32, { N: 16384, r: 8, p: 1 });
    const cipher = createDecipheriv('aes-256-gcm', key, decode(object.iv, 12));
    cipher.setAAD(Buffer.from(format + ':' + object.recipientId));
    cipher.setAuthTag(decode(object.tag, 16));
    plain = Buffer.concat([cipher.update(decode(object.ciphertext)), cipher.final()]);
    const privateKey = createPrivateKey({ key: plain, type: 'pkcs8', format: 'der' });
    if (backupRecipientId(privateKey) !== object.recipientId) {
      throw new Error();
    }
    return privateKey;
  } catch {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  } finally {
    key?.fill(0);
    plain?.fill(0);
  }
}
