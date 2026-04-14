import { statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Fingerprint atlas catalog inputs so we can drop stale **`ModelDBClient`** / **`AuthoringEngine`**
 * caches after **`atlas.mld`** changes on disk.
 */
export function atlasCatalogSignature(storageRoot: string, atlas: string): string {
  const vault = join(storageRoot, atlas, 'atlas.mld');
  const part = (path: string): string => {
    try {
      return `${basename(path)}:${statSync(path).mtimeMs}`;
    } catch {
      return `${basename(path)}:missing`;
    }
  };
  return part(vault);
}
