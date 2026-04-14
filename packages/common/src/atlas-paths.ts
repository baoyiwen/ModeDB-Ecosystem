/**
 * Atlas path helpers and storage-root defaults (see {@link PathResolver} in `./PathResolver.js`).
 */
export {
  PathResolver,
  type PathResolverOptions,
  PathResolver as AtlasPathResolver,
} from './PathResolver.js';
export { assertFlatGraphSegment, assertRelationIndexKey } from './atlas-segments.js';
export { DEFAULT_STORAGE_ROOT, STORAGE_ROOT } from './default-storage-root.js';
