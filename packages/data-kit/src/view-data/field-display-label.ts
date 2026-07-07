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

/** Formats a localized display name together with its stable unique name. */
export function formatDisplayWithUnique(
  uniqueName: string,
  displayName: string | undefined,
): string {
  const label = displayName?.trim();
  return label && label !== uniqueName ? `${label}[${uniqueName}]` : uniqueName;
}

/** Stable field formatter used by table, pivot, and import UIs. */
export function formatFieldDisplayLabel(
  fieldLabels: FieldLabelMap | undefined,
  fieldName: string,
  locale: string,
  useDisplayName = true,
): string {
  if (!useDisplayName) {
    return fieldName;
  }
  return formatDisplayWithUnique(
    fieldName,
    fieldDisplayNameForLocale(fieldLabels, fieldName, locale),
  );
}

/** Builds column labels for every known field label plus the supplied field order. */
export function buildFieldColumnLabels(
  fields: readonly string[],
  fieldLabels: FieldLabelMap | undefined,
  locale: string,
  useDisplayName = true,
): Readonly<Record<string, string>> | undefined {
  if (!useDisplayName) {
    return undefined;
  }
  const keys = [...new Set([...fields, ...Object.keys(fieldLabels ?? {})])];
  const out: Record<string, string> = {};
  for (const field of keys) {
    const display = fieldDisplayNameForLocale(fieldLabels, field, locale);
    if (display) {
      out[field] = formatDisplayWithUnique(field, display);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Formats a field option as `name (display)` when a display name exists. */
export function formatFieldOptionLabel(fieldName: string, displayName: string | undefined): string {
  if (displayName) {
    return `${fieldName} (${displayName})`;
  }
  return fieldName;
}
