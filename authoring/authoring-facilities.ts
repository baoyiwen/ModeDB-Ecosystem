import type { InternalVault } from '../common/internal-vault.js';
import type { SmartCache } from '../common/smart-cache.js';

/** Optional hooks passed from {@link AuthoringEngine} into {@link AtlasRegistry} / {@link ModelEntity}. */
export interface AtlasAuthoringFacilities {
  readonly internalVault?: InternalVault;
  readonly memoryShadowHydration?: boolean;
  readonly smartCache?: SmartCache;
}
