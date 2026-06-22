import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { RemoteModelDBClient } from '@mode-db/sdk';
import {
  buildPlaygroundQueryChain,
  buildQueryExecuteOptions,
} from '../query/build-playground-chain.js';
import {
  DEFAULT_QUERY_FORM,
  DEFAULT_QUERY_SNAPSHOT,
  QUERY_FORM_LS_PREFIX,
  type QueryFormConfig,
  type QueryHopKind,
} from '../query/query-form-types.js';
import { useI18n } from '../i18n/I18nContext';
import { navigateToQueryManual } from '../hooks/use-hash-route.js';

const LS_QUERY_PREFIX = QUERY_FORM_LS_PREFIX;

type QueryTab = 'form' | 'snapshot';

function loadQueryForm(model: string | null): QueryFormConfig {
  if (!model) {
    return DEFAULT_QUERY_FORM;
  }
  try {
    const raw = localStorage.getItem(`${LS_QUERY_PREFIX}${model}`);
    if (!raw) {
      return DEFAULT_QUERY_FORM;
    }
    return { ...DEFAULT_QUERY_FORM, ...(JSON.parse(raw) as Partial<QueryFormConfig>) };
  } catch {
    return DEFAULT_QUERY_FORM;
  }
}

function saveQueryForm(model: string, config: QueryFormConfig): void {
  try {
    localStorage.setItem(`${LS_QUERY_PREFIX}${model}`, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

export function QueryPanel(props: {
  wire: RemoteModelDBClient | null;
  selectedModel: string | null;
  busy: boolean;
  onRunResult: (result: unknown) => void;
  onError: (message: string | null) => void;
  onBusy: (busy: boolean) => void;
  serializeRows: (rows: unknown) => unknown;
  queryReloadToken?: number;
}): ReactElement {
  const { t } = useI18n();
  const {
    wire,
    selectedModel,
    busy,
    onRunResult,
    onError,
    onBusy,
    serializeRows,
    queryReloadToken,
  } = props;

  const [tab, setTab] = useState<QueryTab>('form');
  const [form, setForm] = useState<QueryFormConfig>(() => loadQueryForm(selectedModel));
  const [snapshotJson, setSnapshotJson] = useState(DEFAULT_QUERY_SNAPSHOT);

  useEffect(() => {
    setForm(loadQueryForm(selectedModel));
  }, [selectedModel, queryReloadToken]);

  useEffect(() => {
    if (selectedModel) {
      saveQueryForm(selectedModel, form);
    }
  }, [form, selectedModel]);

  const patchForm = useCallback((patch: Partial<QueryFormConfig>): void => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const ensureSelection = (): boolean => {
    if (!wire || !selectedModel) {
      onError(t('error.selectDbModel'));
      return false;
    }
    return true;
  };

  const runFormQuery = async (): Promise<void> => {
    if (!ensureSelection() || !wire || !selectedModel) {
      return;
    }
    onBusy(true);
    onError(null);
    onRunResult(null);
    try {
      const chain = buildPlaygroundQueryChain(wire, selectedModel, form);
      const opts = buildQueryExecuteOptions(form);
      const rows = await chain.execute(opts);
      onRunResult(serializeRows(rows));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const runFormViaApply = async (): Promise<void> => {
    if (!ensureSelection() || !wire || !selectedModel) {
      return;
    }
    onBusy(true);
    onError(null);
    onRunResult(null);
    try {
      const chain = buildPlaygroundQueryChain(wire, selectedModel, form);
      const snapshot = chain.getRemoteExecuteSnapshot(buildQueryExecuteOptions(form));
      const out = await wire.apply({ op: 'executeQuery', snapshot });
      onRunResult(out);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const runSnapshotQuery = async (): Promise<void> => {
    if (!wire) {
      onError(t('error.selectDbModel'));
      return;
    }
    onBusy(true);
    onError(null);
    onRunResult(null);
    try {
      const snapshot = JSON.parse(snapshotJson) as unknown;
      const out = await wire.apply({ op: 'executeQuery', snapshot });
      onRunResult(out);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const fillSnapshotTemplate = (): void => {
    if (!selectedModel) {
      return;
    }
    setSnapshotJson(DEFAULT_QUERY_SNAPSHOT.replace('<ModelName>', selectedModel));
  };

  const hopOptions: { value: QueryHopKind; label: string }[] = [
    { value: 'none', label: t('query.hopNone') },
    { value: 'relate', label: t('query.hopRelate') },
    { value: 'group', label: t('query.hopGroup') },
    { value: 'children', label: t('query.hopChildren') },
    { value: 'recursive', label: t('query.hopRecursive') },
  ];

  return (
    <div className="query-panel">
      <div className="query-panel-head">
        <h3>{t('query.title')}</h3>
        <button type="button" className="query-manual-link" onClick={navigateToQueryManual}>
          {t('query.openManual')}
        </button>
      </div>
      <p className="hint">{t('query.advancedHint')}</p>

      <div className="query-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={tab === 'form' ? 'query-tab query-tab--active' : 'query-tab'}
          aria-selected={tab === 'form'}
          onClick={() => setTab('form')}
        >
          {t('query.tabForm')}
        </button>
        <button
          type="button"
          role="tab"
          className={tab === 'snapshot' ? 'query-tab query-tab--active' : 'query-tab'}
          aria-selected={tab === 'snapshot'}
          onClick={() => setTab('snapshot')}
        >
          {t('query.tabSnapshot')}
        </button>
      </div>

      {tab === 'form' ? (
        <div className="query-form">
          <fieldset className="query-fieldset">
            <legend>{t('query.sectionStart')}</legend>
            <label htmlFor="query-ids">{t('query.startIds')}</label>
            <input
              id="query-ids"
              value={form.startIds}
              onChange={(e) => patchForm({ startIds: e.target.value })}
              placeholder={t('query.startIdsPlaceholder')}
              spellCheck={false}
            />
          </fieldset>

          <fieldset className="query-fieldset">
            <legend>{t('query.sectionFilter')}</legend>
            <p className="hint">{t('query.filtersHint')}</p>
            <textarea
              className="code"
              value={form.filtersJson}
              onChange={(e) => patchForm({ filtersJson: e.target.value })}
              rows={4}
              spellCheck={false}
            />
          </fieldset>

          <fieldset className="query-fieldset">
            <legend>{t('query.sectionRelation')}</legend>
            <label htmlFor="query-hop">{t('query.hopKind')}</label>
            <select
              id="query-hop"
              value={form.hopKind}
              onChange={(e) => patchForm({ hopKind: e.target.value as QueryHopKind })}
            >
              {hopOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <label htmlFor="query-relate">{t('query.relateLabel')}</label>
            <input
              id="query-relate"
              value={form.relationForward}
              onChange={(e) => patchForm({ relationForward: e.target.value })}
              placeholder={t('query.relatePlaceholder')}
              spellCheck={false}
            />
            {(form.hopKind === 'children' || form.hopKind === 'recursive') && (
              <>
                <label htmlFor="query-depth">{t('query.maxDepth')}</label>
                <input
                  id="query-depth"
                  type="number"
                  min={1}
                  max={10000}
                  value={form.maxDepth}
                  onChange={(e) =>
                    patchForm({ maxDepth: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </>
            )}
          </fieldset>

          <fieldset className="query-fieldset">
            <legend>{t('query.sectionExecute')}</legend>
            <div className="query-row">
              <label htmlFor="query-limit">{t('query.limit')}</label>
              <input
                id="query-limit"
                value={form.limit}
                onChange={(e) => patchForm({ limit: e.target.value })}
                placeholder="10"
                spellCheck={false}
              />
              <label htmlFor="query-page">{t('query.page')}</label>
              <input
                id="query-page"
                value={form.page}
                onChange={(e) => patchForm({ page: e.target.value })}
                placeholder="0"
                spellCheck={false}
              />
            </div>
            <label className="query-check">
              <input
                type="checkbox"
                checked={form.includeRelates}
                onChange={(e) => patchForm({ includeRelates: e.target.checked })}
              />
              {t('query.includeRelates')}
            </label>
          </fieldset>

          <fieldset className="query-fieldset">
            <legend>{t('query.sectionAnalysis')}</legend>
            <label htmlFor="query-mode">{t('query.resultMode')}</label>
            <select
              id="query-mode"
              value={form.resultMode}
              onChange={(e) =>
                patchForm({ resultMode: e.target.value as QueryFormConfig['resultMode'] })
              }
            >
              <option value="rows">{t('query.modeRows')}</option>
              <option value="analysis">{t('query.modeAnalysis')}</option>
            </select>
            {form.resultMode === 'analysis' && (
              <>
                <label htmlFor="query-groupby">{t('query.groupBy')}</label>
                <input
                  id="query-groupby"
                  value={form.groupBy}
                  onChange={(e) => patchForm({ groupBy: e.target.value })}
                  placeholder={t('query.groupByPlaceholder')}
                  spellCheck={false}
                />
                <label htmlFor="query-compute">{t('query.compute')}</label>
                <textarea
                  id="query-compute"
                  className="code"
                  value={form.computeJson}
                  onChange={(e) => patchForm({ computeJson: e.target.value })}
                  rows={3}
                  spellCheck={false}
                />
              </>
            )}
          </fieldset>

          <div className="actions">
            <button
              type="button"
              disabled={busy || !wire || !selectedModel}
              onClick={() => void runFormQuery()}
            >
              {t('query.run')}
            </button>
            <button
              type="button"
              disabled={busy || !wire || !selectedModel}
              onClick={() => void runFormViaApply()}
            >
              {t('query.runViaApply')}
            </button>
          </div>
        </div>
      ) : (
        <div className="query-snapshot">
          <p className="hint">{t('query.snapshotHint')}</p>
          <div className="actions">
            <button type="button" disabled={!selectedModel} onClick={fillSnapshotTemplate}>
              {t('query.fillModelTemplate')}
            </button>
          </div>
          <textarea
            className="code"
            value={snapshotJson}
            onChange={(e) => setSnapshotJson(e.target.value)}
            rows={14}
            spellCheck={false}
          />
          <div className="actions">
            <button type="button" disabled={busy || !wire} onClick={() => void runSnapshotQuery()}>
              {t('query.runSnapshot')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
