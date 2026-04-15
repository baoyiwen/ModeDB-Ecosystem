import { AtlasIsolationError } from './errors.js';

const MAX_SEGMENT_LEN = 128;
const MAX_RELATION_KEY_LEN = 512;

/**
 * Reject path injection in atlas / model / relation labels used in file names.
 */
export function assertFlatGraphSegment(value: string, role: string): void {
  if (value.length === 0 || value.length > MAX_SEGMENT_LEN) {
    throw new AtlasIsolationError(
      `Invalid ${role}: must be non-empty and at most ${MAX_SEGMENT_LEN} characters.`,
    );
  }
  if (value.includes('\0') || value.includes('/') || value.includes('\\')) {
    throw new AtlasIsolationError(
      `Invalid ${role} "${value}": path separators and null bytes are not allowed.`,
    );
  }
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new AtlasIsolationError(`Invalid ${role} "${value}": "." and ".." are not allowed.`);
  }
}

export function assertRelationIndexKey(value: string): void {
  if (value.length === 0 || value.length > MAX_RELATION_KEY_LEN) {
    throw new AtlasIsolationError('Invalid relation index key: bad length.');
  }
  if (value.includes('\0') || value.includes('/') || value.includes('\\')) {
    throw new AtlasIsolationError('Invalid relation index key: path separators are not allowed.');
  }
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new AtlasIsolationError('Invalid relation index key: path traversal is not allowed.');
  }
}
