/** Stable, non-secret identity authenticated by the Vault format. */
export interface VaultKeyReference {
  readonly instanceId: string;
  readonly databaseId: string;
  readonly keyId: string;
  readonly keyVersion: number;
}

/** A random 256-bit DEK. Never serialize this object or include it in diagnostics. */
export interface VaultKeyMaterial {
  readonly reference: VaultKeyReference;
  readonly key: Uint8Array;
}

/** Local engine dependency, deliberately independent of network authentication. */
export interface VaultKeyProvider {
  /** Resolve an existing reference, or provision a key only for a genuinely new Vault. */
  resolveKey(atlas: string, existing?: VaultKeyReference): VaultKeyMaterial;
}

/** Public codes contain no paths, keys, OS messages or business values. */
export type VaultSecurityErrorCode =
  | 'VAULT_KEY_REQUIRED'
  | 'VAULT_KEY_UNAVAILABLE'
  | 'VAULT_KEY_MISMATCH'
  | 'VAULT_LEGACY_FORMAT'
  | 'VAULT_FORMAT_INVALID'
  | 'VAULT_AUTHENTICATION_FAILED'
  | 'VAULT_COMMIT_INCOMPLETE'
  | 'VAULT_COMMIT_CONFLICT'
  | 'VAULT_WRITE_FAILED'
  | 'VAULT_PROTECTION_UNAVAILABLE';

/** Fail-closed security error; the underlying OS error is not exposed to callers. */
export class VaultSecurityError extends Error {
  constructor(readonly code: VaultSecurityErrorCode) {
    super(code);
    this.name = 'VaultSecurityError';
  }
}

/** Validate an untrusted, non-secret key reference without coercion. */
export function isVaultKeyReference(value: unknown): value is VaultKeyReference {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const ref = value as Record<string, unknown>;
  return (
    ['instanceId', 'databaseId', 'keyId'].every(
      (field) => typeof ref[field] === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(ref[field]),
    ) &&
    Number.isSafeInteger(ref.keyVersion) &&
    (ref.keyVersion as number) > 0
  );
}

/** Stable AAD shared by the envelope and Vault implementations. */
export function vaultKeyReferenceAAD(ref: VaultKeyReference): string {
  if (!isVaultKeyReference(ref)) {
    throw new VaultSecurityError('VAULT_KEY_MISMATCH');
  }
  return JSON.stringify([ref.instanceId, ref.databaseId, ref.keyId, ref.keyVersion]);
}

/** Check identity and key length before handing material to a cipher. */
export function assertVaultKeyMaterial(material: VaultKeyMaterial): void {
  if (
    !material ||
    !isVaultKeyReference(material.reference) ||
    !(material.key instanceof Uint8Array) ||
    material.key.byteLength !== 32
  ) {
    throw new VaultSecurityError('VAULT_KEY_REQUIRED');
  }
}
