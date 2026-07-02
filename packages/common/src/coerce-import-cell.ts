/**
 * Coerces ingest / lookup values toward a catalog {@link DataType} before persistence or peer matching.
 * Shared by import staging (`@mode-db/data-kit`) and server-side `bindImportLookup`.
 */

/**
 * Coerces one cell toward the target schema type.
 * Unmapped types are left unchanged.
 */
export function coerceImportCell(value: unknown, dataType: string | undefined): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (value === '') {
    return value;
  }

  const dt = (dataType ?? 'String').trim();

  switch (dt) {
    case 'String':
      if (typeof value === 'string') {
        return value;
      }
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
      }
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }
      return String(value);

    case 'I18N':
      if (typeof value === 'string') {
        return value;
      }
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value;
      }
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }
      return String(value);

    case 'Int': {
      if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
      }
      if (typeof value === 'number') {
        return Math.trunc(value);
      }
      const n = Number(String(value).trim());
      return Number.isNaN(n) ? value : Math.trunc(n);
    }

    case 'Number': {
      if (typeof value === 'number' && !Number.isNaN(value)) {
        return value;
      }
      const n = Number(String(value).trim());
      return Number.isNaN(n) ? value : n;
    }

    case 'Boolean': {
      if (typeof value === 'boolean') {
        return value;
      }
      const s = String(value).trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') {
        return true;
      }
      if (s === 'false' || s === '0' || s === 'no') {
        return false;
      }
      return value;
    }

    case 'JSON':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return value;
        }
      }
      return value;

    case 'DateTime':
      if (typeof value === 'string') {
        return value.trim();
      }
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
      }
      return value;

    default:
      return value;
  }
}

/**
 * Canonical lookup key after coercing toward `peerMatchFieldType` (import bind-only peer match).
 */
export function importLookupCanonicalKey(
  value: unknown,
  peerMatchFieldType: string | undefined,
): string | null {
  const coerced = coerceImportCell(value, peerMatchFieldType);
  if (coerced === null || coerced === undefined || coerced === '') {
    return null;
  }
  if (typeof coerced === 'string') {
    const trimmed = coerced.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof coerced === 'number' && Number.isFinite(coerced)) {
    return String(coerced);
  }
  if (typeof coerced === 'boolean') {
    return coerced ? 'true' : 'false';
  }
  return String(coerced);
}
