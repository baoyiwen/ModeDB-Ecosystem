import { join } from 'node:path';

/** Default STORAGE_ROOT when no env / config is set: `<cwd>/data`. */
export const DEFAULT_STORAGE_ROOT = join(process.cwd(), 'data');

/** @deprecated Prefer {@link DEFAULT_STORAGE_ROOT}; kept as an alias. */
export const STORAGE_ROOT = DEFAULT_STORAGE_ROOT;
