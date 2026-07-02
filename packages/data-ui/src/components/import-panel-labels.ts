import type { FieldLabelMap, IngestAmbiguity } from '@mode-db/data-kit';
import { fieldDisplayNameForLocale, formatFieldOptionLabel } from '@mode-db/data-kit';

/** User-visible strings for {@link ImportPanel} (supplied by the host app). */
export interface ImportPanelLabels {
  readonly csvFile: string;
  readonly targetModel: string;
  readonly loadedSummary: string;
  readonly mappingNotes: string;
  readonly columnMapping: string;
  readonly csvColumn: string;
  readonly modelField: string;
  readonly skipColumn: string;
  readonly selectOption: string;
  readonly relationBindings: string;
  readonly relationHint: string;
  readonly relationEmpty: string;
  readonly relation: string;
  readonly relatedModel: string;
  readonly matchField: string;
  readonly remove: string;
  readonly addRelationBinding: string;
  readonly previewTitle: string;
  readonly stageImport: string;
  readonly working: string;
  readonly pendingOps: string;
  readonly selectFileFirst: string;
  readonly stagedSummary: string;
  readonly stagedSummaryBind: string;
  readonly stagedSkipped: string;
  readonly noRowsToImport: string;
  readonly ambiguityMultipleFields: string;
  readonly ambiguityUnmappedColumn: string;
  readonly ambiguityRequiredField: string;
  readonly candidatesPrefix: string;
  readonly failureTitle: string;
  readonly failureSummary: string;
  readonly failureRowNumber: string;
  readonly failureReasons: string;
  readonly failureRetryCommit: string;
  readonly failurePartialSuccess: string;
}

/** Resolves an auto-map ambiguity to a localized message. */
export function formatImportAmbiguity(
  ambiguity: IngestAmbiguity,
  labels: ImportPanelLabels,
  formatField: (fieldName: string) => string,
): string {
  if (
    ambiguity.kind === 'column_mapping' &&
    ambiguity.candidates &&
    ambiguity.candidates.length > 1 &&
    ambiguity.column
  ) {
    const candidates = ambiguity.candidates.map(formatField).join(', ');
    return labels.ambiguityMultipleFields
      .replace('{{column}}', ambiguity.column)
      .replace('{{candidates}}', candidates);
  }

  if (ambiguity.kind === 'column_mapping' && ambiguity.column) {
    return labels.ambiguityUnmappedColumn.replace('{{column}}', ambiguity.column);
  }

  if (ambiguity.kind === 'required_field') {
    const field = ambiguity.id.replace(/^required-/, '');
    return labels.ambiguityRequiredField.replace('{{field}}', formatField(field));
  }

  return ambiguity.message;
}

/** Builds a field label formatter using optional catalog i18n labels. */
export function createFieldLabelFormatter(
  fieldLabels: FieldLabelMap | undefined,
  locale: string,
): (fieldName: string) => string {
  return (fieldName: string): string => {
    const display = fieldDisplayNameForLocale(fieldLabels, fieldName, locale);
    return formatFieldOptionLabel(fieldName, display);
  };
}
