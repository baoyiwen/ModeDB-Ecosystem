import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { RemoteModelDBClient } from '@mode-db/sdk';
import { RemoteModelDBClient as RClient } from '@mode-db/sdk';
import { ensureDesignerCatalog } from '../bootstrap/designer-storage-init.js';
import { seedDefaultWorkspaceRecords } from '../bootstrap/seed-workspace-rows.js';
import {
  getRememberToken,
  getStoredHost,
  getStoredLastLibrary,
  getStoredPort,
  getStoredWorkspace,
  getStoredToken,
  persistConnectionFields,
  persistLastLibrary,
  persistToken,
  setRememberToken,
} from '../config/connection-prefs.js';
import { FIXED_MODEL_DESIGNER_DATABASE } from '../config/fixed-database.js';
import { withTimeout } from '../engine/async-timeout.js';
import { openWorkspaceSession } from '../engine/workspace-session.js';
import { useDesigner } from '../context/designer-context.js';

const CONNECT_MS = 45_000;
const OPEN_MS = 90_000;

export interface ConnectionFlowProps {
  onEditorReady: (client: RemoteModelDBClient, libraryName: string) => void;
}

/**
 * 两步：1）校验服务器并枚举逻辑库；2）选择或新建逻辑库后建立 WebSocket 并完成 catalog 自举。
 */
export function ConnectionFlow(props: ConnectionFlowProps): ReactElement {
  const { i18n } = useDesigner();
  const [, bump] = useState(0);
  useEffect(() => i18n.subscribe(() => bump((n) => n + 1)), [i18n]);

  const [step, setStep] = useState<'credentials' | 'library' | 'opening'>('credentials');
  const [host, setHost] = useState(() =>
    getStoredHost(import.meta.env.VITE_MODE_DB_HOST ?? '127.0.0.1'),
  );
  const [port, setPort] = useState(() =>
    getStoredPort(Number(import.meta.env.VITE_MODE_DB_PORT ?? 9090) || 9090),
  );
  const [token, setToken] = useState(() =>
    getStoredToken(import.meta.env.VITE_MODE_DB_TOKEN ?? ''),
  );
  const [rememberToken, setRememberTokenState] = useState(getRememberToken);
  const [databases, setDatabases] = useState<readonly { name: string }[]>([]);
  const [selectedDb, setSelectedDb] = useState(() =>
    getStoredLastLibrary(FIXED_MODEL_DESIGNER_DATABASE),
  );
  const [newDbName, setNewDbName] = useState('');
  const [busy, setBusy] = useState(false);
  const [openingDetail, setOpeningDetail] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const fetchDatabases = useCallback(async (): Promise<void> => {
    setErr(null);
    setBusy(true);
    try {
      const list = await withTimeout(
        RClient.listDatabases({ host: host.trim(), port, token: token.trim() }),
        CONNECT_MS,
        i18n.t('errors', 'connectTimeout'),
      );
      setDatabases(list);
      if (list.length > 0 && !list.some((d) => d.name === selectedDb)) {
        setSelectedDb(list[0].name);
      }
      setStep('library');
      persistConnectionFields(host.trim(), port, getStoredWorkspace(FIXED_MODEL_DESIGNER_DATABASE));
      if (rememberToken) {
        persistToken(token.trim());
      } else {
        persistToken('');
      }
      setRememberToken(rememberToken);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [host, port, token, rememberToken, selectedDb, i18n]);

  const openLibrary = useCallback(async (): Promise<void> => {
    const name = selectedDb.trim();
    if (!name || !token.trim()) {
      window.alert(i18n.t('errors', 'tokenRequired'));
      return;
    }
    setErr(null);
    setBusy(true);
    setStep('opening');
    let client: RemoteModelDBClient | undefined;
    let connectOk = false;
    try {
      client = await withTimeout(
        openWorkspaceSession({
          host: host.trim(),
          port,
          token: token.trim(),
          workspace: name,
        }),
        CONNECT_MS,
        i18n.t('errors', 'connectTimeout'),
      );
      connectOk = true;
      await withTimeout(
        (async () => {
          await ensureDesignerCatalog(client!, (p) => {
            setOpeningDetail(`${p.stepIndex}/${p.stepTotal} ${p.detail}`);
          });
          await seedDefaultWorkspaceRecords(client!, name);
        })(),
        OPEN_MS,
        i18n.t('errors', 'bootstrapTimeout'),
      );
      persistConnectionFields(host.trim(), port, name);
      persistLastLibrary(name);
      if (rememberToken) {
        persistToken(token.trim());
      }
      setRememberToken(rememberToken);
      props.onEditorReady(client, name);
    } catch (e) {
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      const detail = e instanceof Error ? e.message : String(e);
      const title = connectOk
        ? i18n.t('errors', 'bootstrapFailed')
        : i18n.t('errors', 'connectFailed');
      window.alert(`${title}\n\n${i18n.t('errors', 'errorDetails')}\n${detail}`);
      setStep('library');
    } finally {
      setBusy(false);
      setOpeningDetail(null);
    }
  }, [host, port, token, selectedDb, rememberToken, i18n, props]);

  const createDatabase = useCallback(async (): Promise<void> => {
    const name = newDbName.trim();
    if (!name || !token.trim()) {
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await withTimeout(
        RClient.createDatabase({
          host: host.trim(),
          port,
          token: token.trim(),
          name,
        }),
        CONNECT_MS,
        i18n.t('errors', 'connectTimeout'),
      );
      const list = await RClient.listDatabases({
        host: host.trim(),
        port,
        token: token.trim(),
      });
      setDatabases(list);
      setSelectedDb(name);
      setNewDbName('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [host, port, token, newDbName, i18n]);

  const fieldClass = 'designer-connection-field';

  return (
    <div className="designer-connection-flow designer-scrollbar-hide">
      <div className="designer-connection-card designer-glass-panel">
        <h1>{i18n.t('ui', 'gateTitle')}</h1>
        <p className="designer-connection-lead">{i18n.t('ui', 'gateHintStorage')}</p>

        {step === 'credentials' && (
          <>
            <label className={fieldClass}>
              <span>{i18n.t('ui', 'host')}</span>
              <input
                className="designer-input"
                value={host}
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
              <span>{i18n.t('ui', 'connectToken')}</span>
              <input
                className="designer-input"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: '#475569',
              }}
            >
              <input
                type="checkbox"
                checked={rememberToken}
                onChange={(e) => setRememberTokenState(e.target.checked)}
              />
              {i18n.t('ui', 'rememberToken')}
            </label>
            {err && <div style={{ color: '#b91c1c', fontSize: 12 }}>{err}</div>}
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
          </>
        )}

        {step === 'library' && (
          <>
            <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px', textAlign: 'center' }}>
              {i18n.t('ui', 'pickLibraryHint')}
            </p>
            <label className={fieldClass}>
              <select
                className="designer-select"
                style={{ width: '100%', padding: '10px 12px', fontSize: 13 }}
                value={selectedDb}
                onChange={(e) => setSelectedDb(e.target.value)}
              >
                {databases.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ display: 'flex', gap: 8, width: '100%' }}>
              <input
                className="designer-input"
                placeholder={i18n.t('ui', 'newDatabasePlaceholder')}
                value={newDbName}
                onChange={(e) => setNewDbName(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="designer-btn"
                disabled={busy}
                onClick={() => void createDatabase()}
              >
                {i18n.t('ui', 'btnCreateDb')}
              </button>
            </div>
            <div className="designer-connection-actions">
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
                disabled={busy}
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
            {openingDetail && (
              <code style={{ display: 'block', marginTop: 10, color: '#94a3b8', fontSize: 11 }}>
                {openingDetail}
              </code>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
