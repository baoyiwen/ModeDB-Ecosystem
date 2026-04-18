import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { ModelDB, type RemoteModelDBClient } from '@mode-db/sdk';

const LS = {
  host: 'modedb.playground.host',
  port: 'modedb.playground.port',
  token: 'modedb.playground.token',
  database: 'modedb.playground.database',
  model: 'modedb.playground.model',
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

export function App(): ReactElement {
  const [host, setHost] = useState(() =>
    load(LS.host, import.meta.env.VITE_DEFAULT_HOST ?? '127.0.0.1'),
  );
  const [port, setPort] = useState(() =>
    load(LS.port, import.meta.env.VITE_DEFAULT_PORT ?? '8765'),
  );
  const [token, setToken] = useState(() =>
    load(LS.token, import.meta.env.VITE_DEFAULT_TOKEN ?? ''),
  );
  const [database, setDatabase] = useState(() =>
    load(LS.database, import.meta.env.VITE_DEFAULT_DATABASE ?? 'pipe'),
  );
  const [modelName, setModelName] = useState(() =>
    load(LS.model, import.meta.env.VITE_DEFAULT_MODEL ?? 'Pump'),
  );

  const [webGpu, setWebGpu] = useState<string>('…');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [databases, setDatabases] = useState<string[] | null>(null);

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
  useEffect(() => {
    save(LS.database, database);
  }, [database]);
  useEffect(() => {
    save(LS.model, modelName);
  }, [modelName]);

  const endpoint = useMemo(() => `${host}:${port}`, [host, port]);

  const runQuery = useCallback(async (): Promise<void> => {
    setError(null);
    setResult(null);
    const p = Number(port);
    if (!token.trim() || !database.trim() || !modelName.trim() || !Number.isFinite(p)) {
      setError('Host, port, token, database, and model are required.');
      return;
    }
    setBusy(true);
    let client: RemoteModelDBClient | undefined;
    try {
      const db = new ModelDB({ host: host.trim(), port: p, token: token.trim() });
      client = await db.use(database.trim());
      const rows = await client.model(modelName.trim()).query().execute();
      setResult(serializeRows(rows));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      client?.close();
      setBusy(false);
    }
  }, [database, host, modelName, port, token]);

  const listDatabases = useCallback(async (): Promise<void> => {
    setError(null);
    setDatabases(null);
    const p = Number(port);
    if (!token.trim() || !Number.isFinite(p)) {
      setError('Host, port, and token are required.');
      return;
    }
    setBusy(true);
    try {
      const db = new ModelDB({ host: host.trim(), port: p, token: token.trim() });
      setDatabases(await db.listDatabases());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [host, port, token]);

  return (
    <div className="layout">
      <aside className="panel">
        <h1>ModeDB query playground</h1>
        <p className="meta">
          Engine: {endpoint} · WebGPU: {webGpu}
        </p>
        <label htmlFor="host">Host</label>
        <input
          id="host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          autoComplete="off"
        />
        <label htmlFor="port">Port</label>
        <input
          id="port"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          autoComplete="off"
        />
        <label htmlFor="token">Connect token</label>
        <input
          id="token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          type="password"
        />
        <label htmlFor="database">Logical database</label>
        <input id="database" value={database} onChange={(e) => setDatabase(e.target.value)} />
        <label htmlFor="model">Model name</label>
        <input id="model" value={modelName} onChange={(e) => setModelName(e.target.value)} />
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void listDatabases()}>
            List databases
          </button>
          <button type="button" disabled={busy} onClick={() => void runQuery()}>
            Run query
          </button>
        </div>
        {databases && databases.length >= 0 && (
          <p className="meta" style={{ marginTop: '0.75rem' }}>
            Databases: {databases.join(', ') || '(none)'}
          </p>
        )}
      </aside>
      <main className="result">
        <h2>Result</h2>
        {error && <pre style={{ borderColor: '#5c3d3d', color: '#f5b5b5' }}>{error}</pre>}
        {!error && result !== null && <pre>{JSON.stringify(result, null, 2)}</pre>}
        {!error && result === null && !busy && (
          <p className="meta">
            Run a query or list databases. Rows use SDK hydration when applicable.
          </p>
        )}
        {busy && <p className="meta">Loading…</p>}
      </main>
    </div>
  );
}
