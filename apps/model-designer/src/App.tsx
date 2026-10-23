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
  isBrowserSessionMode,
  isSecurityCenterActive,
  hasActiveConnection,
  getPairingLaunch,
  logoutCurrentBrowserSession,
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
import { createUuid } from './utils/random-id.js';
import { interfaceDiagnosticMessage } from './utils/interface-diagnostic-i18n.js';
import { getLibraryByCode } from './sync/library-registry.js';
import {
  deleteQueryInterfaceRegistry,
  listQueryInterfaceAuditSummaries,
  listQueryInterfaceRegistry,
  type QueryInterfaceAuditSummary,
  upsertQueryInterfaceRegistry,
} from './sync/query-interface-registry.js';
import {
  deleteOperationInterfaceRegistry,
  listOperationInterfaceRegistry,
  upsertOperationInterfaceRegistry,
} from './sync/operation-interface-registry.js';
import {
  deleteBindingSurfaceRegistry,
  listBindingSurfaceAuditSummaries,
  listBindingSurfaceRegistry,
  type BindingSurfaceAuditSummary,
  upsertBindingSurfaceRegistry,
} from './sync/binding-surface-registry.js';
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
  deprecateQueryInterfaceRelease,
  nextDraftInterface,
  publishQueryInterface,
  queryInterfacePublicationSignature,
  compilePublishedQueryExecutionTemplate,
  appendExecutableReleaseHistory,
  appendOperationReleaseHistory,
  compilePublishedOperationExecutionTemplate,
  deprecateOperationInterfaceRelease,
  nextDraftOperationInterface,
  operationInterfacePublicationSignature,
  publishOperationInterface,
  appendBindingSurfaceReleaseHistory,
  bindingSurfacePublicationSignature,
  deprecateBindingSurfaceRelease,
  nextDraftBindingSurface,
  publishBindingSurface,
  prepareBindingSurfaceRollback,
  prepareOperationInterfaceRollback,
  prepareQueryInterfaceRollback,
  type BindingSurface,
  type BindingSurfaceRelease,
  type OperationInterface,
  type OperationInterfaceRelease,
  type QueryInterface,
  type QueryInterfaceRelease,
  type QueryChainState,
  type QueryModelPickCandidate,
  type QueryRelationPickCandidate,
} from './query-designer/index.js';

const RECONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_BOOTSTRAP_MS = 60_000;
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
  savedOperationInterfaces: SavedOperationInterface[];
  activeOperationInterfaceId: string | undefined;
  savedBindingSurfaces: SavedBindingSurface[];
  activeBindingSurfaceId: string | undefined;
}

export interface SavedQueryInterface {
  id: string;
  storageId?: string;
  name: string;
  queryInterface: QueryInterface;
  queryChain: QueryChainState;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  projectionConfigured?: boolean;
  publishedRelease?: QueryInterfaceRelease;
  releaseHistory?: QueryInterfaceRelease[];
  auditSummary?: QueryInterfaceAuditSummary;
}

export interface SavedOperationInterface {
  id: string;
  storageId?: string;
  name: string;
  operationInterface: OperationInterface;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  publishedRelease?: OperationInterfaceRelease;
  releaseHistory?: OperationInterfaceRelease[];
}

export interface SavedBindingSurface {
  id: string;
  storageId?: string;
  name: string;
  bindingSurface: BindingSurface;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  publishedRelease?: BindingSurfaceRelease;
  releaseHistory?: BindingSurfaceRelease[];
  auditSummary?: BindingSurfaceAuditSummary;
}

type QueryInterfaceSaveResult =
  | { status: 'created'; id: string; name: string }
  | { status: 'updated'; id: string; name: string }
  | { status: 'unchanged'; id: string; name: string };

type OperationInterfaceSaveResult = QueryInterfaceSaveResult;
type BindingSurfaceSaveResult = QueryInterfaceSaveResult;

/**
 * 根页面：未连接时 {@link ConnectionFlow}；连接并选择逻辑库后进入画布（当前库名见 {@link ConfigManager#activeLibraryName}）。
 */
export default class App extends DesignerChromePage<Record<string, never>, AppState> {
  private modeUnsub: (() => void) | undefined;
  private readonly queryInterfaceWriteQueue = new Map<string, Promise<void>>();
  private readonly operationInterfaceWriteQueue = new Map<string, Promise<void>>();
  private readonly bindingSurfaceWriteQueue = new Map<string, Promise<void>>();

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
      savedOperationInterfaces: [],
      activeOperationInterfaceId: undefined,
      savedBindingSurfaces: [],
      activeBindingSurfaceId: undefined,
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
    // Only non-secret endpoint preferences persist; the SDK restores the HttpOnly session.
    const token = getSessionToken()?.trim() ?? '';
    const library = getStoredLastLibrary('').trim();
    if (
      getPairingLaunch() ||
      isSecurityCenterActive() ||
      !hasActiveConnection() ||
      !host ||
      !port ||
      (!token && !isBrowserSessionMode()) ||
      !library
    ) {
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
      const auditSummaries = await listQueryInterfaceAuditSummaries(client, libraryName);
      savedQueryInterfaces = savedQueryInterfaces.map((item) => {
        const callableName =
          item.publishedRelease?.callableName ??
          item.queryInterface.contract.invocation.callableName ??
          '';
        return {
          ...item,
          auditSummary: callableName ? auditSummaries.get(callableName) : undefined,
        };
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Designer] load query interfaces failed', e);
    }
    let savedOperationInterfaces: SavedOperationInterface[] | undefined;
    try {
      savedOperationInterfaces = await listOperationInterfaceRegistry(client, libraryName);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Designer] load operation interfaces failed', e);
    }
    let savedBindingSurfaces: SavedBindingSurface[] | undefined;
    try {
      savedBindingSurfaces = await listBindingSurfaceRegistry(client, libraryName);
      const auditSummaries = await listBindingSurfaceAuditSummaries(client, libraryName);
      savedBindingSurfaces = savedBindingSurfaces.map((item) => ({
        ...item,
        auditSummary: auditSummaries.get(item.id),
      }));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Designer] load binding surfaces failed', e);
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
      savedOperationInterfaces:
        savedOperationInterfaces ?? (reconnecting ? s.savedOperationInterfaces : []),
      activeOperationInterfaceId: undefined,
      savedBindingSurfaces: savedBindingSurfaces ?? (reconnecting ? s.savedBindingSurfaces : []),
      activeBindingSurfaceId: undefined,
      sessionEpoch: s.sessionEpoch + 1,
    }));
  }

  private handleDisconnected = (): void => {
    const { config, data } = this.managers;
    data.resetToNewLibrary();
    config.resetViewport();
    config.setActiveLibraryName(null);
    void logoutCurrentBrowserSession().catch(() => {
      window.alert(this.managers.i18n.t('ui', 'sessionLogoutFailed'));
    });
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
      savedOperationInterfaces: [],
      activeOperationInterfaceId: undefined,
      savedBindingSurfaces: [],
      activeBindingSurfaceId: undefined,
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
        this.managers.notifications.warning(
          this.managers.i18n.t('ui', 'queryInterfaceNotifyUnchanged'),
          {
            message: displayName,
          },
        );
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
      const editableInterface =
        existing.publishedRelease &&
        queryInterfacePublicationSignature(updatedInterface) !== existing.publishedRelease.signature
          ? nextDraftInterface(updatedInterface, existing.publishedRelease, now)
          : updatedInterface;
      const updated: SavedQueryInterface = {
        ...existing,
        name: displayName,
        queryInterface: editableInterface,
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
      this.managers.notifications.success(
        this.managers.i18n.t('ui', 'queryInterfaceNotifyUpdated'),
        {
          message: displayName,
        },
      );
      return { status: 'updated', id: existing.id, name: displayName };
    }

    const id = `${queryInterface.id}_${createUuid()}`;
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
    this.managers.notifications.success(this.managers.i18n.t('ui', 'queryInterfaceNotifyCreated'), {
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
          const renamedInterface: QueryInterface = {
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
          };
          return {
            ...item,
            name: displayName,
            updatedAt: now,
            queryInterface:
              item.publishedRelease &&
              queryInterfacePublicationSignature(renamedInterface) !==
                item.publishedRelease.signature
                ? nextDraftInterface(renamedInterface, item.publishedRelease, now)
                : renamedInterface,
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
    this.managers.notifications.success(this.managers.i18n.t('ui', 'queryInterfaceNotifyRenamed'), {
      message: displayName,
    });
  };

  private handlePublishQueryInterface = (id: string): void => {
    const current = this.state.savedQueryInterfaces.find((item) => item.id === id);
    if (!current) {
      return;
    }
    const signature = queryInterfacePublicationSignature(current.queryInterface);
    const templateCompilation = compilePublishedQueryExecutionTemplate({
      queryInterface: current.queryInterface,
      models: this.managers.data.models,
      relations: this.managers.data.relations,
    });
    if (!templateCompilation.template) {
      this.managers.notifications.error(
        this.managers.i18n.t('ui', 'queryInterfaceNotifyPublishFailed'),
        {
          message: interfaceDiagnosticMessage(
            this.managers.i18n,
            templateCompilation.diagnostics.find((item) => item.severity === 'error'),
          ),
        },
      );
      return;
    }
    const result = publishQueryInterface({
      queryInterface: current.queryInterface,
      signature,
      executionTemplate: templateCompilation.template,
      models: this.managers.data.models,
      existingRelease: current.publishedRelease,
      otherReleases: this.state.savedQueryInterfaces
        .filter((item) => item.id !== id)
        .flatMap((item) => [item.publishedRelease, ...(item.releaseHistory ?? [])])
        .filter(
          (release): release is QueryInterfaceRelease =>
            Boolean(release) && release?.queryInterface.status === 'active',
        ),
    });
    if (!result.ok) {
      this.managers.notifications.error(
        this.managers.i18n.t('ui', 'queryInterfaceNotifyPublishFailed'),
        {
          message: interfaceDiagnosticMessage(this.managers.i18n, result.issues[0]),
        },
      );
      return;
    }
    const updated: SavedQueryInterface = {
      ...current,
      queryInterface: result.queryInterface,
      publishedRelease: result.release,
      releaseHistory: appendExecutableReleaseHistory(
        current.releaseHistory,
        current.publishedRelease,
      ),
      updatedAt: result.release.publishedAt,
    };
    this.setState(
      (state) => ({
        savedQueryInterfaces: state.savedQueryInterfaces.map((item) =>
          item.id === id ? updated : item,
        ),
      }),
      () => this.persistQueryInterface(updated),
    );
    this.managers.notifications.success(
      this.managers.i18n.t('ui', 'queryInterfaceNotifyPublished'),
      {
        message: `${current.name} v${result.release.version}`,
      },
    );
  };

  private handleRollbackQueryInterface = (id: string, version: string): void => {
    const current = this.state.savedQueryInterfaces.find((item) => item.id === id);
    const target = current?.releaseHistory?.find((release) => release.version === version);
    if (!current?.publishedRelease || !target) {
      return;
    }
    const plan = prepareQueryInterfaceRollback({ current: current.publishedRelease, target });
    const signature = queryInterfacePublicationSignature(plan.draft);
    const compilation = compilePublishedQueryExecutionTemplate({
      queryInterface: plan.draft,
      models: this.managers.data.models,
      relations: this.managers.data.relations,
    });
    if (!compilation.template) {
      this.managers.notifications.error(
        this.managers.i18n.t('ui', 'queryInterfaceNotifyRollbackFailed'),
        {
          message: interfaceDiagnosticMessage(
            this.managers.i18n,
            compilation.diagnostics.find((item) => item.severity === 'error'),
          ),
        },
      );
      return;
    }
    const result = publishQueryInterface({
      queryInterface: plan.draft,
      signature,
      executionTemplate: compilation.template,
      models: this.managers.data.models,
      existingRelease: current.publishedRelease,
      otherReleases: this.state.savedQueryInterfaces
        .filter((item) => item.id !== id)
        .flatMap((item) => [item.publishedRelease, ...(item.releaseHistory ?? [])])
        .filter(
          (release): release is QueryInterfaceRelease =>
            Boolean(release) && release?.queryInterface.status === 'active',
        ),
    });
    if (!result.ok) {
      this.managers.notifications.error(
        this.managers.i18n.t('ui', 'queryInterfaceNotifyRollbackFailed'),
        {
          message: interfaceDiagnosticMessage(this.managers.i18n, result.issues[0]),
        },
      );
      return;
    }
    const updated: SavedQueryInterface = {
      ...current,
      publishedRelease: result.release,
      releaseHistory: appendExecutableReleaseHistory(
        current.releaseHistory,
        current.publishedRelease,
      ),
      updatedAt: result.release.publishedAt,
    };
    this.setState(
      (state) => ({
        savedQueryInterfaces: state.savedQueryInterfaces.map((item) =>
          item.id === id ? updated : item,
        ),
      }),
      () => this.persistQueryInterface(updated),
    );
    this.managers.notifications.success(
      this.managers.i18n.t('ui', 'queryInterfaceNotifyRolledBack'),
      {
        message: `v${version} -> v${result.release.version}`,
      },
    );
  };

  private handleDeprecateQueryInterface = (id: string): void => {
    const current = this.state.savedQueryInterfaces.find((item) => item.id === id);
    if (!current?.publishedRelease) {
      return;
    }
    const deprecatedAt = new Date().toISOString();
    const deprecatedRelease = deprecateQueryInterfaceRelease(
      current.publishedRelease,
      deprecatedAt,
    );
    const releaseMatchesDraft =
      queryInterfacePublicationSignature(current.queryInterface) ===
      current.publishedRelease.signature;
    const updated: SavedQueryInterface = {
      ...current,
      publishedRelease: deprecatedRelease,
      releaseHistory: current.releaseHistory?.map((release) =>
        deprecateQueryInterfaceRelease(release, deprecatedAt),
      ),
      queryInterface: releaseMatchesDraft
        ? deprecatedRelease.queryInterface
        : current.queryInterface,
      updatedAt: deprecatedRelease.queryInterface.lifecycle.updatedAt,
    };
    this.setState(
      (state) => ({
        savedQueryInterfaces: state.savedQueryInterfaces.map((item) =>
          item.id === id ? updated : item,
        ),
      }),
      () => this.persistQueryInterface(updated),
    );
    this.managers.notifications.warning(
      this.managers.i18n.t('ui', 'queryInterfaceNotifyDeprecated'),
      {
        message: current.name,
      },
    );
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
        this.managers.notifications.error(
          this.managers.i18n.t('ui', 'queryInterfaceNotifyPersistFailed'),
          {
            message: error instanceof Error ? error.message : String(error),
          },
        );
      })
      .finally(() => {
        if (this.queryInterfaceWriteQueue.get(key) === task) {
          this.queryInterfaceWriteQueue.delete(key);
        }
      });
  }

  private handleSaveOperationInterface = (
    operationInterface: OperationInterface,
    name: string,
    description: string,
    activeInterfaceId?: string,
  ): OperationInterfaceSaveResult => {
    const now = new Date().toISOString();
    const displayName = name.trim() || operationInterface.displayName || operationInterface.name;
    const callableName = uniqueInterfaceName(displayName);
    const normalizedDescription = description.trim();
    const active = activeInterfaceId
      ? this.state.savedOperationInterfaces.find((item) => item.id === activeInterfaceId)
      : undefined;
    const normalized: OperationInterface = {
      ...operationInterface,
      id: active?.id ?? operationInterface.id,
      name: callableName,
      displayName,
      description: normalizedDescription || undefined,
      contract: {
        ...operationInterface.contract,
        invocation: { ...operationInterface.contract.invocation, callableName },
      },
      lifecycle: {
        ...operationInterface.lifecycle,
        createdAt: active?.createdAt ?? operationInterface.lifecycle.createdAt,
        updatedAt: now,
      },
    };
    const signature = operationInterfacePublicationSignature(normalized);
    const existing =
      active ??
      this.state.savedOperationInterfaces.find(
        (item) =>
          (item.signature ?? operationInterfacePublicationSignature(item.operationInterface)) ===
          signature,
      );
    if (existing) {
      const unchanged =
        existing.name === displayName &&
        (existing.signature ??
          operationInterfacePublicationSignature(existing.operationInterface)) === signature;
      if (unchanged) {
        return { status: 'unchanged', id: existing.id, name: displayName };
      }
      const withIdentity = { ...normalized, id: existing.id };
      const editable =
        existing.publishedRelease &&
        operationInterfacePublicationSignature(withIdentity) !== existing.publishedRelease.signature
          ? nextDraftOperationInterface(withIdentity, existing.publishedRelease, now)
          : withIdentity;
      const updated: SavedOperationInterface = {
        ...existing,
        name: displayName,
        operationInterface: editable,
        updatedAt: now,
        signature: operationInterfacePublicationSignature(editable),
      };
      this.setState(
        (state) => ({
          savedOperationInterfaces: state.savedOperationInterfaces.map((item) =>
            item.id === existing.id ? updated : item,
          ),
          activeOperationInterfaceId: existing.id,
        }),
        () => this.persistOperationInterface(updated),
      );
      return { status: 'updated', id: existing.id, name: displayName };
    }

    const id = `${operationInterface.id}_${createUuid()}`;
    const savedAsset = { ...normalized, id };
    const saved: SavedOperationInterface = {
      id,
      name: displayName,
      operationInterface: savedAsset,
      createdAt: now,
      updatedAt: now,
      signature: operationInterfacePublicationSignature(savedAsset),
    };
    this.setState(
      (state) => ({
        savedOperationInterfaces: [saved, ...state.savedOperationInterfaces],
        activeOperationInterfaceId: id,
      }),
      () => this.persistOperationInterface(saved),
    );
    return { status: 'created', id, name: displayName };
  };

  private handleOpenOperationInterface = (id: string): void => {
    if (this.state.savedOperationInterfaces.some((item) => item.id === id)) {
      this.setState({ activeOperationInterfaceId: id });
    }
  };

  private handleClearActiveOperationInterface = (): void => {
    this.setState({ activeOperationInterfaceId: undefined });
  };

  private handlePublishOperationInterface = (id: string): void => {
    const current = this.state.savedOperationInterfaces.find((item) => item.id === id);
    if (!current) {
      return;
    }
    const compilation = compilePublishedOperationExecutionTemplate({
      operationInterface: current.operationInterface,
      models: this.managers.data.models,
      relations: this.managers.data.relations,
    });
    if (!compilation.template) {
      this.managers.notifications.error(this.managers.i18n.t('ui', 'operationValidation'), {
        message: interfaceDiagnosticMessage(
          this.managers.i18n,
          compilation.diagnostics.find((item) => item.severity === 'error'),
        ),
      });
      return;
    }
    const result = publishOperationInterface({
      operationInterface: current.operationInterface,
      signature: operationInterfacePublicationSignature(current.operationInterface),
      executionTemplate: compilation.template,
      models: this.managers.data.models,
      relations: this.managers.data.relations,
      existingRelease: current.publishedRelease,
      otherReleases: this.state.savedOperationInterfaces
        .filter((item) => item.id !== id)
        .flatMap((item) => [item.publishedRelease, ...(item.releaseHistory ?? [])])
        .filter(
          (release): release is OperationInterfaceRelease =>
            Boolean(release) && release?.operationInterface.status === 'active',
        ),
    });
    if (!result.ok) {
      this.managers.notifications.error(this.managers.i18n.t('ui', 'operationValidation'), {
        message: interfaceDiagnosticMessage(this.managers.i18n, result.issues[0]),
      });
      return;
    }
    const updated: SavedOperationInterface = {
      ...current,
      operationInterface: result.operationInterface,
      publishedRelease: result.release,
      releaseHistory: appendOperationReleaseHistory(
        current.releaseHistory,
        current.publishedRelease,
      ),
      updatedAt: result.release.publishedAt,
      signature: result.release.signature,
    };
    this.setState(
      (state) => ({
        savedOperationInterfaces: state.savedOperationInterfaces.map((item) =>
          item.id === id ? updated : item,
        ),
      }),
      () => this.persistOperationInterface(updated),
    );
    this.managers.notifications.success(this.managers.i18n.t('ui', 'operationPublished'), {
      message: `${current.name} v${result.release.version}`,
    });
  };

  private handleRollbackOperationInterface = (id: string, version: string): void => {
    const current = this.state.savedOperationInterfaces.find((item) => item.id === id);
    const target = current?.releaseHistory?.find((release) => release.version === version);
    if (!current?.publishedRelease || !target) {
      return;
    }
    const plan = prepareOperationInterfaceRollback({ current: current.publishedRelease, target });
    const compilation = compilePublishedOperationExecutionTemplate({
      operationInterface: plan.draft,
      models: this.managers.data.models,
      relations: this.managers.data.relations,
    });
    if (!compilation.template) {
      this.managers.notifications.error(this.managers.i18n.t('ui', 'releaseRollbackFailed'), {
        message: interfaceDiagnosticMessage(
          this.managers.i18n,
          compilation.diagnostics.find((item) => item.severity === 'error'),
        ),
      });
      return;
    }
    const result = publishOperationInterface({
      operationInterface: plan.draft,
      signature: operationInterfacePublicationSignature(plan.draft),
      executionTemplate: compilation.template,
      models: this.managers.data.models,
      relations: this.managers.data.relations,
      existingRelease: current.publishedRelease,
      otherReleases: this.state.savedOperationInterfaces
        .filter((item) => item.id !== id)
        .flatMap((item) => [item.publishedRelease, ...(item.releaseHistory ?? [])])
        .filter(
          (release): release is OperationInterfaceRelease =>
            Boolean(release) && release?.operationInterface.status === 'active',
        ),
    });
    if (!result.ok) {
      this.managers.notifications.error(this.managers.i18n.t('ui', 'releaseRollbackFailed'), {
        message: interfaceDiagnosticMessage(this.managers.i18n, result.issues[0]),
      });
      return;
    }
    const updated: SavedOperationInterface = {
      ...current,
      publishedRelease: result.release,
      releaseHistory: appendOperationReleaseHistory(
        current.releaseHistory,
        current.publishedRelease,
      ),
      updatedAt: result.release.publishedAt,
    };
    this.setState(
      (state) => ({
        savedOperationInterfaces: state.savedOperationInterfaces.map((item) =>
          item.id === id ? updated : item,
        ),
      }),
      () => this.persistOperationInterface(updated),
    );
    this.managers.notifications.success(this.managers.i18n.t('ui', 'releaseRolledBack'), {
      message: `v${version} -> v${result.release.version}`,
    });
  };

  private handleDeprecateOperationInterface = (id: string): void => {
    const current = this.state.savedOperationInterfaces.find((item) => item.id === id);
    if (!current?.publishedRelease) {
      return;
    }
    const deprecatedAt = new Date().toISOString();
    const publishedRelease = deprecateOperationInterfaceRelease(
      current.publishedRelease,
      deprecatedAt,
    );
    const releaseMatchesDraft =
      operationInterfacePublicationSignature(current.operationInterface) ===
      current.publishedRelease.signature;
    const updated: SavedOperationInterface = {
      ...current,
      publishedRelease,
      releaseHistory: current.releaseHistory?.map((release) =>
        deprecateOperationInterfaceRelease(release, deprecatedAt),
      ),
      operationInterface: releaseMatchesDraft
        ? publishedRelease.operationInterface
        : current.operationInterface,
      updatedAt: publishedRelease.operationInterface.lifecycle.updatedAt,
    };
    this.setState(
      (state) => ({
        savedOperationInterfaces: state.savedOperationInterfaces.map((item) =>
          item.id === id ? updated : item,
        ),
      }),
      () => this.persistOperationInterface(updated),
    );
  };

  private handleDeleteOperationInterface = (id: string): void => {
    this.setState(
      (state) => ({
        savedOperationInterfaces: state.savedOperationInterfaces.filter((item) => item.id !== id),
        activeOperationInterfaceId:
          state.activeOperationInterfaceId === id ? undefined : state.activeOperationInterfaceId,
      }),
      () => this.deletePersistedOperationInterface(id),
    );
  };

  private persistOperationInterface(record: SavedOperationInterface): void {
    this.enqueueOperationInterfaceWrite(record.id, (client, libraryCode) =>
      upsertOperationInterfaceRegistry(client, libraryCode, record),
    );
  }

  private deletePersistedOperationInterface(id: string): void {
    this.enqueueOperationInterfaceWrite(id, (client, libraryCode) =>
      deleteOperationInterfaceRegistry(client, libraryCode, id),
    );
  }

  private enqueueOperationInterfaceWrite(
    id: string,
    write: (client: RemoteModelDBClient, libraryCode: string) => Promise<void>,
  ): void {
    const client = this.managers.config.remoteClient;
    const libraryCode = this.managers.config.activeLibraryName;
    if (!client || !libraryCode || !id) {
      return;
    }
    const key = `${libraryCode}:${id}`;
    const previous = this.operationInterfaceWriteQueue.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => write(client, libraryCode));
    this.operationInterfaceWriteQueue.set(key, task);
    void task
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.warn('[Designer] operation interface registry write failed', error);
        this.managers.notifications.error(this.managers.i18n.t('ui', 'operationValidation'), {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.operationInterfaceWriteQueue.get(key) === task) {
          this.operationInterfaceWriteQueue.delete(key);
        }
      });
  }

  private handleSaveBindingSurface = (
    bindingSurface: BindingSurface,
    name: string,
    description: string,
    activeSurfaceId?: string,
  ): BindingSurfaceSaveResult => {
    const now = new Date().toISOString();
    const displayName = name.trim() || bindingSurface.displayName || bindingSurface.name;
    const normalizedDescription = description.trim();
    const active = activeSurfaceId
      ? this.state.savedBindingSurfaces.find((item) => item.id === activeSurfaceId)
      : undefined;
    const normalized: BindingSurface = {
      ...bindingSurface,
      id: active?.id ?? bindingSurface.id,
      name: uniqueInterfaceName(displayName),
      displayName,
      description: normalizedDescription || undefined,
      lifecycle: {
        ...bindingSurface.lifecycle,
        createdAt: active?.createdAt ?? bindingSurface.lifecycle.createdAt,
        updatedAt: now,
      },
    };
    const signature = bindingSurfacePublicationSignature(normalized);
    const existing =
      active ??
      this.state.savedBindingSurfaces.find(
        (item) =>
          (item.signature ?? bindingSurfacePublicationSignature(item.bindingSurface)) === signature,
      );
    if (existing) {
      const unchanged =
        existing.name === displayName &&
        (existing.signature ?? bindingSurfacePublicationSignature(existing.bindingSurface)) ===
          signature;
      if (unchanged) {
        return { status: 'unchanged', id: existing.id, name: displayName };
      }
      const withIdentity = { ...normalized, id: existing.id };
      const editable =
        existing.publishedRelease &&
        bindingSurfacePublicationSignature(withIdentity) !== existing.publishedRelease.signature
          ? nextDraftBindingSurface(withIdentity, existing.publishedRelease, now)
          : withIdentity;
      const updated: SavedBindingSurface = {
        ...existing,
        name: displayName,
        bindingSurface: editable,
        updatedAt: now,
        signature: bindingSurfacePublicationSignature(editable),
      };
      this.setState(
        (state) => ({
          savedBindingSurfaces: state.savedBindingSurfaces.map((item) =>
            item.id === existing.id ? updated : item,
          ),
          activeBindingSurfaceId: existing.id,
        }),
        () => this.persistBindingSurface(updated),
      );
      return { status: 'updated', id: existing.id, name: displayName };
    }

    const id = `${bindingSurface.id}_${createUuid()}`;
    const savedSurface = { ...normalized, id };
    const saved: SavedBindingSurface = {
      id,
      name: displayName,
      bindingSurface: savedSurface,
      createdAt: now,
      updatedAt: now,
      signature: bindingSurfacePublicationSignature(savedSurface),
    };
    this.setState(
      (state) => ({
        savedBindingSurfaces: [saved, ...state.savedBindingSurfaces],
        activeBindingSurfaceId: id,
      }),
      () => this.persistBindingSurface(saved),
    );
    return { status: 'created', id, name: displayName };
  };

  private handleOpenBindingSurface = (id: string): void => {
    if (this.state.savedBindingSurfaces.some((item) => item.id === id)) {
      this.setState({ activeBindingSurfaceId: id });
    }
  };

  private handleClearActiveBindingSurface = (): void => {
    this.setState({ activeBindingSurfaceId: undefined });
  };

  private handlePublishBindingSurface = (id: string): void => {
    const current = this.state.savedBindingSurfaces.find((item) => item.id === id);
    if (!current) {
      return;
    }
    const queryReleases = this.state.savedQueryInterfaces
      .flatMap((item) => [item.publishedRelease, ...(item.releaseHistory ?? [])])
      .filter(
        (release): release is QueryInterfaceRelease =>
          Boolean(release) && release?.queryInterface.status === 'active',
      );
    const operationReleases = this.state.savedOperationInterfaces
      .flatMap((item) => [item.publishedRelease, ...(item.releaseHistory ?? [])])
      .filter(
        (release): release is OperationInterfaceRelease =>
          Boolean(release) && release?.operationInterface.status === 'active',
      );
    const result = publishBindingSurface({
      bindingSurface: current.bindingSurface,
      signature: bindingSurfacePublicationSignature(current.bindingSurface),
      queryReleases,
      operationReleases,
      existingRelease: current.publishedRelease,
    });
    if (!result.ok) {
      this.managers.notifications.error(this.managers.i18n.t('ui', 'bindingSurfaceValidation'), {
        message: interfaceDiagnosticMessage(this.managers.i18n, result.issues[0]),
      });
      return;
    }
    const updated: SavedBindingSurface = {
      ...current,
      bindingSurface: result.bindingSurface,
      publishedRelease: result.release,
      releaseHistory: appendBindingSurfaceReleaseHistory(
        current.releaseHistory,
        current.publishedRelease,
      ),
      updatedAt: result.release.publishedAt,
      signature: result.release.signature,
    };
    this.setState(
      (state) => ({
        savedBindingSurfaces: state.savedBindingSurfaces.map((item) =>
          item.id === id ? updated : item,
        ),
      }),
      () => this.persistBindingSurface(updated),
    );
    this.managers.notifications.success(this.managers.i18n.t('ui', 'bindingSurfacePublished'), {
      message: `${current.name} v${result.release.version}`,
    });
  };

  private handleRollbackBindingSurface = (id: string, version: string): void => {
    const current = this.state.savedBindingSurfaces.find((item) => item.id === id);
    const target = current?.releaseHistory?.find((release) => release.version === version);
    if (!current?.publishedRelease || !target) {
      return;
    }
    const queryReleases = this.state.savedQueryInterfaces
      .flatMap((item) => [item.publishedRelease, ...(item.releaseHistory ?? [])])
      .filter(
        (release): release is QueryInterfaceRelease =>
          Boolean(release) && release?.queryInterface.status === 'active',
      );
    const operationReleases = this.state.savedOperationInterfaces
      .flatMap((item) => [item.publishedRelease, ...(item.releaseHistory ?? [])])
      .filter(
        (release): release is OperationInterfaceRelease =>
          Boolean(release) && release?.operationInterface.status === 'active',
      );
    const plan = prepareBindingSurfaceRollback({ current: current.publishedRelease, target });
    const result = publishBindingSurface({
      bindingSurface: plan.draft,
      signature: bindingSurfacePublicationSignature(plan.draft),
      queryReleases,
      operationReleases,
      existingRelease: current.publishedRelease,
    });
    if (!result.ok) {
      this.managers.notifications.error(this.managers.i18n.t('ui', 'releaseRollbackFailed'), {
        message: interfaceDiagnosticMessage(this.managers.i18n, result.issues[0]),
      });
      return;
    }
    const updated: SavedBindingSurface = {
      ...current,
      publishedRelease: result.release,
      releaseHistory: appendBindingSurfaceReleaseHistory(
        current.releaseHistory,
        current.publishedRelease,
      ),
      updatedAt: result.release.publishedAt,
    };
    this.setState(
      (state) => ({
        savedBindingSurfaces: state.savedBindingSurfaces.map((item) =>
          item.id === id ? updated : item,
        ),
      }),
      () => this.persistBindingSurface(updated),
    );
    this.managers.notifications.success(this.managers.i18n.t('ui', 'releaseRolledBack'), {
      message: `v${version} -> v${result.release.version}`,
    });
  };

  private handleDeprecateBindingSurface = (id: string): void => {
    const current = this.state.savedBindingSurfaces.find((item) => item.id === id);
    if (!current?.publishedRelease) {
      return;
    }
    const deprecatedAt = new Date().toISOString();
    const publishedRelease = deprecateBindingSurfaceRelease(current.publishedRelease, deprecatedAt);
    const releaseMatchesDraft =
      bindingSurfacePublicationSignature(current.bindingSurface) ===
      current.publishedRelease.signature;
    const updated: SavedBindingSurface = {
      ...current,
      publishedRelease,
      releaseHistory: current.releaseHistory?.map((release) =>
        deprecateBindingSurfaceRelease(release, deprecatedAt),
      ),
      bindingSurface: releaseMatchesDraft
        ? publishedRelease.bindingSurface
        : current.bindingSurface,
      updatedAt: publishedRelease.bindingSurface.lifecycle.updatedAt,
    };
    this.setState(
      (state) => ({
        savedBindingSurfaces: state.savedBindingSurfaces.map((item) =>
          item.id === id ? updated : item,
        ),
      }),
      () => this.persistBindingSurface(updated),
    );
  };

  private handleDeleteBindingSurface = (id: string): void => {
    this.setState(
      (state) => ({
        savedBindingSurfaces: state.savedBindingSurfaces.filter((item) => item.id !== id),
        activeBindingSurfaceId:
          state.activeBindingSurfaceId === id ? undefined : state.activeBindingSurfaceId,
      }),
      () => this.deletePersistedBindingSurface(id),
    );
  };

  private persistBindingSurface(record: SavedBindingSurface): void {
    this.enqueueBindingSurfaceWrite(record.id, (client, libraryCode) =>
      upsertBindingSurfaceRegistry(client, libraryCode, record),
    );
  }

  private deletePersistedBindingSurface(id: string): void {
    this.enqueueBindingSurfaceWrite(id, (client, libraryCode) =>
      deleteBindingSurfaceRegistry(client, libraryCode, id),
    );
  }

  private enqueueBindingSurfaceWrite(
    id: string,
    write: (client: RemoteModelDBClient, libraryCode: string) => Promise<void>,
  ): void {
    const client = this.managers.config.remoteClient;
    const libraryCode = this.managers.config.activeLibraryName;
    if (!client || !libraryCode || !id) {
      return;
    }
    const key = `${libraryCode}:${id}`;
    const previous = this.bindingSurfaceWriteQueue.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => write(client, libraryCode));
    this.bindingSurfaceWriteQueue.set(key, task);
    void task
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.warn('[Designer] binding surface registry write failed', error);
        this.managers.notifications.error(this.managers.i18n.t('ui', 'bindingSurfaceValidation'), {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.bindingSurfaceWriteQueue.get(key) === task) {
          this.bindingSurfaceWriteQueue.delete(key);
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
      savedOperationInterfaces,
      activeOperationInterfaceId,
      savedBindingSurfaces,
      activeBindingSurfaceId,
    } = this.state;
    const activeQueryInterface = activeQueryInterfaceId
      ? savedQueryInterfaces.find((item) => item.id === activeQueryInterfaceId)
      : undefined;
    const activeOperationInterface = activeOperationInterfaceId
      ? savedOperationInterfaces.find((item) => item.id === activeOperationInterfaceId)
      : undefined;
    const activeBindingSurface = activeBindingSurfaceId
      ? savedBindingSurfaces.find((item) => item.id === activeBindingSurfaceId)
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
          savedOperationInterfaces={savedOperationInterfaces}
          activeOperationInterface={activeOperationInterface}
          savedBindingSurfaces={savedBindingSurfaces}
          activeBindingSurface={activeBindingSurface}
          onQueryChainChange={this.handleQueryChainChange}
          onResolveQueryRelationPick={this.handleResolveQueryRelationPick}
          onCancelQueryRelationPick={this.handleCancelQueryRelationPick}
          onResolveQueryModelPick={this.handleResolveQueryModelPick}
          onCancelQueryModelPick={this.handleCancelQueryModelPick}
          onSaveQueryInterface={this.handleSaveQueryInterface}
          onClearActiveQueryInterface={this.handleClearActiveQueryInterface}
          onOpenQueryInterface={this.handleOpenQueryInterface}
          onRenameQueryInterface={this.handleRenameQueryInterface}
          onPublishQueryInterface={this.handlePublishQueryInterface}
          onRollbackQueryInterface={this.handleRollbackQueryInterface}
          onDeprecateQueryInterface={this.handleDeprecateQueryInterface}
          onDeleteQueryInterface={this.handleDeleteQueryInterface}
          onSaveOperationInterface={this.handleSaveOperationInterface}
          onClearActiveOperationInterface={this.handleClearActiveOperationInterface}
          onOpenOperationInterface={this.handleOpenOperationInterface}
          onPublishOperationInterface={this.handlePublishOperationInterface}
          onRollbackOperationInterface={this.handleRollbackOperationInterface}
          onDeprecateOperationInterface={this.handleDeprecateOperationInterface}
          onDeleteOperationInterface={this.handleDeleteOperationInterface}
          onSaveBindingSurface={this.handleSaveBindingSurface}
          onClearActiveBindingSurface={this.handleClearActiveBindingSurface}
          onOpenBindingSurface={this.handleOpenBindingSurface}
          onPublishBindingSurface={this.handlePublishBindingSurface}
          onRollbackBindingSurface={this.handleRollbackBindingSurface}
          onDeprecateBindingSurface={this.handleDeprecateBindingSurface}
          onDeleteBindingSurface={this.handleDeleteBindingSurface}
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
      filterTree: queryInterface.query.filterTree,
      filters: queryInterface.query.filters,
      aggregation: queryInterface.query.aggregation,
      sorts: queryInterface.query.sorts,
      projection: queryInterface.query.projection,
      pagination: queryInterface.query.pagination,
      result: queryInterface.query.result,
      binding: queryInterface.query.binding,
    },
  });
}
