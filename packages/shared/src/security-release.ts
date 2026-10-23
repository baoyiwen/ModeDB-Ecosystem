import { sha256 } from '@noble/hashes/sha256';

/** Pin execution, projection, policy and dependency versions of a complete release. */
export function securityReleaseDigest(release: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(canonical(release)))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
