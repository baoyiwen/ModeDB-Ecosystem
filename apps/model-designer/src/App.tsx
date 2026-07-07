import type { ReactNode } from 'react';
import type { ManagementCatalogResponse, RemoteModelDBClient } from '@mode-db/sdk';
import './styles/designer-shell.css';
import { CanvasContainer } from './components/CanvasContainer.js';
import { NotificationToasts } from './components/NotificationToasts.js';
import { ConnectionFlow } from './components/ConnectionFlow.js';
import { EditorChrome } from './components/EditorChrome.js';
import { DesignerToolbarWithConfirm } from './components/DesignerToolbar.js';
import { DesignerChromePage } from './components/base/designer-component.js';
import { ensureDesignerCatalog } from './bootstrap/designer-storage-init.js';
import { seedDefaultWorkspaceRecords } from './bootstrap/seed-workspace-rows.js';
import {
  importEngineCatalogIntoDesignerDb,
  readBusinessCatalog,
} from './sync/engine-catalog-import.js';
import {
  clearSessionToken,
  getSessionToken,
  getStoredHost,
  getStoredLastLibrary,
  getStoredPort,
} from './config/connection-prefs.js';
import { FIXED_MODEL_DESIGNER_DATABASE } from './config/fixed-database.js';
import { isInheritRelation } from './config/graph-edge-kinds.js';
import { withTimeout } from './engine/async-timeout.js';
import { ensureDesignerWorkspaceSession } from './engine/workspace-session.js';
import { interactionStateForToolMode } from './utils/tool-mode-state.js';
import { getLibraryByCode } from './sync/library-registry.js';

const RECONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_BOOTSTRAP_MS = 60_000;

interface AppState {
  selectedModelId: string | undefined;
  selectedRelationId: string | undefined;
  sessionEpoch: number;
  connected: boolean;
  reconnecting: boolean;
}

/**
 * 根页面：未连接时 {@link ConnectionFlow}；连接并选择逻辑库后进入画布（当前库名见 {@link ConfigManager#activeLibraryName}）。
 */
export default class App extends DesignerChromePage<Record<string, never>, AppState> {
  constructor(props: Record<string, never>) {
    super(props);
    // 若在 sessionStorage / localStorage 里能凑齐凭据 + 上次逻辑库，则尝试静默重连，
    // 以满足「F5 刷新仍停留在当前工作空间」的要求；attemptSilentReconnect 失败时回落到登录页。
    const canReconnect = this.collectReconnectCredentials() !== null;
    this.state = {
      selectedModelId: undefined,
      selectedRelationId: undefined,
      sessionEpoch: 0,
      connected: false,
      reconnecting: canReconnect,
    };
  }

  override componentDidMount(): void {
    if (this.state.reconnecting) {
      void this.attemptSilentReconnect();
    }
  }

  private collectReconnectCredentials(): {
    host: string;
    port: number;
    token: string;
    library: string;
  } | null {
    const host = getStoredHost(import.meta.env.VITE_MODE_DB_HOST ?? '').trim();
    const port = getStoredPort(Number(import.meta.env.VITE_MODE_DB_PORT ?? 0) || 0);
    // 静默重连仅依赖 sessionStorage 中的会话 token（F5 刷新当前工作区）。
    // 手动断开会清除 session token；「记住 Token」只用于预填连接表单，不触发自动重连。
    const token = getSessionToken()?.trim() ?? '';
    const library = getStoredLastLibrary('').trim();
    if (!host || !port || !token || !library) {
      return null;
    }
    return { host, port, token, library };
  }

  private async attemptSilentReconnect(): Promise<void> {
    const creds = this.collectReconnectCredentials();
    if (!creds) {
      this.setState({ reconnecting: false });
      return;
    }
    let client: RemoteModelDBClient | undefined;
    try {
      client = await withTimeout(
        ensureDesignerWorkspaceSession({
          host: creds.host,
          port: creds.port,
          token: creds.token,
          designerWorkspace: FIXED_MODEL_DESIGNER_DATABASE,
        }),
        RECONNECT_TIMEOUT_MS,
        'reconnect timeout',
      );
      await withTimeout(
        this.managers.asyncOps.run(
          'reconnect',
          async () => {
            await ensureDesignerCatalog(client!);
            await seedDefaultWorkspaceRecords(client!, creds.library);
            let catalog: ManagementCatalogResponse | undefined;
            try {
              catalog = await readBusinessCatalog({
                host: creds.host,
                port: creds.port,
                token: creds.token,
                businessDb: creds.library,
              });
              await importEngineCatalogIntoDesignerDb(client!, creds.library, catalog);
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn('[Designer] silent reconnect: engine catalog import failed', e);
            }
            await this.finishEditorReady(client!, creds.library, catalog);
          },
          { detail: creds.library },
        ),
        RECONNECT_BOOTSTRAP_MS,
        'reconnect bootstrap timeout',
      );
    } catch (e) {
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      // 任一步失败：清掉 session token，避免后续每次刷新都触发同样失败的重连。
      clearSessionToken();
      // eslint-disable-next-line no-console
      console.warn('[Designer] silent reconnect failed; falling back to login', e);
      this.setState({ reconnecting: false });
    }
  }

  private readonly handleEditorReady = (
    client: RemoteModelDBClient,
    libraryName: string,
    catalog?: ManagementCatalogResponse,
    libraryMeta?: { name: Record<string, string> },
  ): void => {
    void this.finishEditorReady(client, libraryName, catalog, libraryMeta);
  };

  private async finishEditorReady(
    client: RemoteModelDBClient,
    libraryName: string,
    catalog?: ManagementCatalogResponse,
    libraryMeta?: { name: Record<string, string> },
  ): Promise<void> {
    const { config, data, layers, modes, state, asyncOps } = this.managers;
    const reconnecting = this.state.reconnecting;
    config.setRemoteClient(client, true);
    config.setActiveLibraryName(libraryName);
    if (libraryMeta?.name) {
      config.setActiveLibraryMeta(libraryMeta.name);
    } else {
      try {
        const rec = await getLibraryByCode(client, libraryName);
        config.setActiveLibraryMeta(rec?.name ?? null);
      } catch {
        config.setActiveLibraryMeta(null);
      }
    }
    if (!reconnecting) {
      data.resetToNewLibrary();
    }
    try {
      await asyncOps.run('loadCanvas', () => data.loadLibraryCanvas(client, libraryName, catalog), {
        detail: libraryName,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Designer] loadLibraryCanvas failed', e);
    }
    config.resetViewport();
    modes.setMode('select');
    state.transition(interactionStateForToolMode('select'));
    layers.setActiveLayer(data.defaultPageLayerId);
    this.setState((s) => ({
      connected: true,
      reconnecting: false,
      selectedModelId: undefined,
      selectedRelationId: undefined,
      sessionEpoch: s.sessionEpoch + 1,
    }));
  }

  private handleDisconnected = (): void => {
    const { config, data } = this.managers;
    data.resetToNewLibrary();
    config.resetViewport();
    config.setActiveLibraryName(null);
    // 显式断开：清掉 session token，避免下次刷新又被静默重连拉回来。
    clearSessionToken();
    this.setState((s) => ({
      connected: false,
      reconnecting: false,
      selectedModelId: undefined,
      selectedRelationId: undefined,
      sessionEpoch: s.sessionEpoch + 1,
    }));
  };

  private handleSelectModel = (id: string | undefined): void => {
    this.setState({ selectedModelId: id, selectedRelationId: undefined });
  };

  private handleSelectRelation = (id: string | undefined): void => {
    if (!id) {
      this.setState({ selectedRelationId: undefined, selectedModelId: undefined });
      return;
    }
    const rel = this.managers.data.relations.find((r) => r.id === id);
    if (rel && isInheritRelation(rel.kind)) {
      this.setState({ selectedModelId: rel.target_model_id, selectedRelationId: undefined });
      return;
    }
    this.setState({ selectedRelationId: id, selectedModelId: undefined });
  };

  private handleClearCanvasSelection = (): void => {
    this.setState({ selectedModelId: undefined, selectedRelationId: undefined });
  };

  override render(): ReactNode {
    const { selectedModelId, selectedRelationId, connected, reconnecting, sessionEpoch } =
      this.state;

    if (reconnecting) {
      return this.wrapRoot(
        <>
          <NotificationToasts />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: '100vh',
              color: '#475569',
              fontSize: 13,
            }}
          >
            {this.managers.i18n.t('ui', 'bootstrapRunning')}
          </div>
        </>,
      );
    }

    if (!connected) {
      return this.wrapRoot(
        <>
          <NotificationToasts />
          <ConnectionFlow onEditorReady={this.handleEditorReady} />
        </>,
      );
    }

    return this.wrapRoot(
      <>
        <NotificationToasts />
        <EditorChrome
          key={sessionEpoch}
          selectedModelId={selectedModelId}
          selectedRelationId={selectedRelationId}
          onRequestClearCanvasSelection={this.handleClearCanvasSelection}
        >
          <div className="designer-editor-root">
            <div className="designer-canvas-wrap">
              <CanvasContainer
                selectedModelId={selectedModelId}
                selectedRelationId={selectedRelationId}
                onSelectModel={this.handleSelectModel}
                onSelectRelation={this.handleSelectRelation}
              />
              <DesignerToolbarWithConfirm
                selectedId={selectedModelId}
                onSelect={this.handleSelectModel}
                onDisconnected={this.handleDisconnected}
              />
            </div>
          </div>
        </EditorChrome>
      </>,
    );
  }
}
