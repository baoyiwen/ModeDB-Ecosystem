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

  const inputStyle: React.CSSProperties = {
    padding: 8,
    background: '#0f172a',
    border: '1px solid #334155',
    color: '#e2e8f0',
    width: '100%',
  };

  const shell: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: '#020617',
    color: '#e2e8f0',
    gap: 12,
    padding: 24,
  };

  return (
    <div style={shell}>
      <h1 style={{ fontSize: 20, margin: 0 }}>{i18n.t('ui', 'gateTitle')}</h1>
      <p style={{ fontSize: 13, color: '#94a3b8', maxWidth: 520, textAlign: 'center' }}>
        {i18n.t('ui', 'gateHintStorage')}
      </p>

      {step === 'credentials' && (
        <>
          <label
            style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 'min(400px, 100%)' }}
          >
            <span>{i18n.t('ui', 'host')}</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} style={inputStyle} />
          </label>
          <label
            style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 'min(400px, 100%)' }}
          >
            <span>{i18n.t('ui', 'port')}</span>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              style={inputStyle}
            />
          </label>
          <label
            style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 'min(400px, 100%)' }}
          >
            <span>{i18n.t('ui', 'connectToken')}</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              style={inputStyle}
              autoComplete="off"
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={rememberToken}
              onChange={(e) => setRememberTokenState(e.target.checked)}
            />
            {i18n.t('ui', 'rememberToken')}
          </label>
          {err && <div style={{ color: '#f87171', fontSize: 12, maxWidth: 400 }}>{err}</div>}
          <button
            type="button"
            disabled={busy}
            onClick={() => void fetchDatabases()}
            style={{ padding: '10px 20px', cursor: busy ? 'wait' : 'pointer' }}
          >
            {busy ? i18n.t('ui', 'connecting') : i18n.t('ui', 'btnListLibraries')}
          </button>
        </>
      )}

      {step === 'library' && (
        <>
          <p style={{ fontSize: 12, color: '#64748b' }}>{i18n.t('ui', 'pickLibraryHint')}</p>
          <select
            value={selectedDb}
            onChange={(e) => setSelectedDb(e.target.value)}
            style={{ ...inputStyle, maxWidth: 400 }}
          >
            {databases.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 8, width: 'min(400px, 100%)' }}>
            <input
              placeholder={i18n.t('ui', 'newDatabasePlaceholder')}
              value={newDbName}
              onChange={(e) => setNewDbName(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button type="button" disabled={busy} onClick={() => void createDatabase()}>
              {i18n.t('ui', 'btnCreateDb')}
            </button>
          </div>
          <button type="button" disabled={busy} onClick={() => setStep('credentials')}>
            {i18n.t('ui', 'btnBack')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void openLibrary()}
            style={{ padding: '10px 24px', marginTop: 8 }}
          >
            {i18n.t('ui', 'btnOpenLibrary')}
          </button>
        </>
      )}

      {step === 'opening' && (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>
          <div>{i18n.t('ui', 'bootstrapRunning')}</div>
          {openingDetail && <code style={{ color: '#cbd5e1' }}>{openingDetail}</code>}
        </div>
      )}
    </div>
  );
}
