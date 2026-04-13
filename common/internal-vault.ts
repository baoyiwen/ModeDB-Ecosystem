import { randomUUID } from 'node:crypto';

export const VAULT_ADDR_PREFIX = 'm_addr_';

/**
 * In-memory slot map for pointerized {@link HydratedEntity} rows: addresses hide raw field
 * payloads until {@link HydratedEntity.getValue} resolves them.
 */
export class InternalVault {
  private readonly slots = new Map<string, unknown>();

  /** Store a decoded field value; returns a stable pointer string. */
  put(value: unknown): string {
    const addr = `${VAULT_ADDR_PREFIX}${randomUUID()}`;
    this.slots.set(addr, value);
    return addr;
  }

  resolve(addr: string): unknown {
    return this.slots.get(addr);
  }

  static isVaultPointer(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(VAULT_ADDR_PREFIX);
  }

  /** Drop all slots (e.g. when tearing down an engine instance). */
  clear(): void {
    this.slots.clear();
  }
}
