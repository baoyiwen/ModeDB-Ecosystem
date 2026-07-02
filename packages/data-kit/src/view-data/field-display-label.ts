/** Localized display label for a catalog field (locale code → label). */
export type FieldLabelMap = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Returns the display name for a field in the given locale only (no cross-locale fallback).
 *
 * @returns `undefined` when the locale has no non-empty label.
 */
export function fieldDisplayNameForLocale(
  fieldLabels: FieldLabelMap | undefined,
  fieldName: string,
  locale: string,
): string | undefined {
  const label = fieldLabels?.[fieldName]?.[locale]?.trim();
  return label && label.length > 0 ? label : undefined;
}

/** Formats a field option as `name (display)` when a display name exists. */
export function formatFieldOptionLabel(fieldName: string, displayName: string | undefined): string {
  if (displayName) {
    return `${fieldName} (${displayName})`;
  }
  return fieldName;
}
