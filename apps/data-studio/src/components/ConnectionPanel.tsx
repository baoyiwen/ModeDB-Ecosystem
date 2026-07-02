import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ModelDB, type ManagementCatalogResponse, type RemoteModelDBClient } from '@mode-db/sdk';
import {
  getStoredHost,
  getStoredLibrary,
  getStoredPort,
  getStoredToken,
  persistConnection,
  persistLibrary,
} from '../config/connection-prefs.js';
import { openLibrarySession } from '../config/open-library-session.js';
import { useStudio, useStudioLocale, type StudioLocale } from '../context/studio-context.js';

export interface ConnectionPanelProps {
  onConnected: (
    client: RemoteModelDBClient,
    library: string,
    catalog: ManagementCatalogResponse,
  ) => void;
}

/** Minimal Engine connection gate for Data Studio. */
export function ConnectionPanel(props: ConnectionPanelProps): ReactElement {
  const { onConnected } = props;
  const { i18n, notify } = useStudio();
  useStudioLocale();

  const [host, setHost] = useState(() =>
    getStoredHost(import.meta.env.VITE_MODE_DB_HOST ?? '127.0.0.1'),
  );
  const [port, setPort] = useState(() =>
    getStoredPort(Number(import.meta.env.VITE_MODE_DB_PORT ?? 8765) || 8765),
  );
  const [token, setToken] = useState(() =>
    getStoredToken(import.meta.env.VITE_MODE_DB_TOKEN ?? ''),
  );
  const [libraries, setLibraries] = useState<readonly string[]>([]);
  const [library, setLibrary] = useState(() => getStoredLibrary(''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<'credentials' | 'library'>('credentials');

  const listLibraries = useCallback(async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      persistConnection(host, port, token);
      const db = new ModelDB({ host: host.trim(), port, token: token.trim() });
      const names = await db.listDatabases();
      setLibraries(names);
      if (names.length > 0 && !names.includes(library)) {
        setLibrary(names[0]!);
      }
      setStep('library');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      notify.error(i18n.t('connect'), msg);
    } finally {
      setBusy(false);
    }
  }, [host, port, token, library, notify, i18n]);

  const openLibrary = useCallback(async (): Promise<void> => {
    const name = library.trim();
    if (!name) {
      setErr(i18n.t('selectLibrary'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      persistConnection(host, port, token);
      persistLibrary(name);
      const opened = await openLibrarySession({
        host: host.trim(),
        port,
        token: token.trim(),
        library: name,
      });
      notify.success(i18n.t('openLibrary'), name);
      onConnected(opened.client, opened.library, opened.catalog);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      notify.error(i18n.t('openLibrary'), msg);
    } finally {
      setBusy(false);
    }
  }, [host, port, token, library, onConnected, notify, i18n]);

  useEffect(() => {
    if (step === 'library' && libraries.length === 0) {
      setStep('credentials');
    }
  }, [step, libraries.length]);

  return (
    <div className="studio-connect-wrap">
      <div className="studio-connect-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <h1 style={{ margin: '0 0 8px', fontSize: 20 }}>{i18n.t('appTitle')}</h1>
          <select
            className="studio-select"
            value={i18n.locale}
            aria-label={i18n.t('locale')}
            onChange={(e) => i18n.setLocale(e.target.value as StudioLocale)}
          >
            <option value="en">EN</option>
            <option value="zh">中文</option>
            <option value="ja">JA</option>
          </select>
        </div>
        <p style={{ margin: '0 0 20px', color: '#64748b', fontSize: 13 }}>
          {i18n.t('appSubtitle')}
        </p>

        {step === 'credentials' ? (
          <>
            <label className="studio-field">
              {i18n.t('host')}
              <input
                className="studio-input"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="studio-field">
              {i18n.t('port')}
              <input
                className="studio-input"
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value) || 0)}
              />
            </label>
            <label className="studio-field">
              {i18n.t('token')}
              <input
                className="studio-input"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              className="studio-btn-primary"
              disabled={busy || !token.trim()}
              onClick={() => void listLibraries()}
            >
              {busy ? i18n.t('connecting') : i18n.t('connect')}
            </button>
          </>
        ) : (
          <>
            <label className="studio-field">
              {i18n.t('library')}
              <select
                className="studio-input"
                value={library}
                onChange={(e) => setLibrary(e.target.value)}
              >
                {libraries.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <div className="studio-btn-row">
              <button
                type="button"
                className="studio-btn"
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => setStep('credentials')}
              >
                {i18n.t('back')}
              </button>
              <button
                type="button"
                className="studio-btn-primary"
                style={{ flex: 2 }}
                disabled={busy}
                onClick={() => void openLibrary()}
              >
                {busy ? i18n.t('opening') : i18n.t('openLibrary')}
              </button>
            </div>
          </>
        )}

        {err ? (
          <p className="studio-error-text" role="alert">
            {err}
          </p>
        ) : null}
      </div>
    </div>
  );
}
