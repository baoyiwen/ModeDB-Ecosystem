import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  ModelDB,
  type ManagementCatalogModelInfo,
  type ManagementCatalogRelationInfo,
  type ManagementCatalogResponse,
  type RemoteModelDBClient,
} from '@mode-db/sdk';
import { LOCALE_LABEL, type LocaleId } from './i18n/messages';
import { useI18n } from './i18n/I18nContext';
import { QueryPanel } from './components/QueryPanel.js';
import { useHashRoute } from './hooks/use-hash-route.js';
import { QueryManualPage } from './pages/QueryManualPage.js';
import { DEFAULT_QUERY_FORM, QUERY_FORM_LS_PREFIX } from './query/query-form-types.js';
import {
  clearPlaygroundSession,
  isPlaygroundSessionValid,
  loadPlaygroundSession,
  touchPlaygroundSession,
} from './session/playground-session.js';

const LS = {
  host: 'modedb.playground.host',
  port: 'modedb.playground.port',
  token: 'modedb.playground.token',
} as const;

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function serializeRowEntity(row: unknown): unknown {
  if (
    row &&
    typeof row === 'object' &&
    'getData' in row &&
    typeof (row as { getData: () => unknown }).getData === 'function'
  ) {
    const h = row as { getData: (d?: boolean) => unknown; getModelName: () => string };
    return {
      model: h.getModelName(),
      data: h.getData(true),
    };
  }
  return row;
}

function serializeRows(rows: unknown): unknown {
  if (Array.isArray(rows)) {
    return rows.map(serializeRowEntity);
  }
  if (!rows || typeof rows !== 'object') {
    return rows;
  }
  const rec = rows as Record<string, unknown>;
  if (rec.kind === 'paginated' && 'items' in rec) {
    return { ...rec, items: serializeRows(rec.items) };
  }
  if (rec.kind === 'rows' && Array.isArray(rec.rows)) {
    return { ...rec, rows: rec.rows.map(serializeRowEntity) };
  }
  return rows;
}

const DEFAULT_INSERT = '[\n  { "_id": "row-1", "name": "Example" }\n]';
const DEFAULT_ALTER_PATCH = '{\n  "note": { "type": "String", "required": false }\n}';

export function App(): ReactElement {
  const route = useHashRoute();

  return (
    <>
      <PlaygroundApp />
      {route === 'query-manual' ? <QueryManualPage /> : null}
    </>
  );
}

function PlaygroundApp(): ReactElement {
  const { t, locale, setLocale } = useI18n();

  const webGpuLabel = (raw: string): string => {
    switch (raw) {
      case 'unavailable':
        return t('webgpu.unavailable');
      case 'adapter ok':
        return t('webgpu.adapterOk');
      case 'no adapter':
        return t('webgpu.noAdapter');
      case '…':
        return t('webgpu.ellipsis');
      default:
        return raw;
    }
  };

  const [host, setHost] = useState(() =>
    load(LS.host, import.meta.env.VITE_DEFAULT_HOST ?? '127.0.0.1'),
  );
  const [port, setPort] = useState(() =>
    load(LS.port, import.meta.env.VITE_DEFAULT_PORT ?? '8765'),
  );
  const [token, setToken] = useState(() =>
    load(LS.token, import.meta.env.VITE_DEFAULT_TOKEN ?? ''),
  );

  const [webGpu, setWebGpu] = useState<string>('…');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  const [modelDb, setModelDb] = useState<ModelDB | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, ManagementCatalogResponse>>({});
  const [selectedDb, setSelectedDb] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [wire, setWire] = useState<RemoteModelDBClient | null>(null);

  const [newDbName, setNewDbName] = useState('');
  const [insertJson, setInsertJson] = useState(DEFAULT_INSERT);
  const [alterPatchJson, setAlterPatchJson] = useState(DEFAULT_ALTER_PATCH);
  const [dropRelationForward, setDropRelationForward] = useState('');
  const [queryReloadToken, setQueryReloadToken] = useState(0);
  const [sessionRestoring, setSessionRestoring] = useState(false);
  const autoConnectStarted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!navigator.gpu) {
      setWebGpu('unavailable');
      return;
    }
    void navigator.gpu.requestAdapter().then((adapter) => {
      if (!cancelled) {
        setWebGpu(adapter ? 'adapter ok' : 'no adapter');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    save(LS.host, host);
  }, [host]);
  useEffect(() => {
    save(LS.port, port);
  }, [port]);
  useEffect(() => {
    save(LS.token, token);
  }, [token]);

  const endpoint = useMemo(() => `${host}:${port}`, [host, port]);

  const loadTrees = useCallback(async (db: ModelDB): Promise<void> => {
    const names = await db.listDatabases();
    const next: Record<string, ManagementCatalogResponse> = {};
    await Promise.all(
      names.map(async (n: string) => {
        try {
          next[n] = await db.getDatabaseCatalog(n);
        } catch {
          next[n] = { database: n, models: [], relations: [] };
        }
      }),
    );
    setCatalogs(next);
    touchPlaygroundSession();
  }, []);

  const connect = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!opts?.silent) {
        setError(null);
        setResult(null);
      }
      const p = Number(port);
      if (!token.trim() || !Number.isFinite(p)) {
        if (!opts?.silent) {
          setError(t('connect.needCredentials'));
        }
        return false;
      }
      if (!opts?.silent) {
        setBusy(true);
      }
      try {
        const db = new ModelDB({ host: host.trim(), port: p, token: token.trim() });
        await loadTrees(db);
        setModelDb(db);
        if (!opts?.silent) {
          setSelectedDb(null);
          setSelectedModel(null);
          setWire(null);
        }
        touchPlaygroundSession();
        return true;
      } catch (e) {
        clearPlaygroundSession();
        const message = e instanceof Error ? e.message : String(e);
        if (opts?.silent) {
          setError(t('session.reconnectFailed', { reason: message }));
        } else {
          setError(message);
        }
        setModelDb(null);
        setCatalogs({});
        return false;
      } finally {
        if (!opts?.silent) {
          setBusy(false);
        }
      }
    },
    [host, loadTrees, port, t, token],
  );

  useEffect(() => {
    if (!modelDb || !selectedDb) {
      setWire(null);
      return;
    }
    let cancelled = false;
    void modelDb.use(selectedDb).then((c: RemoteModelDBClient) => {
      if (!cancelled) {
        setWire(c);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [modelDb, selectedDb]);

  useEffect(() => {
    if (autoConnectStarted.current || modelDb) {
      return;
    }
    autoConnectStarted.current = true;

    const session = loadPlaygroundSession();
    if (!isPlaygroundSessionValid(session)) {
      if (session) {
        clearPlaygroundSession();
        setError(t('session.expired'));
      }
      return;
    }

    const p = Number(port);
    if (!token.trim() || !Number.isFinite(p)) {
      return;
    }

    setSessionRestoring(true);
    void connect({ silent: true }).finally(() => {
      setSessionRestoring(false);
    });
  }, [connect, modelDb, port, t, token]);

  const disconnect = useCallback((): void => {
    clearPlaygroundSession();
    setModelDb(null);
    setCatalogs({});
    setSelectedDb(null);
    setSelectedModel(null);
    setWire(null);
    setResult(null);
    setError(null);
  }, []);

  const createDb = useCallback(async (): Promise<void> => {
    if (!modelDb) {
      return;
    }
    const name = newDbName.trim();
    if (!name) {
      setError(t('db.needName'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await modelDb.createDatabase(name);
      setNewDbName('');
      await loadTrees(modelDb);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loadTrees, modelDb, newDbName, t]);

  const removeDb = useCallback(async (): Promise<void> => {
    if (!modelDb || !selectedDb) {
      return;
    }
    if (!globalThis.confirm(t('db.confirmDelete', { name: selectedDb }))) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await modelDb.deleteDatabase(selectedDb);
      modelDb.releaseClient(selectedDb);
      setSelectedDb(null);
      setSelectedModel(null);
      setWire(null);
      await loadTrees(modelDb);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loadTrees, modelDb, selectedDb, t]);

  const runInsert = useCallback(async (): Promise<void> => {
    if (!wire || !selectedModel) {
      setError(t('error.selectDbModel'));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const parsed = JSON.parse(insertJson) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(t('insert.mustArray'));
      }
      const out = await wire.model(selectedModel).insertMany(parsed as Record<string, unknown>[]);
      setResult(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [insertJson, selectedModel, t, wire]);

  const runAlterPatch = useCallback(async (): Promise<void> => {
    if (!wire || !selectedModel) {
      setError(t('error.selectDbModel'));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const patch = JSON.parse(alterPatchJson) as Record<string, unknown>;
      await wire.alterModel(selectedModel, patch, { patch: true });
      setResult({ ok: true, op: 'alterModelPatch', model: selectedModel });
      if (modelDb && selectedDb) {
        await loadTrees(modelDb);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [alterPatchJson, loadTrees, modelDb, selectedDb, selectedModel, t, wire]);

  const runDropModel = useCallback(async (): Promise<void> => {
    if (!wire || !selectedModel) {
      return;
    }
    if (!globalThis.confirm(t('schema.confirmDrop', { name: selectedModel }))) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const dropped = selectedModel;
      await wire.dropModel(dropped);
      setSelectedModel(null);
      setResult({ ok: true, op: 'dropModel', model: dropped });
      if (modelDb && selectedDb) {
        await loadTrees(modelDb);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loadTrees, modelDb, selectedDb, selectedModel, t, wire]);

  const runDropRelation = useCallback(async (): Promise<void> => {
    if (!wire) {
      return;
    }
    const rel = dropRelationForward.trim();
    if (!rel) {
      setError(t('rel.needForward'));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await wire.dropRelation(rel);
      setResult({ ok: true, op: 'dropRelation', relation: rel });
      if (modelDb && selectedDb) {
        await loadTrees(modelDb);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [dropRelationForward, loadTrees, modelDb, selectedDb, t, wire]);

  const runClearModelData = useCallback(async (): Promise<void> => {
    if (!wire || !selectedModel) {
      setError(t('error.selectDbModel'));
      return;
    }
    if (!globalThis.confirm(t('data.confirmClearModel', { name: selectedModel }))) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await wire.apply({ op: 'clearModelData', model: selectedModel });
      setResult(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [selectedModel, t, wire]);

  const runClearAllData = useCallback(async (): Promise<void> => {
    if (!wire || !selectedDb) {
      setError(t('ops.selectDb'));
      return;
    }
    if (!globalThis.confirm(t('data.confirmClearAll', { db: selectedDb }))) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await wire.apply({ op: 'clearAllData' });
      setResult(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [selectedDb, t, wire]);

  const dbNames = useMemo(() => Object.keys(catalogs).sort(), [catalogs]);

  return (
    <div className="app-grid">
      <aside className="panel sidebar">
        <h1>{t('app.title')}</h1>
        <div className="lang-switch">
          <label htmlFor="locale">{t('app.lang')}</label>
          <select
            id="locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value as LocaleId)}
            aria-label={t('app.lang')}
          >
            {(Object.keys(LOCALE_LABEL) as LocaleId[]).map((id) => (
              <option key={id} value={id}>
                {LOCALE_LABEL[id]}
              </option>
            ))}
          </select>
        </div>
        <p className="meta">{t('meta.endpoint', { endpoint, webGpu: webGpuLabel(webGpu) })}</p>
        {sessionRestoring && !modelDb && <p className="meta">{t('session.restoring')}</p>}
        {!modelDb && !sessionRestoring && (
          <>
            <label htmlFor="host">{t('connect.host')}</label>
            <input
              id="host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              autoComplete="off"
            />
            <label htmlFor="port">{t('connect.port')}</label>
            <input
              id="port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              autoComplete="off"
            />
            <label htmlFor="token">{t('connect.token')}</label>
            <input
              id="token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              type="password"
            />
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => void connect()}>
                {t('connect.button')}
              </button>
            </div>
          </>
        )}
        {modelDb && (
          <>
            <p className="meta">{t('session.connected')}</p>
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => void loadTrees(modelDb)}>
                {t('session.refreshTree')}
              </button>
              <button type="button" disabled={busy} onClick={disconnect}>
                {t('session.disconnect')}
              </button>
            </div>
            <div className="tree">
              {dbNames.length === 0 && <p className="meta">{t('session.noDatabases')}</p>}
              {dbNames.map((db) => {
                const cat = catalogs[db];
                return (
                  <div key={db} className="tree-db">
                    <button
                      type="button"
                      className="tree-db-head"
                      onClick={() => {
                        setSelectedDb(db);
                        setSelectedModel(null);
                      }}
                    >
                      <strong>{db}</strong>
                    </button>
                    <ul className="model-list">
                      <li className="meta">{t('tree.models')}</li>
                      {(cat?.models ?? []).map((m: ManagementCatalogModelInfo) => (
                        <li key={m.name}>
                          <button
                            type="button"
                            className={selectedModel === m.name && selectedDb === db ? 'sel' : ''}
                            onClick={() => {
                              setSelectedDb(db);
                              setSelectedModel(m.name);
                            }}
                          >
                            {m.name}
                            {m.parentId ? (
                              <span className="meta">
                                {t('tree.extends')}
                                {m.parentId}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                      <li className="meta">{t('tree.relations')}</li>
                      {(cat?.relations ?? []).map((r: ManagementCatalogRelationInfo) => (
                        <li key={`${r.forward}-${r.source}-${r.target}`}>
                          <button
                            type="button"
                            className="model-list-relation"
                            onClick={() => {
                              setSelectedDb(db);
                              if (selectedModel) {
                                try {
                                  const key = `${QUERY_FORM_LS_PREFIX}${selectedModel}`;
                                  const raw = localStorage.getItem(key);
                                  const prev = raw
                                    ? ({
                                        ...DEFAULT_QUERY_FORM,
                                        ...JSON.parse(raw),
                                      } as typeof DEFAULT_QUERY_FORM)
                                    : { ...DEFAULT_QUERY_FORM };
                                  localStorage.setItem(
                                    key,
                                    JSON.stringify({
                                      ...prev,
                                      relationForward: r.forward,
                                      hopKind: 'relate',
                                    }),
                                  );
                                  setQueryReloadToken((n) => n + 1);
                                } catch {
                                  /* ignore */
                                }
                              }
                            }}
                          >
                            <code>
                              {r.forward}: {r.source} → {r.target}
                            </code>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            <label htmlFor="newdb">{t('db.newName')}</label>
            <input
              id="newdb"
              value={newDbName}
              onChange={(e) => setNewDbName(e.target.value)}
              placeholder="my-db"
            />
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => void createDb()}>
                {t('db.create')}
              </button>
              <button type="button" disabled={busy || !selectedDb} onClick={() => void removeDb()}>
                {t('db.deleteSelected')}
              </button>
            </div>
          </>
        )}
      </aside>

      <section className="panel center">
        <h2>{t('ops.title')}</h2>
        {!modelDb && <p className="meta">{t('ops.connectFirst')}</p>}
        {modelDb && (
          <>
            <p className="meta">
              {selectedDb
                ? selectedModel
                  ? t('ops.selectionDbModel', { db: selectedDb, model: selectedModel })
                  : t('ops.selectionDb', { db: selectedDb })
                : t('ops.selectDb')}
            </p>
            <p className="hint">{t('ops.hint')}</p>

            <QueryPanel
              wire={wire}
              selectedModel={selectedModel}
              busy={busy}
              serializeRows={serializeRows}
              onRunResult={setResult}
              onError={setError}
              onBusy={setBusy}
              queryReloadToken={queryReloadToken}
            />

            <h3>{t('insert.title')}</h3>
            <textarea
              className="code"
              value={insertJson}
              onChange={(e) => setInsertJson(e.target.value)}
              rows={6}
              spellCheck={false}
            />
            <div className="actions">
              <button
                type="button"
                disabled={busy || !wire || !selectedModel}
                onClick={() => void runInsert()}
              >
                {t('insert.button')}
              </button>
            </div>

            <h3>{t('schema.title')}</h3>
            <textarea
              className="code"
              value={alterPatchJson}
              onChange={(e) => setAlterPatchJson(e.target.value)}
              rows={5}
              spellCheck={false}
            />
            <div className="actions">
              <button
                type="button"
                disabled={busy || !wire || !selectedModel}
                onClick={() => void runAlterPatch()}
              >
                {t('schema.applyPatch')}
              </button>
              <button
                type="button"
                disabled={busy || !wire || !selectedModel}
                onClick={() => void runDropModel()}
              >
                {t('schema.dropModel')}
              </button>
            </div>

            <h3>{t('rel.title')}</h3>
            <input
              value={dropRelationForward}
              onChange={(e) => setDropRelationForward(e.target.value)}
              placeholder={t('rel.placeholder')}
            />
            <div className="actions">
              <button type="button" disabled={busy || !wire} onClick={() => void runDropRelation()}>
                {t('rel.drop')}
              </button>
            </div>

            <h3>{t('data.title')}</h3>
            <div className="actions">
              <button
                type="button"
                disabled={busy || !wire || !selectedModel}
                onClick={() => void runClearModelData()}
              >
                {t('data.clearModel')}
              </button>
              <button
                type="button"
                disabled={busy || !wire || !selectedDb}
                onClick={() => void runClearAllData()}
              >
                {t('data.clearAll')}
              </button>
            </div>
          </>
        )}
      </section>

      <main className="result">
        <h2 className="result-header">{t('result.title')}</h2>
        <div className="result-body">
          {error && <pre className="err">{error}</pre>}
          {!error && result !== null && <pre>{JSON.stringify(result, null, 2)}</pre>}
          {!error && result === null && !busy && <p className="meta">{t('result.empty')}</p>}
          {busy && <p className="meta">{t('result.loading')}</p>}
        </div>
      </main>
    </div>
  );
}
