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
import { isQueryDesignerMode } from './managers/mode-manager.js';
import { withTimeout } from './engine/async-timeout.js';
import { ensureDesignerWorkspaceSession } from './engine/workspace-session.js';
import { interactionStateForToolMode } from './utils/tool-mode-state.js';
import { getLibraryByCode } from './sync/library-registry.js';
import {
  deleteQueryInterfaceRegistry,
  listQueryInterfaceRegistry,
  upsertQueryInterfaceRegistry,
} from './sync/query-interface-registry.js';
import {
  EMPTY_QUERY_CHAIN_STATE,
  nextQueryChainFromModelPick,
  nextQueryChainFromRelationPick,
  queryChainAllRelationIds,
  queryChainEdgeStates,
  queryChainModelPickCandidates,
  queryChainRelationPickCandidates,
  queryChainRelationSwitchCandidateIds,
  queryChainModelIds,
  removeQueryChainModel,
  removeQueryChainRelation,
  replaceQueryChainRelationWithRelation,
  type QueryInterface,
  type QueryChainState,
  type QueryModelPickCandidate,
  type QueryRelationPickCandidate,
} from './query-designer/index.js';

const RECONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_BOOTSTRAP_MS = 60_000;
const TEXT_QUERY_INTERFACE_CREATED = '\u63a5\u53e3\u5df2\u4fdd\u5b58';
const TEXT_QUERY_INTERFACE_UPDATED = '\u63a5\u53e3\u5df2\u66f4\u65b0';
const TEXT_QUERY_INTERFACE_UNCHANGED = '\u63a5\u53e3\u5df2\u5b58\u5728';
const TEXT_QUERY_INTERFACE_RENAMED = '\u63a5\u53e3\u5df2\u91cd\u547d\u540d';
const TEXT_QUERY_INTERFACE_PERSIST_FAILED = '\u63a5\u53e3\u8d44\u4ea7\u540c\u6b65\u5931\u8d25';

interface AppState {
  selectedModelId: string | undefined;
  selectedRelationId: string | undefined;
  sessionEpoch: number;
  connected: boolean;
  reconnecting: boolean;
  queryChain: QueryChainState;
  pendingQueryRelationPick:
    | { relationId: string; candidates: readonly QueryRelationPickCandidate[] }
    | undefined;
  pendingQueryModelPick:
    | { modelId: string; candidates: readonly QueryModelPickCandidate[] }
    | undefined;
  savedQueryInterfaces: SavedQueryInterface[];
  activeQueryInterfaceId: string | undefined;
}

export interface SavedQueryInterface {
  id: string;
  name: string;
  queryInterface: QueryInterface;
  queryChain: QueryChainState;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  projectionConfigured?: boolean;
}

type QueryInterfaceSaveResult =
  | { status: 'created'; id: string; name: string }
  | { status: 'updated'; id: string; name: string }
  | { status: 'unchanged'; id: string; name: string };

/**
 * 根页面：未连接时 {@link ConnectionFlow}；连接并选择逻辑库后进入画布（当前库名见 {@link ConfigManager#activeLibraryName}）。
 */
export default class App extends DesignerChromePage<Record<string, never>, AppState> {
  private modeUnsub: (() => void) | undefined;
  private readonly queryInterfaceWriteQueue = new Map<string, Promise<void>>();

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
      queryChain: EMPTY_QUERY_CHAIN_STATE,
      pendingQueryRelationPick: undefined,
      pendingQueryModelPick: undefined,
      savedQueryInterfaces: [],
      activeQueryInterfaceId: undefined,
    };
  }

  override componentDidMount(): void {
    this.modeUnsub = this.managers.modes.subscribe(() => this.forceUpdate());
    if (this.state.reconnecting) {
      void this.attemptSilentReconnect();
    }
  }

  override componentWillUnmount(): void {
    this.modeUnsub?.();
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
    let savedQueryInterfaces: SavedQueryInterface[] | undefined;
    try {
      savedQueryInterfaces = await listQueryInterfaceRegistry(client, libraryName);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Designer] load query interfaces failed', e);
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
      queryChain: EMPTY_QUERY_CHAIN_STATE,
      pendingQueryRelationPick: undefined,
      pendingQueryModelPick: undefined,
      savedQueryInterfaces: savedQueryInterfaces ?? (reconnecting ? s.savedQueryInterfaces : []),
      activeQueryInterfaceId: undefined,
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
      queryChain: EMPTY_QUERY_CHAIN_STATE,
      pendingQueryRelationPick: undefined,
      pendingQueryModelPick: undefined,
      savedQueryInterfaces: [],
      activeQueryInterfaceId: undefined,
    }));
  };

  private handleSelectModel = (id: string | undefined): void => {
    if (isQueryDesignerMode(this.managers.modes.mode) && id) {
      this.setState((s) => {
        if (s.selectedModelId === id) {
          return {
            selectedModelId: undefined,
            selectedRelationId: undefined,
            pendingQueryRelationPick: undefined,
            pendingQueryModelPick: undefined,
            queryChain: removeQueryChainModel(s.queryChain, id, this.managers.data.relations),
          };
        }
        const graphModelIds = new Set(
          queryChainModelIds(s.queryChain, this.managers.data.relations),
        );
        const candidates = graphModelIds.has(id)
          ? []
          : queryChainModelPickCandidates(s.queryChain, id, this.managers.data.relations);
        if (candidates.length > 1) {
          return {
            selectedModelId: id,
            selectedRelationId: undefined,
            pendingQueryRelationPick: undefined,
            pendingQueryModelPick: { modelId: id, candidates },
            queryChain: s.queryChain,
          };
        }
        const candidate = candidates[0];
        return {
          selectedModelId: id,
          selectedRelationId: undefined,
          pendingQueryRelationPick: undefined,
          pendingQueryModelPick: undefined,
          queryChain: candidate
            ? nextQueryChainFromRelationPick(
                s.queryChain,
                candidate.relationId,
                this.managers.data.relations,
                candidate.sourceNodeId,
              )
            : nextQueryChainFromModelPick(s.queryChain, id, this.managers.data.relations),
        };
      });
      return;
    }
    this.setState({ selectedModelId: id, selectedRelationId: undefined });
  };

  private handleSelectRelation = (id: string | undefined): void => {
    if (this.managers.modes.mode === 'query-rewire' && id) {
      this.setState((s) => {
        const edgeStates = queryChainEdgeStates(s.queryChain);
        const clickedEdge = edgeStates.find((edge) => edge.relationId === id);
        const activeEdge =
          edgeStates.find((edge) => edge.relationId === s.selectedRelationId) ?? edgeStates.at(-1);
        if (clickedEdge) {
          return {
            selectedModelId: undefined,
            selectedRelationId: id,
            queryChain: s.queryChain,
          };
        }
        if (!activeEdge) {
          return {
            selectedModelId: undefined,
            selectedRelationId: s.selectedRelationId,
            queryChain: s.queryChain,
          };
        }
        const nextQueryChain = replaceQueryChainRelationWithRelation(
          s.queryChain,
          activeEdge,
          id,
          this.managers.data.relations,
        );
        const changed = nextQueryChain !== s.queryChain;
        return {
          selectedModelId: undefined,
          selectedRelationId: changed ? id : activeEdge.relationId,
          queryChain: nextQueryChain,
        };
      });
      return;
    }
    if (isQueryDesignerMode(this.managers.modes.mode) && id) {
      this.setState((s) => {
        const candidates = queryChainRelationPickCandidates(
          s.queryChain,
          id,
          this.managers.data.relations,
        );
        if (s.selectedRelationId === id && candidates.length === 0) {
          return {
            selectedModelId: undefined,
            selectedRelationId: undefined,
            pendingQueryRelationPick: undefined,
            pendingQueryModelPick: undefined,
            queryChain: removeQueryChainRelation(
              s.queryChain,
              queryChainEdgeStates(s.queryChain).find((edge) => edge.relationId === id) ?? {
                relationId: id,
                direction: 'forward',
              },
              this.managers.data.relations,
            ),
          };
        }
        if (candidates.length > 1) {
          return {
            selectedModelId: undefined,
            selectedRelationId: id,
            pendingQueryRelationPick: { relationId: id, candidates },
            pendingQueryModelPick: undefined,
            queryChain: s.queryChain,
          };
        }
        return {
          selectedModelId: undefined,
          selectedRelationId: id,
          pendingQueryRelationPick: undefined,
          pendingQueryModelPick: undefined,
          queryChain: nextQueryChainFromRelationPick(
            s.queryChain,
            id,
            this.managers.data.relations,
            candidates[0]?.sourceNodeId,
          ),
        };
      });
      return;
    }
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
    this.setState({
      selectedModelId: undefined,
      selectedRelationId: undefined,
      pendingQueryRelationPick: undefined,
      pendingQueryModelPick: undefined,
    });
  };

  private handleQueryChainChange = (queryChain: QueryChainState): void => {
    this.setState({
      queryChain,
      selectedModelId: queryChain.activeModelId,
      selectedRelationId: queryChainAllRelationIds(queryChain).at(-1),
      pendingQueryRelationPick: undefined,
      pendingQueryModelPick: undefined,
    });
  };

  private handleResolveQueryRelationPick = (sourceNodeIds: readonly string[]): void => {
    this.setState((s) => {
      const pending = s.pendingQueryRelationPick;
      if (!pending) {
        return null;
      }
      let queryChain = s.queryChain;
      for (const sourceNodeId of sourceNodeIds) {
        queryChain = nextQueryChainFromRelationPick(
          queryChain,
          pending.relationId,
          this.managers.data.relations,
          sourceNodeId,
        );
      }
      return {
        queryChain,
        selectedModelId: queryChain.activeModelId,
        selectedRelationId: pending.relationId,
        pendingQueryRelationPick: undefined,
      };
    });
  };

  private handleCancelQueryRelationPick = (): void => {
    this.setState({ pendingQueryRelationPick: undefined, selectedRelationId: undefined });
  };

  private handleResolveQueryModelPick = (candidates: readonly QueryModelPickCandidate[]): void => {
    this.setState((s) => {
      const pending = s.pendingQueryModelPick;
      if (!pending) {
        return null;
      }
      let queryChain = s.queryChain;
      for (const candidate of candidates) {
        queryChain = nextQueryChainFromRelationPick(
          queryChain,
          candidate.relationId,
          this.managers.data.relations,
          candidate.sourceNodeId,
        );
      }
      return {
        queryChain,
        selectedModelId: queryChain.activeModelId,
        selectedRelationId: candidates.at(-1)?.relationId,
        pendingQueryRelationPick: undefined,
        pendingQueryModelPick: undefined,
      };
    });
  };

  private handleCancelQueryModelPick = (): void => {
    this.setState({ pendingQueryModelPick: undefined, selectedModelId: undefined });
  };

  private handleSaveQueryInterface = (
    queryInterface: QueryInterface,
    queryChain: QueryChainState,
    name: string,
    description: string,
    activeInterfaceId?: string,
    projectionConfigured?: boolean,
  ): QueryInterfaceSaveResult => {
    const now = new Date().toISOString();
    const displayName = name.trim() || queryInterface.displayName || queryInterface.name;
    const normalizedDescription = description.trim();
    const signature = queryInterfaceSignature(queryInterface);
    const activeInterface = activeInterfaceId
      ? this.state.savedQueryInterfaces.find((item) => item.id === activeInterfaceId)
      : undefined;
    const existing =
      activeInterface ??
      this.state.savedQueryInterfaces.find(
        (item) => (item.signature ?? queryInterfaceSignature(item.queryInterface)) === signature,
      );

    if (existing) {
      const sameName = existing.name === displayName;
      const sameDescription = (existing.queryInterface.description ?? '') === normalizedDescription;
      const sameSignature =
        (existing.signature ?? queryInterfaceSignature(existing.queryInterface)) === signature;
      if (sameName && sameDescription && sameSignature) {
        this.managers.notifications.warning(TEXT_QUERY_INTERFACE_UNCHANGED, {
          message: displayName,
        });
        return { status: 'unchanged', id: existing.id, name: displayName };
      }
      const callableName = uniqueInterfaceName(displayName);
      const updatedInterface: QueryInterface = {
        ...queryInterface,
        id: existing.id,
        name: callableName,
        displayName,
        description: normalizedDescription || undefined,
        contract: {
          ...queryInterface.contract,
          invocation: {
            ...queryInterface.contract.invocation,
            callableName,
          },
        },
        lifecycle: {
          ...queryInterface.lifecycle,
          createdAt: existing.createdAt,
          updatedAt: now,
        },
      };
      const updated: SavedQueryInterface = {
        ...existing,
        name: displayName,
        queryInterface: updatedInterface,
        queryChain: cloneQueryChain(queryChain),
        updatedAt: now,
        signature,
        projectionConfigured,
      };
      this.setState(
        (s) => ({
          savedQueryInterfaces: s.savedQueryInterfaces.map((item) =>
            item.id === existing.id ? updated : item,
          ),
          activeQueryInterfaceId: existing.id,
        }),
        () => this.persistQueryInterface(updated),
      );
      this.managers.notifications.success(TEXT_QUERY_INTERFACE_UPDATED, {
        message: displayName,
      });
      return { status: 'updated', id: existing.id, name: displayName };
    }

    const id = `${queryInterface.id}_${crypto.randomUUID()}`;
    const callableName = uniqueInterfaceName(displayName);
    const savedInterface: QueryInterface = {
      ...queryInterface,
      id,
      name: callableName,
      displayName,
      description: normalizedDescription || undefined,
      contract: {
        ...queryInterface.contract,
        invocation: {
          ...queryInterface.contract.invocation,
          callableName,
        },
      },
      lifecycle: {
        ...queryInterface.lifecycle,
        createdAt: now,
        updatedAt: now,
      },
    };
    const saved: SavedQueryInterface = {
      id,
      name: displayName,
      queryInterface: savedInterface,
      queryChain: cloneQueryChain(queryChain),
      createdAt: now,
      updatedAt: now,
      signature,
      projectionConfigured,
    };
    this.setState(
      (s) => ({
        savedQueryInterfaces: [saved, ...s.savedQueryInterfaces],
        activeQueryInterfaceId: id,
      }),
      () => this.persistQueryInterface(saved),
    );
    this.managers.notifications.success(TEXT_QUERY_INTERFACE_CREATED, {
      message: displayName,
    });
    return { status: 'created', id, name: displayName };
  };

  private handleOpenQueryInterface = (id: string): void => {
    const saved = this.state.savedQueryInterfaces.find((item) => item.id === id);
    if (!saved) {
      return;
    }
    const queryChain = cloneQueryChain(saved.queryChain);
    this.managers.modes.setMode('query-select');
    this.managers.state.transition(interactionStateForToolMode('query-select'));
    this.setState({
      queryChain,
      selectedModelId: queryChain.activeModelId,
      selectedRelationId: queryChainAllRelationIds(queryChain).at(-1),
      activeQueryInterfaceId: saved.id,
    });
  };

  private handleClearActiveQueryInterface = (): void => {
    this.setState({ activeQueryInterfaceId: undefined });
  };

  private handleRenameQueryInterface = (id: string, name: string): void => {
    const displayName = name.trim();
    if (!displayName) {
      return;
    }
    const now = new Date().toISOString();
    this.setState(
      (s) => ({
        savedQueryInterfaces: s.savedQueryInterfaces.map((item) => {
          if (item.id !== id || item.name === displayName) {
            return item;
          }
          const callableName = uniqueInterfaceName(displayName);
          return {
            ...item,
            name: displayName,
            updatedAt: now,
            queryInterface: {
              ...item.queryInterface,
              name: callableName,
              displayName,
              contract: {
                ...item.queryInterface.contract,
                invocation: {
                  ...item.queryInterface.contract.invocation,
                  callableName,
                },
              },
              lifecycle: {
                ...item.queryInterface.lifecycle,
                updatedAt: now,
              },
            },
          };
        }),
      }),
      () => {
        const updated = this.state.savedQueryInterfaces.find((item) => item.id === id);
        if (updated) {
          this.persistQueryInterface(updated);
        }
      },
    );
    this.managers.notifications.success(TEXT_QUERY_INTERFACE_RENAMED, {
      message: displayName,
    });
  };

  private handleDeleteQueryInterface = (id: string): void => {
    this.setState(
      (s) => ({
        savedQueryInterfaces: s.savedQueryInterfaces.filter((item) => item.id !== id),
        activeQueryInterfaceId:
          s.activeQueryInterfaceId === id ? undefined : s.activeQueryInterfaceId,
      }),
      () => this.deletePersistedQueryInterface(id),
    );
  };

  private persistQueryInterface(record: SavedQueryInterface): void {
    this.enqueueQueryInterfaceWrite(record.id, (client, libraryCode) =>
      upsertQueryInterfaceRegistry(client, libraryCode, record),
    );
  }

  private deletePersistedQueryInterface(id: string): void {
    this.enqueueQueryInterfaceWrite(id, (client, libraryCode) =>
      deleteQueryInterfaceRegistry(client, libraryCode, id),
    );
  }

  private enqueueQueryInterfaceWrite(
    id: string,
    write: (client: RemoteModelDBClient, libraryCode: string) => Promise<void>,
  ): void {
    const client = this.managers.config.remoteClient;
    const libraryCode = this.managers.config.activeLibraryName;
    if (!client || !libraryCode || !id) {
      return;
    }
    const key = `${libraryCode}:${id}`;
    const previous = this.queryInterfaceWriteQueue.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => write(client, libraryCode));
    this.queryInterfaceWriteQueue.set(key, task);
    void task
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.warn('[Designer] query interface registry write failed', error);
        this.managers.notifications.error(TEXT_QUERY_INTERFACE_PERSIST_FAILED, {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.queryInterfaceWriteQueue.get(key) === task) {
          this.queryInterfaceWriteQueue.delete(key);
        }
      });
  }

  override render(): ReactNode {
    const {
      selectedModelId,
      selectedRelationId,
      connected,
      reconnecting,
      sessionEpoch,
      queryChain,
      pendingQueryRelationPick,
      pendingQueryModelPick,
      savedQueryInterfaces,
      activeQueryInterfaceId,
    } = this.state;
    const activeQueryInterface = activeQueryInterfaceId
      ? savedQueryInterfaces.find((item) => item.id === activeQueryInterfaceId)
      : undefined;
    const queryModelIds = new Set(queryChainModelIds(queryChain, this.managers.data.relations));
    const queryRelationIds = new Set(queryChainAllRelationIds(queryChain));
    const edgeStates = queryChainEdgeStates(queryChain);
    const queryConstraintRelationIds = new Set(
      edgeStates.filter((edge) => edge.role === 'constraint').map((edge) => edge.relationId),
    );
    const activeRewireEdge =
      edgeStates.find((edge) => edge.relationId === selectedRelationId) ?? edgeStates.at(-1);
    const queryCandidateRelationIds = new Set(
      this.managers.modes.mode === 'query-rewire'
        ? queryChainRelationSwitchCandidateIds(
            queryChain,
            activeRewireEdge,
            this.managers.data.relations,
          )
        : [],
    );

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
          queryChain={queryChain}
          pendingQueryRelationPick={pendingQueryRelationPick}
          pendingQueryModelPick={pendingQueryModelPick}
          savedQueryInterfaces={savedQueryInterfaces}
          activeQueryInterface={activeQueryInterface}
          onQueryChainChange={this.handleQueryChainChange}
          onResolveQueryRelationPick={this.handleResolveQueryRelationPick}
          onCancelQueryRelationPick={this.handleCancelQueryRelationPick}
          onResolveQueryModelPick={this.handleResolveQueryModelPick}
          onCancelQueryModelPick={this.handleCancelQueryModelPick}
          onSaveQueryInterface={this.handleSaveQueryInterface}
          onClearActiveQueryInterface={this.handleClearActiveQueryInterface}
          onOpenQueryInterface={this.handleOpenQueryInterface}
          onRenameQueryInterface={this.handleRenameQueryInterface}
          onDeleteQueryInterface={this.handleDeleteQueryInterface}
          onRequestClearCanvasSelection={this.handleClearCanvasSelection}
        >
          <div className="designer-editor-root">
            <div className="designer-canvas-wrap">
              <CanvasContainer
                selectedModelId={selectedModelId}
                selectedRelationId={selectedRelationId}
                queryMode={isQueryDesignerMode(this.managers.modes.mode)}
                queryModelIds={queryModelIds}
                queryRelationIds={queryRelationIds}
                queryConstraintRelationIds={queryConstraintRelationIds}
                queryCandidateRelationIds={queryCandidateRelationIds}
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

function cloneQueryChain(queryChain: QueryChainState): QueryChainState {
  return {
    ...queryChain,
    primaryRelationIds: [...queryChain.primaryRelationIds],
    branchRelationIds: [...queryChain.branchRelationIds],
    constraintRelationIds: [...queryChain.constraintRelationIds],
    relationUsages: queryChain.relationUsages ? { ...queryChain.relationUsages } : {},
  };
}

function uniqueInterfaceName(displayName: string): string {
  return (
    displayName
      .trim()
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'QueryInterface'
  );
}

function queryInterfaceSignature(queryInterface: QueryInterface): string {
  return JSON.stringify({
    kind: queryInterface.kind,
    contract: {
      parameters: queryInterface.contract.parameters,
      output: queryInterface.contract.output,
      errors: queryInterface.contract.errors,
      invocation: queryInterface.contract.invocation,
    },
    designGraph: {
      rootNodeId: queryInterface.designGraph.rootNodeId,
      nodes: queryInterface.designGraph.nodes.map((node) => ({
        id: node.id,
        modelId: node.modelId,
        alias: node.alias,
        role: node.role,
        cardinality: node.cardinality,
      })),
      edges: queryInterface.designGraph.edges.map((edge) => ({
        id: edge.id,
        relationId: edge.relationId,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        alias: edge.alias,
        required: edge.required,
        cardinality: edge.cardinality,
        traversal: edge.traversal,
        purpose: edge.purpose,
        traversalRole: edge.traversalRole,
        inherited: edge.inherited,
      })),
    },
    query: {
      rootNodeId: queryInterface.query.rootNodeId,
      traversal: queryInterface.query.traversal,
      filters: queryInterface.query.filters,
      sorts: queryInterface.query.sorts,
      projection: queryInterface.query.projection,
      pagination: queryInterface.query.pagination,
      result: queryInterface.query.result,
      binding: queryInterface.query.binding,
    },
  });
}
