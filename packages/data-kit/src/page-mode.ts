/**
 * Global data-page interaction mode.
 *
 * Distinct from Model Designer schema tooling: **`delete`** removes **data rows** via
 * `delete` / `batchDelete` engine ops, not model/relation definitions.
 */
export type DataPageMode = 'view' | 'edit' | 'delete';

/** Modes that allow staging mutations into a {@link BindingSession}. */
export type DataPageMutationMode = Exclude<DataPageMode, 'view'>;

/** Whether a mode may stage engine mutations. */
export function isMutationMode(mode: DataPageMode): mode is DataPageMutationMode {
  return mode === 'edit' || mode === 'delete';
}

/** Default toolbar modes when a {@link ViewSpec} omits `allowedModes`. */
export const DEFAULT_ALLOWED_MODES: readonly DataPageMode[] = ['view', 'edit', 'delete'];

/** Returns whether `next` is permitted by the view/page configuration. */
export function canEnterMode(
  next: DataPageMode,
  allowedModes: readonly DataPageMode[] = DEFAULT_ALLOWED_MODES,
): boolean {
  return allowedModes.includes(next);
}
