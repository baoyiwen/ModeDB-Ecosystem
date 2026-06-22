import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  ModelDB,
  type ManagementCatalogModelInfo,
  type ManagementCatalogRelationInfo,
  type ManagementCatalogResponse,
  type RemoteModelDBClient,
} from '@mode-db/sdk';
import { LOCALE_LABEL, type LocaleId } from './i18n/messages';
import { useI18n } from './i18n/I18nContext';

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

function serializeRows(rows: unknown): unknown {
  if (!Array.isArray(rows)) {
    return rows;
  }
  return rows.map((r) => {
    if (
      r &&
      typeof r === 'object' &&
      'getData' in r &&
      typeof (r as { getData: () => unknown }).getData === 'function'
    ) {
      const h = r as { getData: (d?: boolean) => unknown; getModelName: () => string };
      return {
        model: h.getModelName(),
        data: h.getData(true),
      };
    }
    return r;
  });
}

const DEFAULT_INSERT = '[\n  { "_id": "row-1", "name": "Example" }\n]';
const DEFAULT_ALTER_PATCH = '{\n  "note": { "type": "String", "required": false }\n}';

export function App(): ReactElement {
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
  const [relateForward, setRelateForward] = useState('');
  const [dropRelationForward, setDropRelationForward] = useState('');

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
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    setError(null);
    setResult(null);
    const p = Number(port);
    if (!token.trim() || !Number.isFinite(p)) {
      setError(t('connect.needCredentials'));
      return;
    }
    setBusy(true);
    try {
      const db = new ModelDB({ host: host.trim(), port: p, token: token.trim() });
      await loadTrees(db);
      setModelDb(db);
      setSelectedDb(null);
      setSelectedModel(null);
      setWire(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setModelDb(null);
      setCatalogs({});
    } finally {
      setBusy(false);
    }
  }, [host, loadTrees, port, t, token]);

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

  const disconnect = useCallback((): void => {
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

  const runQuery = useCallback(async (): Promise<void> => {
    if (!wire || !selectedModel) {
      setError(t('error.selectDbModel'));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const rel = relateForward.trim();
      const chain = wire.model(selectedModel).query() as {
        relate: (n: string) => { execute: (o?: { includeRelates?: boolean }) => Promise<unknown> };
        group: (n: string) => {
          execute: (o?: { includeRelates?: boolean }) => Promise<unknown>;
          getRemoteExecuteSnapshot: (o?: { includeRelates?: boolean }) => unknown;
        };
        execute: (o?: { includeRelates?: boolean }) => Promise<unknown>;
        getRemoteExecuteSnapshot: (o?: { includeRelates?: boolean }) => unknown;
      };
      const q = rel ? chain.relate(rel) : chain;
      const rows = await q.execute({ includeRelates: true });
      setResult(serializeRows(rows));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [relateForward, selectedModel, t, wire]);

  const runQueryViaApply = useCallback(async (): Promise<void> => {
    if (!wire || !selectedModel) {
      setError(t('error.selectDbModel'));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const rel = relateForward.trim();
      const base = wire.model(selectedModel).query() as {
        relate: (n: string) => {
          getRemoteExecuteSnapshot: (o?: { includeRelates?: boolean }) => unknown;
        };
        getRemoteExecuteSnapshot: (o?: { includeRelates?: boolean }) => unknown;
      };
      const chain = rel ? base.relate(rel) : base;
      const snapshot = chain.getRemoteExecuteSnapshot({ includeRelates: true });
      const out = await wire.apply({ op: 'executeQuery', snapshot });
      setResult(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [relateForward, selectedModel, t, wire]);

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
        {!modelDb ? (
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
        ) : (
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
                          <code>
                            {r.forward}: {r.source} → {r.target}
                          </code>
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

            <h3>{t('query.title')}</h3>
            <label htmlFor="relate">{t('query.relateLabel')}</label>
            <input
              id="relate"
              value={relateForward}
              onChange={(e) => setRelateForward(e.target.value)}
              placeholder={t('query.relatePlaceholder')}
            />
            <div className="actions">
              <button
                type="button"
                disabled={busy || !wire || !selectedModel}
                onClick={() => void runQuery()}
              >
                {t('query.run')}
              </button>
            </div>

            <h3>{t('query.protocolTitle')}</h3>
            <p className="hint">{t('query.protocolHint')}</p>
            <div className="actions">
              <button
                type="button"
                disabled={busy || !wire || !selectedModel}
                onClick={() => void runQueryViaApply()}
              >
                {t('query.runViaApply')}
              </button>
            </div>

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
        <h2>{t('result.title')}</h2>
        {error && <pre className="err">{error}</pre>}
        {!error && result !== null && <pre>{JSON.stringify(result, null, 2)}</pre>}
        {!error && result === null && !busy && <p className="meta">{t('result.empty')}</p>}
        {busy && <p className="meta">{t('result.loading')}</p>}
      </main>
    </div>
  );
}
