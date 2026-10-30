import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { RemoteModelDBClient } from '@mode-db/sdk';
import {
  RemoteModelDBClient as RClient,
  getBrowserSession,
  pairBrowserSession,
} from '@mode-db/sdk';
import { ensureDesignerCatalog } from '../bootstrap/designer-storage-init.js';
import { seedDefaultWorkspaceRecords } from '../bootstrap/seed-workspace-rows.js';
import {
  getStoredHost,
  getHostedBrowserRole,
  getStoredLastLibrary,
  getStoredPort,
  getStoredToken,
  getPairingLaunch,
  clearPairingLaunch,
  clearSessionToken,
  isBrowserSessionMode,
  isSecurityCenterActive,
  logoutCurrentBrowserSession,
  persistSecurityCenterActive,
  persistBrowserSessionMode,
  persistConnectionFields,
  persistLastLibrary,
  persistPublicBaseUrl,
  persistSessionToken,
  persistToken,
} from '../config/connection-prefs.js';
import { connectionErrorMessage } from '../config/connection-error.js';
import { FIXED_MODEL_DESIGNER_DATABASE } from '../config/fixed-database.js';
import { withTimeout } from '../engine/async-timeout.js';
import { ensureDesignerWorkspaceSession } from '../engine/workspace-session.js';
import { useDesigner } from '../context/designer-context.js';
import {
  importEngineCatalogIntoDesignerDb,
  readBusinessCatalog,
} from '../sync/engine-catalog-import.js';
import {
  ensureLibraryRecord,
  formatLibraryLabel,
  getLibraryByCode,
  listLibraryRegistry,
  mergeLibraryRegistryWithDbNames,
  updateLibraryMetadata,
} from '../sync/library-registry.js';
import type { LibraryRegistryRecord } from '../types/library-registry.js';
import { LibraryRegistryForm } from './LibraryRegistryForm.js';
import { SecurityCenterWorkspace } from './SecurityCenterWorkspace.js';
import { LanguageSelector } from './LanguageSelector.js';
import { BrowserIdentityPanel } from './BrowserIdentityPanel.js';
import { isValidUniqueName } from '../utils/name-validation.js';

const CONNECT_MS = 45_000;
const OPEN_MS = 90_000;

export interface ConnectionFlowProps {
  onEditorReady: (
    client: RemoteModelDBClient,
    libraryName: string,
    catalog?: import('@mode-db/sdk').ManagementCatalogResponse,
    libraryMeta?: { name: Record<string, string> },
  ) => void;
}

type LibraryEditorMode = 'existing' | 'create';

function emptyDraft(): {
  code: string;
  name: Record<string, string>;
  description: Record<string, string>;
} {
  return { code: '', name: {}, description: {} };
}

/** 连接门：枚举逻辑库、维护基本信息、打开画布。 */
export function ConnectionFlow(props: ConnectionFlowProps): ReactElement {
  const { i18n, asyncOps } = useDesigner();
  const [, bump] = useState(0);
  useEffect(() => i18n.subscribe(() => bump((n) => n + 1)), [i18n]);

  const designerClientRef = useRef<RemoteModelDBClient | null>(null);
  const launch = getPairingLaunch();
  const [browserSession, setBrowserSession] = useState(isBrowserSessionMode);
  const [pairingCode, setPairingCode] = useState(launch?.code ?? '');
  const launched = useRef(false);
  const [securityAdmin, setSecurityAdmin] = useState(false);

  const [step, setStep] = useState<'credentials' | 'library' | 'opening'>('credentials');
  const [host, setHost] = useState(
    () => launch?.host ?? getStoredHost(import.meta.env.VITE_MODE_DB_HOST ?? '127.0.0.1'),
  );
  const [port, setPort] = useState(
    () => launch?.port ?? getStoredPort(Number(import.meta.env.VITE_MODE_DB_PORT ?? 9090) || 9090),
  );
  const [token, setToken] = useState(() => getStoredToken(''));
  const [libraries, setLibraries] = useState<readonly LibraryRegistryRecord[]>([]);
  const [selectedDb, setSelectedDb] = useState(() =>
    getStoredLastLibrary(FIXED_MODEL_DESIGNER_DATABASE),
  );
  const [editorMode, setEditorMode] = useState<LibraryEditorMode>('existing');
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [openingDetail, setOpeningDetail] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saveHint, setSaveHint] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      try {
        designerClientRef.current?.close();
      } catch {
        /* ignore */
      }
      designerClientRef.current = null;
    };
  }, []);

  const applyRecordToDraft = useCallback((rec: LibraryRegistryRecord): void => {
    setDraft({
      code: rec.code,
      name: { ...rec.name },
      description: { ...rec.description },
    });
  }, []);

  useEffect(() => {
    if (editorMode !== 'existing') {
      return;
    }
    const rec = libraries.find((l) => l.code === selectedDb);
    if (rec) {
      applyRecordToDraft(rec);
    }
  }, [editorMode, selectedDb, libraries, applyRecordToDraft]);

  const refreshLibraries = useCallback(
    async (client: RemoteModelDBClient, dbNames: readonly string[]): Promise<void> => {
      const registry = await listLibraryRegistry(client);
      setLibraries(mergeLibraryRegistryWithDbNames(dbNames, registry));
    },
    [],
  );

  const fetchDatabases = useCallback(
    async (publicKeySession = false): Promise<void> => {
      const connectionHost = publicKeySession ? location.origin : host.trim();
      const connectionPort = publicKeySession ? Number(location.port) || 443 : port;
      if (publicKeySession) {
        setHost(connectionHost);
        setPort(connectionPort);
      }
      setErr(null);
      setSaveHint(null);
      setBusy(true);
      try {
        const sessionMode = publicKeySession || browserSession;
        if (publicKeySession) {
          setBrowserSession(true);
          setToken('');
        }
        persistBrowserSessionMode(sessionMode);
        if (sessionMode) {
          const endpoint = { host: connectionHost, port: connectionPort };
          let session;
          if (!publicKeySession && pairingCode.trim()) {
            session = await pairBrowserSession(endpoint, pairingCode.trim());
            clearPairingLaunch();
            setPairingCode('');
          } else {
            session = await getBrowserSession(endpoint);
          }
          if (session.securityAdmin === true) {
            persistConnectionFields(connectionHost, connectionPort, FIXED_MODEL_DESIGNER_DATABASE);
            clearSessionToken();
            persistSecurityCenterActive(true);
            setSecurityAdmin(true);
            return;
          }
        }
        persistSecurityCenterActive(false);
        const list = await withTimeout(
          RClient.listDatabases({
            host: connectionHost,
            port: connectionPort,
            token: publicKeySession ? '' : token.trim(),
            browserSession: sessionMode,
          }),
          CONNECT_MS,
          i18n.t('errors', 'connectTimeout'),
        );
        void RClient.getManagementStatus({
          host: connectionHost,
          port: connectionPort,
          token: token.trim(),
          browserSession: isBrowserSessionMode(),
        })
          .then((status) => persistPublicBaseUrl(status.publicBaseUrl ?? ''))
          .catch(() => {
            // Older servers do not expose publicBaseUrl; host/port remains the fallback.
          });
        const dbNames = list
          .filter((d) => d.name !== FIXED_MODEL_DESIGNER_DATABASE)
          .map((d) => d.name);

        const client = await withTimeout(
          ensureDesignerWorkspaceSession({
            host: connectionHost,
            port: connectionPort,
            token: token.trim(),
            browserSession: isBrowserSessionMode(),
            designerWorkspace: FIXED_MODEL_DESIGNER_DATABASE,
          }),
          CONNECT_MS,
          i18n.t('errors', 'connectTimeout'),
        );
        try {
          designerClientRef.current?.close();
        } catch {
          /* ignore */
        }
        designerClientRef.current = client;

        await ensureDesignerCatalog(client);
        await refreshLibraries(client, dbNames);

        if (dbNames.length > 0 && !dbNames.includes(selectedDb)) {
          setSelectedDb(dbNames[0]!);
        }
        setEditorMode('existing');
        setStep('library');
        persistConnectionFields(connectionHost, connectionPort, FIXED_MODEL_DESIGNER_DATABASE);
        persistToken(publicKeySession ? '' : token.trim());
      } catch (e) {
        persistSecurityCenterActive(false);
        setErr(connectionErrorMessage(e, i18n));
      } finally {
        setBusy(false);
      }
    },
    [host, port, token, selectedDb, i18n, refreshLibraries, browserSession, pairingCode],
  );

  useEffect(() => {
    if ((launch || isSecurityCenterActive()) && !launched.current) {
      launched.current = true;
      void fetchDatabases();
    }
  }, [launch, fetchDatabases]);

  const saveLibraryDetails = useCallback(async (): Promise<void> => {
    const client = designerClientRef.current;
    if (!client) {
      return;
    }
    setErr(null);
    setSaveHint(null);
    setBusy(true);
    try {
      if (editorMode === 'create') {
        const code = draft.code.trim();
        if (!code || !isValidUniqueName(code)) {
          setErr(i18n.t('ui', 'nameInvalidFormat'));
          return;
        }
        if (libraries.some((l) => l.code === code)) {
          setErr(i18n.t('errors', 'libraryDuplicateCode'));
          return;
        }
        await withTimeout(
          RClient.createDatabase({
            host: host.trim(),
            port,
            token: token.trim(),
            browserSession: isBrowserSessionMode(),
            name: code,
          }),
          CONNECT_MS,
          i18n.t('errors', 'connectTimeout'),
        );
        await ensureLibraryRecord(client, {
          code,
          name: draft.name,
          description: draft.description,
        });
        const list = await RClient.listDatabases({
          host: host.trim(),
          port,
          token: token.trim(),
          browserSession: isBrowserSessionMode(),
        });
        const dbNames = list
          .filter((d) => d.name !== FIXED_MODEL_DESIGNER_DATABASE)
          .map((d) => d.name);
        await refreshLibraries(client, dbNames);
        setSelectedDb(code);
        setEditorMode('existing');
        setSaveHint(i18n.t('ui', 'libraryCreateDone'));
        return;
      }

      const code = selectedDb.trim();
      if (!code) {
        return;
      }
      const rec = libraries.find((l) => l.code === code);
      const next = await updateLibraryMetadata(
        client,
        { id: rec?.id ?? '', code },
        { name: draft.name, description: draft.description },
      );
      const list = await RClient.listDatabases({
        host: host.trim(),
        port,
        token: token.trim(),
        browserSession: isBrowserSessionMode(),
      });
      const dbNames = list
        .filter((d) => d.name !== FIXED_MODEL_DESIGNER_DATABASE)
        .map((d) => d.name);
      await refreshLibraries(client, dbNames);
      applyRecordToDraft(next);
      setSaveHint(i18n.t('ui', 'librarySaveDone'));
    } catch (e) {
      setErr(connectionErrorMessage(e, i18n));
    } finally {
      setBusy(false);
    }
  }, [
    editorMode,
    draft,
    libraries,
    selectedDb,
    host,
    port,
    token,
    i18n,
    refreshLibraries,
    applyRecordToDraft,
  ]);

  const openLibrary = useCallback(async (): Promise<void> => {
    const name = selectedDb.trim();
    if (!name || (!browserSession && !token.trim())) {
      window.alert(i18n.t('errors', 'tokenRequired'));
      return;
    }
    setErr(null);
    setSaveHint(null);
    setBusy(true);
    setStep('opening');
    let client: RemoteModelDBClient | undefined;
    let connectOk = false;
    let catalog: Awaited<ReturnType<typeof readBusinessCatalog>> | undefined;
    let openedLibraryName: Record<string, string> | null = null;
    const meta = { name: { ...draft.name }, description: { ...draft.description } };
    try {
      client = designerClientRef.current ?? undefined;
      if (!client) {
        client = await withTimeout(
          ensureDesignerWorkspaceSession({
            host: host.trim(),
            port,
            token: token.trim(),
            browserSession: isBrowserSessionMode(),
            designerWorkspace: FIXED_MODEL_DESIGNER_DATABASE,
          }),
          CONNECT_MS,
          i18n.t('errors', 'connectTimeout'),
        );
        designerClientRef.current = client;
      }
      connectOk = true;
      await withTimeout(
        asyncOps.run(
          'openLibrary',
          async () => {
            await ensureDesignerCatalog(client!, (p) => {
              setOpeningDetail(`${p.stepIndex}/${p.stepTotal} ${p.detail}`);
            });
            await seedDefaultWorkspaceRecords(client!, name, meta);
            const rec = await getLibraryByCode(client!, name);
            openedLibraryName = rec?.name ?? null;
            setOpeningDetail(i18n.t('ui', 'asyncOp_openLibraryDetail', { name }));
            catalog = await readBusinessCatalog({
              host: host.trim(),
              port,
              token: token.trim(),
              browserSession: isBrowserSessionMode(),
              businessDb: name,
            });
            const report = await importEngineCatalogIntoDesignerDb(client!, name, catalog);
            if (report.insertedModels > 0 || report.insertedRelations > 0) {
              setOpeningDetail(
                i18n.t('ui', 'asyncOp_openLibraryImported', {
                  models: String(report.insertedModels),
                  relations: String(report.insertedRelations),
                }),
              );
            }
          },
          { detail: name },
        ),
        OPEN_MS,
        i18n.t('errors', 'bootstrapTimeout'),
      );
      persistConnectionFields(host.trim(), port, FIXED_MODEL_DESIGNER_DATABASE);
      persistLastLibrary(name);
      persistSessionToken(token.trim());
      persistToken(token.trim());
      props.onEditorReady(
        client,
        name,
        catalog,
        openedLibraryName ? { name: openedLibraryName } : undefined,
      );
    } catch (e) {
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      if (designerClientRef.current === client) {
        designerClientRef.current = null;
      }
      const detail = connectionErrorMessage(e, i18n);
      const title = connectOk
        ? i18n.t('errors', 'bootstrapFailed')
        : i18n.t('errors', 'connectFailed');
      window.alert(`${title}\n\n${i18n.t('errors', 'errorDetails')}\n${detail}`);
      setStep('library');
    } finally {
      setBusy(false);
      setOpeningDetail(null);
    }
  }, [host, port, token, selectedDb, draft, libraries, i18n, props, asyncOps, browserSession]);

  const fieldClass = 'designer-connection-field';
  const locale = i18n.locale;

  if (securityAdmin) {
    return (
      <>
        {err ? (
          <p role="alert" className="security-center-audit-error">
            {err}
          </p>
        ) : null}
        <SecurityCenterWorkspace
          onDisconnect={() => {
            void logoutCurrentBrowserSession()
              .then(() => {
                clearSessionToken();
                setSecurityAdmin(false);
                setStep('credentials');
                setErr(null);
              })
              .catch(() => setErr(i18n.t('ui', 'sessionLogoutFailed')));
          }}
        />
      </>
    );
  }

  return (
    <div className="designer-connection-flow designer-scrollbar-hide" lang={locale}>
      <div className="designer-connection-toolbar">
        <span className="designer-connection-brand">Model Designer</span>
        <LanguageSelector />
      </div>
      <div className="designer-connection-card designer-glass-panel">
        <h1>{i18n.t('ui', 'gateTitle')}</h1>
        <p className="designer-connection-lead">{i18n.t('ui', 'gateHintStorage')}</p>

        {step === 'credentials' && (
          <>
            {getHostedBrowserRole() === 'data' && (
              <BrowserIdentityPanel
                connecting={busy}
                onContinue={() => void fetchDatabases(true)}
              />
            )}
            <details className="designer-identity-details" open={getHostedBrowserRole() !== 'data'}>
              <summary>{i18n.t('ui', 'identity_legacy')}</summary>
              <label className={fieldClass}>
                <span>{i18n.t('ui', 'host')}</span>
                <input
                  className="designer-input"
                  value={host}
                  placeholder="127.0.0.1 / https://db.example.com"
                  title={i18n.t('errors', 'security_transportHint')}
                  onChange={(e) => setHost(e.target.value)}
                />
              </label>
              <label className={fieldClass}>
                <span>{i18n.t('ui', 'port')}</span>
                <input
                  className="designer-input"
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                />
              </label>
              <label className={fieldClass}>
                <span>{i18n.t('ui', 'sessionAuthMode')}</span>
                <select
                  className="designer-select"
                  value={browserSession ? 'browser' : 'token'}
                  onChange={(e) => {
                    setBrowserSession(e.target.value === 'browser');
                    setToken('');
                  }}
                >
                  <option value="browser">{i18n.t('ui', 'sessionBrowserMode')}</option>
                  <option value="token">{i18n.t('ui', 'sessionTokenMode')}</option>
                </select>
              </label>
              <label className={fieldClass}>
                <span>{i18n.t('ui', browserSession ? 'sessionPairingCode' : 'connectToken')}</span>
                <input
                  className="designer-input"
                  type="password"
                  value={browserSession ? pairingCode : token}
                  onChange={(e) =>
                    browserSession ? setPairingCode(e.target.value) : setToken(e.target.value)
                  }
                  autoComplete="off"
                />
              </label>
              <p className="designer-connection-lead">
                {browserSession
                  ? i18n.t('ui', 'sessionPairingHint')
                  : i18n.t('errors', 'security_memoryOnly')}
              </p>
              {err ? (
                <div className="designer-connection-error" role="alert">
                  {err}
                </div>
              ) : null}
              <div className="designer-connection-actions">
                <button
                  type="button"
                  className="designer-btn designer-btn-primary"
                  disabled={busy}
                  onClick={() => void fetchDatabases()}
                >
                  {busy ? i18n.t('ui', 'connecting') : i18n.t('ui', 'btnListLibraries')}
                </button>
              </div>
            </details>
            {getHostedBrowserRole() === 'data' && err && (
              <div role="alert" className="designer-connection-error">
                {err}
              </div>
            )}
          </>
        )}

        {step === 'library' && (
          <>
            <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px', textAlign: 'center' }}>
              {i18n.t('ui', 'pickLibraryHint')}
            </p>
            {editorMode === 'existing' ? (
              <label className={fieldClass}>
                <span>{i18n.t('ui', 'librarySelectLabel')}</span>
                <select
                  className="designer-select"
                  style={{ width: '100%', padding: '10px 12px', fontSize: 13 }}
                  value={selectedDb}
                  disabled={busy}
                  onChange={(e) => setSelectedDb(e.target.value)}
                >
                  {libraries.map((rec) => (
                    <option key={rec.code} value={rec.code}>
                      {formatLibraryLabel(rec, locale)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div style={{ display: 'flex', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`designer-btn${editorMode === 'existing' ? ' designer-btn-primary' : ''}`}
                disabled={busy}
                onClick={() => {
                  setEditorMode('existing');
                  setErr(null);
                  setSaveHint(null);
                  const rec = libraries.find((l) => l.code === selectedDb);
                  if (rec) {
                    applyRecordToDraft(rec);
                  }
                }}
              >
                {i18n.t('ui', 'libraryModeExisting')}
              </button>
              <button
                type="button"
                className={`designer-btn${editorMode === 'create' ? ' designer-btn-primary' : ''}`}
                disabled={busy}
                onClick={() => {
                  setEditorMode('create');
                  setErr(null);
                  setSaveHint(null);
                  setDraft(emptyDraft());
                }}
              >
                {i18n.t('ui', 'libraryModeCreate')}
              </button>
            </div>

            <div
              style={{
                marginTop: 8,
                padding: '12px 0 0',
                borderTop: '1px solid rgba(15, 23, 42, 0.08)',
              }}
            >
              <p
                className="designer-panel-section-title"
                style={{ margin: '0 0 10px', fontSize: 13 }}
              >
                {i18n.t('ui', 'libraryDetailsTitle')}
              </p>
              <LibraryRegistryForm
                code={editorMode === 'create' ? draft.code : selectedDb}
                codeReadOnly={editorMode === 'existing'}
                name={draft.name}
                description={draft.description}
                disabled={busy}
                codeLabel={i18n.t('ui', 'libraryCode')}
                codePlaceholder={i18n.t('ui', 'libraryCodePlaceholder')}
                codeInvalidHint={i18n.t('ui', 'nameInvalidFormat')}
                displayNameLabel={i18n.t('ui', 'libraryDisplayNameI18n')}
                descriptionLabel={i18n.t('ui', 'libraryDescriptionI18n')}
                pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
                addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
                onCodeChange={(code) => setDraft((d) => ({ ...d, code }))}
                onNameCommit={(name) => setDraft((d) => ({ ...d, name }))}
                onDescriptionCommit={(description) => setDraft((d) => ({ ...d, description }))}
              />
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginTop: 12,
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  className="designer-btn"
                  disabled={busy}
                  onClick={() => void saveLibraryDetails()}
                >
                  {editorMode === 'create'
                    ? i18n.t('ui', 'libraryCreateSave')
                    : i18n.t('ui', 'librarySave')}
                </button>
                {saveHint ? (
                  <span style={{ fontSize: 12, color: '#64748b' }}>{saveHint}</span>
                ) : null}
              </div>
            </div>

            {err ? (
              <div style={{ color: '#b91c1c', fontSize: 12, marginTop: 10 }}>{err}</div>
            ) : null}

            <div className="designer-connection-actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="designer-btn"
                disabled={busy}
                onClick={() => setStep('credentials')}
              >
                {i18n.t('ui', 'btnBack')}
              </button>
              <button
                type="button"
                className="designer-btn designer-btn-primary"
                disabled={busy || editorMode === 'create' || !selectedDb.trim()}
                onClick={() => void openLibrary()}
              >
                {i18n.t('ui', 'btnOpenLibrary')}
              </button>
            </div>
          </>
        )}

        {step === 'opening' && (
          <div style={{ fontSize: 13, color: '#475569', textAlign: 'center' }}>
            <div>{i18n.t('ui', 'bootstrapRunning')}</div>
            {openingDetail ? (
              <code style={{ display: 'block', marginTop: 10, color: '#94a3b8', fontSize: 11 }}>
                {openingDetail}
              </code>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
