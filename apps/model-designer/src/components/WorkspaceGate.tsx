import type { CSSProperties, ReactNode } from 'react';
import type { RemoteModelDBClient } from '@mode-db/sdk';
import { DesignerComponent } from './base/designer-component.js';
import { ensureDesignerCatalog } from '../bootstrap/designer-storage-init.js';
import { seedDefaultWorkspaceRecords } from '../bootstrap/seed-workspace-rows.js';
import {
  getStoredHost,
  getStoredPort,
  getStoredWorkspace,
  persistConnectionFields,
} from '../config/connection-prefs.js';
import { FIXED_MODEL_DESIGNER_DATABASE } from '../config/fixed-database.js';
import { withTimeout } from '../engine/async-timeout.js';
import { openWorkspaceSession } from '../engine/workspace-session.js';
import type { LocaleCode } from '../managers/i18n-manager.js';

export interface WorkspaceGateProps {
  onSessionOpened: () => void;
}

const CONNECT_TIMEOUT_MS = 45_000;
const BOOTSTRAP_TIMEOUT_MS = 90_000;

interface WorkspaceGateState {
  host: string;
  port: number;
  workspace: string;
  token: string;
  busy: boolean;
  bootstrapProgress: { current: number; total: number; detail: string } | null;
}

/**
 * 连接门：继承 {@link DesignerComponent}；逻辑库名固定为 {@link FIXED_MODEL_DESIGNER_DATABASE}。
 */
export class WorkspaceGate extends DesignerComponent<WorkspaceGateProps, WorkspaceGateState> {
  private i18nUnsub: (() => void) | undefined;

  constructor(props: WorkspaceGateProps) {
    super(props);
    this.state = {
      host: getStoredHost(import.meta.env.VITE_MODE_DB_HOST ?? '127.0.0.1'),
      port: getStoredPort(Number(import.meta.env.VITE_MODE_DB_PORT ?? 9090) || 9090),
      workspace: getStoredWorkspace(FIXED_MODEL_DESIGNER_DATABASE),
      token: import.meta.env.VITE_MODE_DB_TOKEN ?? '',
      busy: false,
      bootstrapProgress: null,
    };
  }

  override componentDidMount(): void {
    const { i18n } = this.managers;
    this.i18nUnsub = i18n.subscribe(() => this.forceUpdate());
  }

  override componentWillUnmount(): void {
    this.i18nUnsub?.();
  }

  private readonly shellStyle: CSSProperties = {
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

  private readonly inputStyle: CSSProperties = {
    padding: 8,
    background: '#0f172a',
    border: '1px solid #334155',
    color: '#e2e8f0',
  };

  private connect = async (): Promise<void> => {
    const { i18n, config } = this.managers;
    const { host, port, workspace, token } = this.state;
    const ws = workspace.trim();
    if (!token.trim()) {
      window.alert(i18n.t('errors', 'tokenRequired'));
      return;
    }
    if (!ws) {
      window.alert(i18n.t('errors', 'workspaceRequired'));
      return;
    }
    this.setState({ busy: true, bootstrapProgress: null });
    let client: RemoteModelDBClient | undefined;
    let connectOk = false;
    try {
      client = await withTimeout(
        openWorkspaceSession({
          host,
          port,
          token: token.trim(),
          workspace: ws,
        }),
        CONNECT_TIMEOUT_MS,
        i18n.t('errors', 'connectTimeout'),
      );
      connectOk = true;
      await withTimeout(
        (async () => {
          await ensureDesignerCatalog(client, (p) => {
            this.setState({
              bootstrapProgress: { current: p.stepIndex, total: p.stepTotal, detail: p.detail },
            });
          });
          await seedDefaultWorkspaceRecords(client, ws);
        })(),
        BOOTSTRAP_TIMEOUT_MS,
        i18n.t('errors', 'bootstrapTimeout'),
      );
      persistConnectionFields(host, port, ws);
      config.setRemoteClient(client, true);
      this.props.onSessionOpened();
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
    } finally {
      this.setState({ busy: false, bootstrapProgress: null });
    }
  };

  override render(): ReactNode {
    const { i18n } = this.managers;
    const { host, port, workspace, token, busy, bootstrapProgress } = this.state;

    return (
      <div style={this.shellStyle}>
        <h1 style={{ fontSize: 20, margin: 0 }}>{i18n.t('ui', 'gateTitle')}</h1>
        <p style={{ fontSize: 13, color: '#94a3b8', maxWidth: 480, textAlign: 'center' }}>
          {i18n.t('ui', 'gateHint')}
        </p>
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 'min(400px, 100%)' }}
        >
          <span>{i18n.t('ui', 'host')}</span>
          <input
            value={host}
            onChange={(e) => this.setState({ host: e.target.value })}
            style={this.inputStyle}
          />
        </label>
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 'min(400px, 100%)' }}
        >
          <span>{i18n.t('ui', 'port')}</span>
          <input
            type="number"
            value={port}
            onChange={(e) => this.setState({ port: Number(e.target.value) })}
            style={this.inputStyle}
          />
        </label>
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 'min(400px, 100%)' }}
        >
          <span>{i18n.t('ui', 'gateWorkspace')}</span>
          <input
            value={workspace}
            onChange={(e) => this.setState({ workspace: e.target.value })}
            style={this.inputStyle}
            placeholder={FIXED_MODEL_DESIGNER_DATABASE}
            autoComplete="off"
          />
          <span style={{ fontSize: 11, color: '#64748b' }}>
            {i18n.t('ui', 'gateWorkspaceHint')}
          </span>
        </label>
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 'min(400px, 100%)' }}
        >
          <span>{i18n.t('ui', 'connectToken')}</span>
          <input
            value={token}
            onChange={(e) => this.setState({ token: e.target.value })}
            style={this.inputStyle}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, width: 'min(400px, 100%)' }}>
          <span>{i18n.t('ui', 'locale')}</span>
          <select
            value={i18n.locale}
            onChange={(e) => {
              i18n.setLocale(e.target.value as LocaleCode);
            }}
            style={{ ...this.inputStyle, flex: 1 }}
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void this.connect()}
          style={{ padding: '10px 20px', marginTop: 8, cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy
            ? bootstrapProgress
              ? i18n.t('ui', 'bootstrapRunning')
              : i18n.t('ui', 'connecting')
            : i18n.t('ui', 'connect')}
        </button>
        {busy && bootstrapProgress && (
          <div
            style={{
              fontSize: 12,
              color: '#94a3b8',
              maxWidth: 400,
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            {bootstrapProgress.current}/{bootstrapProgress.total} —{' '}
            <code style={{ color: '#cbd5e1' }}>{bootstrapProgress.detail}</code>
          </div>
        )}
      </div>
    );
  }
}
