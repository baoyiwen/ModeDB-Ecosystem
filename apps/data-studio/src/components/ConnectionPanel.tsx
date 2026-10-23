import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  RemoteModelDBClient,
  getBrowserSession,
  pairBrowserSession,
  type ManagementCatalogResponse,
  type ManagementDatabaseInfo,
} from '@mode-db/sdk';
import { formatDisplayWithUnique } from '@mode-db/data-kit';
import {
  getStoredHost,
  getStoredLibrary,
  getStoredNameDisplayMode,
  getStoredPort,
  getStoredToken,
  getPairingLaunch,
  clearPairingLaunch,
  isBrowserSessionMode,
  persistBrowserSessionMode,
  persistConnection,
  persistLibrary,
  persistNameDisplayMode,
  type NameDisplayMode,
} from '../config/connection-prefs.js';
import { openLibrarySession } from '../config/open-library-session.js';
import { connectionErrorMessage } from '../config/connection-error.js';
import { useStudio, useStudioLocale, type StudioLocale } from '../context/studio-context.js';

export interface ConnectionPanelProps {
  onConnected: (
    client: RemoteModelDBClient,
    library: string,
    catalog: ManagementCatalogResponse,
  ) => void;
}

function displayNameForLocale(
  labels: Readonly<Record<string, string>> | undefined,
  locale: string,
): string | undefined {
  const label = labels?.[locale]?.trim();
  return label && label.length > 0 ? label : undefined;
}

function databaseOptionLabel(
  info: ManagementDatabaseInfo,
  locale: string,
  mode: NameDisplayMode,
): string {
  if (mode === 'name') {
    return info.name;
  }
  return formatDisplayWithUnique(info.name, displayNameForLocale(info.displayName, locale));
}

/** Minimal Engine connection gate for Data Studio. */
export function ConnectionPanel(props: ConnectionPanelProps): ReactElement {
  const { onConnected } = props;
  const { i18n, notify } = useStudio();
  useStudioLocale();
  const launch = getPairingLaunch();
  const launched = useRef(false);
  const [browserSession, setBrowserSession] = useState(isBrowserSessionMode);
  const [pairingCode, setPairingCode] = useState(launch?.code ?? '');

  const [host, setHost] = useState(
    () => launch?.host ?? getStoredHost(import.meta.env.VITE_MODE_DB_HOST ?? '127.0.0.1'),
  );
  const [port, setPort] = useState(
    () => launch?.port ?? getStoredPort(Number(import.meta.env.VITE_MODE_DB_PORT ?? 8765) || 8765),
  );
  const [token, setToken] = useState(() => getStoredToken(''));
  const [libraries, setLibraries] = useState<readonly ManagementDatabaseInfo[]>([]);
  const [library, setLibrary] = useState(() => getStoredLibrary(''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<'credentials' | 'library'>('credentials');
  const [nameDisplayMode, setNameDisplayMode] = useState<NameDisplayMode>(() =>
    getStoredNameDisplayMode('display'),
  );

  const toggleNameDisplayMode = useCallback(() => {
    setNameDisplayMode((prev) => {
      const next: NameDisplayMode = prev === 'display' ? 'name' : 'display';
      persistNameDisplayMode(next);
      return next;
    });
  }, []);

  const listLibraries = useCallback(async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      persistBrowserSessionMode(browserSession);
      if (browserSession) {
        const endpoint = { host: host.trim(), port };
        if (pairingCode.trim()) {
          await pairBrowserSession(endpoint, pairingCode.trim());
          clearPairingLaunch();
          setPairingCode('');
        } else await getBrowserSession(endpoint);
      }
      persistConnection(host, port, token);
      const infos = await RemoteModelDBClient.listDatabases({
        host: host.trim(),
        port,
        token: token.trim(),
        browserSession,
      });
      setLibraries(infos);
      if (infos.length > 0 && !infos.some((info) => info.name === library)) {
        setLibrary(infos[0]!.name);
      }
      setStep('library');
    } catch (e) {
      const msg = connectionErrorMessage(e, i18n);
      setErr(msg);
      notify.error(i18n.t('connect'), msg);
    } finally {
      setBusy(false);
    }
  }, [host, port, token, library, notify, i18n, browserSession, pairingCode]);

  useEffect(() => {
    if (launch && !launched.current) {
      launched.current = true;
      void listLibraries();
    }
  }, [launch, listLibraries]);

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
        browserSession,
        library: name,
      });
      notify.success(i18n.t('openLibrary'), name);
      onConnected(opened.client, opened.library, opened.catalog);
    } catch (e) {
      const msg = connectionErrorMessage(e, i18n);
      setErr(msg);
      notify.error(i18n.t('openLibrary'), msg);
    } finally {
      setBusy(false);
    }
  }, [host, port, token, library, onConnected, notify, i18n, browserSession]);

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
          <button
            type="button"
            className="studio-btn studio-btn--ghost"
            aria-pressed={nameDisplayMode === 'display'}
            onClick={toggleNameDisplayMode}
          >
            {i18n.t(nameDisplayMode === 'display' ? 'nameModeDisplay' : 'nameModeUnique')}
          </button>
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
                placeholder="127.0.0.1 / https://db.example.com"
                title={i18n.t('security_transportHint')}
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
              {i18n.t('sessionAuthMode')}
              <select
                className="studio-select"
                value={browserSession ? 'browser' : 'token'}
                onChange={(e) => {
                  setBrowserSession(e.target.value === 'browser');
                  setToken('');
                }}
              >
                <option value="browser">{i18n.t('sessionBrowserMode')}</option>
                <option value="token">{i18n.t('sessionTokenMode')}</option>
              </select>
            </label>
            <label className="studio-field">
              {i18n.t(browserSession ? 'sessionPairingCode' : 'token')}
              <input
                className="studio-input"
                type="password"
                value={browserSession ? pairingCode : token}
                onChange={(e) =>
                  browserSession ? setPairingCode(e.target.value) : setToken(e.target.value)
                }
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              className="studio-btn-primary"
              disabled={busy || (!browserSession && !token.trim())}
              onClick={() => void listLibraries()}
            >
              {busy ? i18n.t('connecting') : i18n.t('connect')}
            </button>
            <p>{i18n.t(browserSession ? 'sessionPairingHint' : 'security_memoryOnly')}</p>
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
                {libraries.map((info) => (
                  <option key={info.name} value={info.name}>
                    {databaseOptionLabel(info, i18n.locale, nameDisplayMode)}
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
