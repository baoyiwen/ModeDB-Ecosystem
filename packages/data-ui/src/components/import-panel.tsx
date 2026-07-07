import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';
import type {
  ApplyBatchResult,
  CatalogModelRef,
  CatalogRelationRef,
  FieldLabelMap,
  ImportFieldTypeMap,
  IngestSchema,
  RelationBindingRule,
} from '@mode-db/data-kit';
import {
  autoMapIngestColumns,
  coerceImportRow,
  coerceInsertManyOps,
  collectImportOpsFromHandle,
  createImportProfile,
  csvIngestAdapter,
  formatDisplayWithUnique,
  mapIngestRow,
  mergeColumnMapping,
  mergeRelationBindings,
  propFieldsFromCatalogFields,
  relatedModelForImport,
  relationsForImportModel,
  suggestRelationBindings,
} from '@mode-db/data-kit';
import { useDataPage } from '../context/data-page-context.js';
import {
  createFieldLabelFormatter,
  formatImportAmbiguity,
  type ImportPanelLabels,
} from './import-panel-labels.js';
import { ImportFailurePanel } from './import-failure-panel.js';
import './import-panel.css';

const PREVIEW_ROWS = 8;

export interface ImportPanelProps {
  readonly targetModel: string;
  readonly propFields: readonly string[];
  readonly catalogRelations: readonly CatalogRelationRef[];
  readonly catalogModels: readonly CatalogModelRef[];
  readonly labels: ImportPanelLabels;
  readonly locale: string;
  /** Field name → locale → display label (current locale only is shown). */
  readonly fieldLabels?: FieldLabelMap;
  /** `display` shows localized display names when present; `name` shows stable unique names. */
  readonly nameDisplayMode?: 'display' | 'name';
  /** Target model field types for pre-submit coercion. */
  readonly fieldTypes?: ImportFieldTypeMap;
  readonly onImportCommitResult?: (result: ApplyBatchResult) => void;
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function uniqueFields(fields: readonly string[]): readonly string[] {
  return [...new Set(fields)];
}

function preferredUpsertField(fields: readonly string[]): string {
  const normalized = new Map(fields.map((field) => [field.toLowerCase(), field]));
  return normalized.get('id') ?? normalized.get('code') ?? normalized.get('key') ?? '';
}

function catalogModelFields(model: CatalogModelRef | undefined): readonly string[] {
  if (!model) {
    return [];
  }
  const fromFields = propFieldsFromCatalogFields(model.fields ?? []);
  if (fromFields.length > 0) {
    return fromFields;
  }
  return propFieldsFromCatalogFields(Object.keys(model.fieldTypes ?? {}));
}

function displayNameForLocale(
  labels: Readonly<Record<string, string>> | undefined,
  locale: string,
): string | undefined {
  const label = labels?.[locale]?.trim();
  return label && label.length > 0 ? label : undefined;
}

function relationOptionKey(relation: CatalogRelationRef): string {
  return `${relation.forward}\0${relation.source}\0${relation.target}`;
}

function relationForRule(
  rule: RelationBindingRule,
  relations: readonly CatalogRelationRef[],
  importModel: string,
): CatalogRelationRef | undefined {
  return relations.find((r) => {
    if (r.forward !== rule.relation) {
      return false;
    }
    if (r.source !== importModel && r.target !== importModel) {
      return false;
    }
    return r.source === rule.targetModel || r.target === rule.targetModel;
  });
}

function relationKeyForRule(
  rule: RelationBindingRule,
  relations: readonly CatalogRelationRef[],
  importModel: string,
): string {
  const relation = relationForRule(rule, relations, importModel);
  return relation ? relationOptionKey(relation) : rule.relation;
}

/** CSV upload, AutoMap, relation binding, preview, and batch import via DataBinding. */
export function ImportPanel(props: ImportPanelProps): ReactElement {
  const {
    targetModel,
    propFields,
    catalogRelations,
    catalogModels,
    labels,
    locale,
    fieldLabels,
    nameDisplayMode = 'display',
    fieldTypes,
    onImportCommitResult,
  } = props;
  const page = useDataPage();
  const importFailures = page.importFailures;

  const formatField = useMemo(
    () => createFieldLabelFormatter(fieldLabels, locale, nameDisplayMode === 'display'),
    [fieldLabels, locale, nameDisplayMode],
  );
  const formatModel = useCallback(
    (modelName: string): string => {
      if (nameDisplayMode === 'name') {
        return modelName;
      }
      const model = catalogModels.find((m) => m.name === modelName);
      return formatDisplayWithUnique(modelName, displayNameForLocale(model?.displayName, locale));
    },
    [catalogModels, locale, nameDisplayMode],
  );

  const [fileName, setFileName] = useState<string | null>(null);
  const [schema, setSchema] = useState<IngestSchema | null>(null);
  const [mappingOverrides, setMappingOverrides] = useState<Record<string, string>>({});
  const [relationBindings, setRelationBindings] = useState<RelationBindingRule[]>([]);
  const [previewRawRows, setPreviewRawRows] = useState<readonly Record<string, unknown>[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [csvFingerprint, setCsvFingerprint] = useState('');
  const [csvTextCache, setCsvTextCache] = useState('');
  const [upsertMatchField, setUpsertMatchField] = useState('');

  const applicableRelations = useMemo(
    () => relationsForImportModel(targetModel, catalogRelations),
    [targetModel, catalogRelations],
  );

  const autoMap = useMemo(() => {
    if (!schema) {
      return null;
    }
    return autoMapIngestColumns(schema.columns, { targetFields: propFields });
  }, [schema, propFields]);

  const effectiveMapping = useMemo(() => {
    if (!autoMap) {
      return {};
    }
    return mergeColumnMapping(autoMap.mappedColumns, mappingOverrides);
  }, [autoMap, mappingOverrides]);

  const mappedTargetFields = useMemo(
    () => [...new Set(Object.values(effectiveMapping))],
    [effectiveMapping],
  );

  useEffect(() => {
    setUpsertMatchField((prev) => {
      if (prev.length > 0 && mappedTargetFields.includes(prev)) {
        return prev;
      }
      return preferredUpsertField(mappedTargetFields);
    });
  }, [mappedTargetFields]);

  const activeRelationBindings = useMemo(
    () =>
      relationBindings.filter(
        (r) => r.sourceColumn.length > 0 && r.targetMatchColumn.length > 0 && r.relation.length > 0,
      ),
    [relationBindings],
  );

  const peerFields = useCallback(
    (rule: Pick<RelationBindingRule, 'targetModel'>): readonly string[] => {
      const model = catalogModels.find((m) => m.name === rule.targetModel);
      const fromCatalog = catalogModelFields(model);
      if (rule.targetModel !== targetModel) {
        return fromCatalog;
      }
      return uniqueFields([...fromCatalog, ...propFieldsFromCatalogFields(propFields)]);
    },
    [catalogModels, propFields, targetModel],
  );

  const peerFieldLabels = useCallback(
    (targetPeerModel: string): FieldLabelMap | undefined => {
      const model = catalogModels.find((m) => m.name === targetPeerModel);
      if (targetPeerModel === targetModel) {
        return { ...(fieldLabels ?? {}), ...(model?.fieldLabels ?? {}) };
      }
      return model?.fieldLabels;
    },
    [catalogModels, fieldLabels, targetModel],
  );

  const formatPeerField = useCallback(
    (targetPeerModel: string, fieldName: string): string => {
      return createFieldLabelFormatter(
        peerFieldLabels(targetPeerModel),
        locale,
        nameDisplayMode === 'display',
      )(fieldName);
    },
    [locale, nameDisplayMode, peerFieldLabels],
  );

  const resetImportState = useCallback((): void => {
    setSchema(null);
    setMappingOverrides({});
    setRelationBindings([]);
    setPreviewRawRows([]);
    setStatus(null);
    setError(null);
    setCsvFingerprint('');
    setCsvTextCache('');
    setUpsertMatchField('');
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) {
        return;
      }

      setBusy(true);
      setError(null);
      setStatus(null);
      resetImportState();

      try {
        const text = await readFileAsText(file);
        setCsvTextCache(text);
        setFileName(file.name);
        setCsvFingerprint(`${file.name}:${file.size}:${text.length}`);

        const handle = await csvIngestAdapter.open({
          format: 'csv',
          locator: file.name,
          options: { content: text },
        });

        const sniffed = await handle.sniffSchema(PREVIEW_ROWS);
        setSchema(sniffed);

        const previewChunk = await handle.readChunk(PREVIEW_ROWS);
        handle.close();

        setPreviewRawRows(previewChunk ?? []);
        setRelationBindings(
          suggestRelationBindings(sniffed.columns, targetModel, catalogRelations, catalogModels),
        );
        setStatus(
          labels.loadedSummary
            .replace('{{rows}}', String(sniffed.rowCountEstimate ?? 0))
            .replace('{{columns}}', String(sniffed.columns.length)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setFileName(null);
        setCsvTextCache('');
      } finally {
        setBusy(false);
      }
    },
    [catalogModels, catalogRelations, labels.loadedSummary, resetImportState, targetModel],
  );

  const handleMappingChange = useCallback((sourceCol: string, targetField: string): void => {
    setMappingOverrides((prev) => {
      if (targetField.length === 0) {
        const next = { ...prev };
        delete next[sourceCol];
        return next;
      }
      return { ...prev, [sourceCol]: targetField };
    });
  }, []);

  const updateRelationBinding = useCallback(
    (index: number, patch: Partial<RelationBindingRule>): void => {
      setRelationBindings((prev) =>
        prev.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
      );
    },
    [],
  );

  const addRelationBinding = useCallback((): void => {
    const unused = applicableRelations.find(
      (r) =>
        !relationBindings.some(
          (b) => relationKeyForRule(b, applicableRelations, targetModel) === relationOptionKey(r),
        ),
    );
    const relation = unused ?? applicableRelations[0];
    if (!relation) {
      return;
    }
    const peer = relatedModelForImport(relation, targetModel);
    if (!peer) {
      return;
    }
    setRelationBindings((prev) =>
      mergeRelationBindings(prev, [
        {
          relation: relation.forward,
          sourceColumn: schema?.columns[0]?.name ?? '',
          targetModel: peer,
          targetMatchColumn: peerFields({ targetModel: peer })[0] ?? '',
        },
      ]),
    );
  }, [applicableRelations, peerFields, relationBindings, schema?.columns, targetModel]);

  const removeRelationBinding = useCallback((index: number): void => {
    setRelationBindings((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleStageImport = useCallback(async (): Promise<void> => {
    if (!schema || !fileName || csvTextCache.length === 0) {
      setError(labels.selectFileFirst);
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);

    try {
      if (page.mode !== 'edit') {
        page.setMode('edit');
      }

      const handle = await csvIngestAdapter.open({
        format: 'csv',
        locator: fileName,
        options: { content: csvTextCache },
      });

      const profile = createImportProfile(targetModel, effectiveMapping, csvFingerprint, {
        relationBindings: activeRelationBindings,
      });
      const result = await collectImportOpsFromHandle(handle, profile, {
        relations: catalogRelations,
        targetFields: propFields,
        fieldTypes,
        catalogModels,
        upsertMatchFields: upsertMatchField ? [upsertMatchField] : undefined,
      });
      handle.close();

      if (result.ops.length === 0) {
        throw new Error(labels.noRowsToImport);
      }

      page.stageImportOps(result.ops, result.bindOnlyStaging);
      const insertOps = result.ops.filter((o) => o.op === 'insertMany').length;
      const bindOps = result.ops.filter((o) => o.op === 'bind').length;
      const bindPart =
        bindOps > 0 ? labels.stagedSummaryBind.replace('{{bindOps}}', String(bindOps)) : '';
      const skippedPart =
        result.skippedRowCount > 0
          ? labels.stagedSkipped.replace('{{skipped}}', String(result.skippedRowCount))
          : '';
      setStatus(
        labels.stagedSummary
          .replace('{{rows}}', String(result.importedRowCount))
          .replace('{{insertOps}}', String(insertOps))
          .replace('{{bindPart}}', bindPart)
          .replace('{{skippedPart}}', skippedPart),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    schema,
    fileName,
    csvTextCache,
    page,
    targetModel,
    effectiveMapping,
    csvFingerprint,
    activeRelationBindings,
    catalogRelations,
    propFields,
    fieldTypes,
    labels,
    catalogModels,
    upsertMatchField,
  ]);

  const previewMappedRows = useMemo(() => {
    if (!schema) {
      return [];
    }
    return previewRawRows.map((row) =>
      coerceImportRow(mapIngestRow(row, effectiveMapping), fieldTypes),
    );
  }, [previewRawRows, effectiveMapping, schema, fieldTypes]);

  const csvColumns = schema?.columns.map((c) => c.name) ?? [];

  const handleRetryCommit = useCallback((): void => {
    void (async (): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        if (fieldTypes) {
          page.replacePendingOps(coerceInsertManyOps(page.binding.pendingOps, fieldTypes));
        }
        const result = await page.commitBatch();
        onImportCommitResult?.(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [fieldTypes, onImportCommitResult, page]);

  return (
    <div className="import-panel">
      <div className="import-panel-header">
        <label className="import-panel-file">
          {labels.csvFile}
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => void handleFileChange(e)}
          />
        </label>
        {fileName ? <span className="import-panel-meta">{fileName}</span> : null}
        <span className="import-panel-meta">
          {labels.targetModel.replace('{{model}}', formatModel(targetModel))}
        </span>
      </div>

      {schema ? (
        <div className="import-panel-sections">
          {autoMap && autoMap.ambiguities.length > 0 ? (
            <div className="import-panel-section">
              <h3>{labels.mappingNotes}</h3>
              <div className="import-panel-body">
                {autoMap.ambiguities.map((a) => (
                  <div key={a.id} className="import-ambiguity">
                    {formatImportAmbiguity(a, labels, formatField)}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="import-panel-section">
            <h3>{labels.columnMapping}</h3>
            <div className="import-panel-body import-panel-scroll-x">
              <table className="import-mapping-table">
                <thead>
                  <tr>
                    <th scope="col">{labels.csvColumn}</th>
                    <th scope="col">{labels.modelField}</th>
                  </tr>
                </thead>
                <tbody>
                  {schema.columns.map((col) => (
                    <tr key={col.name}>
                      <td className="import-cell-text">{col.name}</td>
                      <td>
                        <select
                          className="import-field-select"
                          value={effectiveMapping[col.name] ?? ''}
                          aria-label={`${labels.modelField}: ${col.name}`}
                          onChange={(e) => handleMappingChange(col.name, e.target.value)}
                        >
                          <option value="">{labels.skipColumn}</option>
                          {propFields.map((f) => (
                            <option key={f} value={f}>
                              {formatField(f)}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="import-panel-section">
            <h3>{labels.duplicateHandling}</h3>
            <div className="import-panel-body import-dedupe-panel">
              <label className="import-dedupe-field">
                {labels.upsertMatchField}
                <select
                  className="import-field-select"
                  value={upsertMatchField}
                  onChange={(e) => setUpsertMatchField(e.target.value)}
                >
                  <option value="">{labels.upsertAppendOnly}</option>
                  {mappedTargetFields.map((f) => (
                    <option key={f} value={f}>
                      {formatField(f)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="import-relation-hint">{labels.upsertHelp}</p>
            </div>
          </div>

          {applicableRelations.length > 0 ? (
            <div className="import-panel-section">
              <h3>{labels.relationBindings}</h3>
              <div className="import-panel-body">
                <p className="import-relation-hint">{labels.relationHint}</p>
                {relationBindings.length === 0 ? (
                  <p className="import-relation-empty">{labels.relationEmpty}</p>
                ) : (
                  <div className="import-panel-scroll-x">
                    <table className="import-mapping-table import-relation-table">
                      <thead>
                        <tr>
                          <th scope="col">{labels.relation}</th>
                          <th scope="col">{labels.csvColumn}</th>
                          <th scope="col">{labels.relatedModel}</th>
                          <th scope="col">{labels.matchField}</th>
                          <th
                            scope="col"
                            className="import-actions-col"
                            aria-label={labels.remove}
                          />
                        </tr>
                      </thead>
                      <tbody>
                        {relationBindings.map((rule, index) => (
                          <tr key={`${rule.relation}-${rule.targetModel}-${index}`}>
                            <td>
                              <select
                                className="import-field-select"
                                value={relationKeyForRule(rule, applicableRelations, targetModel)}
                                aria-label={labels.relation}
                                onChange={(e) => {
                                  const rel = applicableRelations.find(
                                    (r) => relationOptionKey(r) === e.target.value,
                                  );
                                  const forward = rel?.forward ?? '';
                                  const peer = rel ? relatedModelForImport(rel, targetModel) : null;
                                  updateRelationBinding(index, {
                                    relation: forward,
                                    targetModel: peer ?? rule.targetModel,
                                    targetMatchColumn: peer
                                      ? (peerFields({ targetModel: peer })[0] ?? '')
                                      : '',
                                  });
                                }}
                              >
                                {applicableRelations.map((r) => (
                                  <option key={relationOptionKey(r)} value={relationOptionKey(r)}>
                                    {r.forward} ({formatModel(r.source)} → {formatModel(r.target)})
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <select
                                className="import-field-select"
                                value={rule.sourceColumn}
                                aria-label={labels.csvColumn}
                                onChange={(e) =>
                                  updateRelationBinding(index, { sourceColumn: e.target.value })
                                }
                              >
                                <option value="">{labels.selectOption}</option>
                                {csvColumns.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="import-cell-text">{formatModel(rule.targetModel)}</td>
                            <td>
                              <select
                                className="import-field-select"
                                value={rule.targetMatchColumn}
                                aria-label={labels.matchField}
                                onChange={(e) =>
                                  updateRelationBinding(index, {
                                    targetMatchColumn: e.target.value,
                                  })
                                }
                              >
                                <option value="">{labels.selectOption}</option>
                                {peerFields(rule).map((f) => (
                                  <option key={f} value={f}>
                                    {formatPeerField(rule.targetModel, f)}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <button type="button" onClick={() => removeRelationBinding(index)}>
                                {labels.remove}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="import-relation-actions">
                  <button type="button" disabled={busy} onClick={addRelationBinding}>
                    {labels.addRelationBinding}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {mappedTargetFields.length > 0 ? (
            <div className="import-panel-section">
              <h3>{labels.previewTitle.replace('{{count}}', String(PREVIEW_ROWS))}</h3>
              <div className="import-panel-body import-panel-scroll-x import-preview-scroll">
                <table className="import-preview-table">
                  <thead>
                    <tr>
                      {mappedTargetFields.map((f) => (
                        <th key={f} scope="col">
                          {formatField(f)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewMappedRows.map((row, i) => (
                      <tr key={i}>
                        {mappedTargetFields.map((f) => (
                          <td key={f}>{formatCell(row[f])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="import-panel-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !schema || mappedTargetFields.length === 0}
          onClick={() => void handleStageImport()}
        >
          {busy ? labels.working : labels.stageImport}
        </button>
        {page.isDirty ? (
          <span className="import-panel-status">
            {labels.pendingOps.replace('{{count}}', String(page.binding.pendingCount))}
          </span>
        ) : null}
      </div>

      {status ? <p className="import-panel-status success">{status}</p> : null}
      {error ? <p className="import-panel-status error">{error}</p> : null}
      {page.lastError && !importFailures?.length ? (
        <p className="import-panel-status error">{page.lastError}</p>
      ) : null}

      {importFailures && importFailures.length > 0 ? (
        <ImportFailurePanel
          failures={importFailures}
          fields={propFields}
          busy={busy}
          labels={{
            title: labels.failureTitle,
            summary: labels.failureSummary,
            rowNumber: labels.failureRowNumber,
            reasons: labels.failureReasons,
            retryCommit: labels.failureRetryCommit,
            partialSuccess: labels.failurePartialSuccess,
          }}
          onRetryCommit={handleRetryCommit}
        />
      ) : null}
    </div>
  );
}
