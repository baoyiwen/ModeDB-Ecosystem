let fallbackSequence = 0;

function fillFallbackBytes(bytes: Uint8Array): void {
  fallbackSequence = (fallbackSequence + 1) >>> 0;
  let seed = (Date.now() ^ fallbackSequence) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    bytes[index] = (seed >>> 24) ^ Math.floor(Math.random() * 256);
  }
}

/** Browser-compatible UUID v4 generator with fallbacks for older WebViews. */
export function createUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // Some embedded browsers expose the method but reject it outside a secure context.
    }
  }

  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    try {
      cryptoApi.getRandomValues(bytes);
    } catch {
      fillFallbackBytes(bytes);
    }
  } else {
    fillFallbackBytes(bytes);
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
