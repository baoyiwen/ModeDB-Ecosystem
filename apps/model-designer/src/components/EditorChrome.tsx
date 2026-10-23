import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AppDrawer, useAppConfirm } from '@mode-db/data-ui';
import { useDesigner } from '../context/designer-context.js';
import { withBusinessLibrarySession } from '../engine/business-library-session.js';
import { isInheritRelation } from '../config/graph-edge-kinds.js';
import { isQueryDesignerMode, isSidePanelReadOnly } from '../managers/mode-manager.js';
import { InfoPanel } from './InfoPanel.js';
import { PropsEditor } from './PropsEditor.js';
import { ActiveLibraryPanel } from './ActiveLibraryPanel.js';
import { NotificationCenter } from './NotificationCenter.js';
import { LayerTreePanel } from './LayerTreePanel.js';
import { RelationDetailPanel } from './RelationDetailPanel.js';
import { PivotTab } from './PivotTab.js';
import { ModelMapWorkspace } from './ModelMapWorkspace.js';
import { SecurityCenterWorkspace } from './SecurityCenterWorkspace.js';
import {
  QueryDesignerPanel,
  QueryInterfaceManagerPanel,
  type QueryInterfaceSaveResult,
  type SavedQueryInterfaceView,
} from './QueryDesignerPanel.js';
import type {
  OperationInterfaceSaveResult,
  SavedOperationInterfaceView,
} from './OperationDesignerPanel.js';
import type { SavedBindingSurfaceView } from './BindingSurfaceDesignerPanel.js';
import { DesignerSelect } from './base/designer-select.js';
import type { LocaleCode } from '../managers/i18n-manager.js';
import {
  IconDocument,
  IconGrid,
  IconLayers,
  IconLink,
  IconSettings,
  IconBell,
  IconShield,
} from './designer-icons.js';
import type {
  QueryChainState,
  QueryInterface,
  OperationInterface,
  BindingSurface,
  QueryModelPickCandidate,
  QueryRelationPickCandidate,
} from '../query-designer/index.js';

const OperationDesignerPanel = lazy(() => import('./OperationDesignerPanel.js'));
const BindingSurfaceDesignerPanel = lazy(() => import('./BindingSurfaceDesignerPanel.js'));

export type ManualPanelKind =
  | 'hierarchy'
  | 'interfaces'
  | 'query-interface'
  | 'operations'
  | 'bindings'
  | 'pivot'
  | 'settings'
  | 'security'
  | 'notifications';

type PivotContext =
  | { readonly kind: 'model'; readonly modelId: string }
  | { readonly kind: 'interface'; readonly interfaceId: string };

export function EditorChrome(props: {
  selectedModelId: string | undefined;
  selectedRelationId: string | undefined;
  queryChain: QueryChainState;
  pendingQueryRelationPick:
    | { relationId: string; candidates: readonly QueryRelationPickCandidate[] }
    | undefined;
  pendingQueryModelPick:
    | { modelId: string; candidates: readonly QueryModelPickCandidate[] }
    | undefined;
  savedQueryInterfaces: readonly SavedQueryInterfaceView[];
  activeQueryInterface: SavedQueryInterfaceView | undefined;
  savedOperationInterfaces: readonly SavedOperationInterfaceView[];
  activeOperationInterface: SavedOperationInterfaceView | undefined;
  savedBindingSurfaces: readonly SavedBindingSurfaceView[];
  activeBindingSurface: SavedBindingSurfaceView | undefined;
  onQueryChainChange: (queryChain: QueryChainState) => void;
  onResolveQueryRelationPick: (sourceNodeIds: readonly string[]) => void;
  onCancelQueryRelationPick: () => void;
  onResolveQueryModelPick: (candidates: readonly QueryModelPickCandidate[]) => void;
  onCancelQueryModelPick: () => void;
  onSaveQueryInterface: (
    queryInterface: QueryInterface,
    queryChain: QueryChainState,
    name: string,
    description: string,
    activeInterfaceId?: string,
    projectionConfigured?: boolean,
  ) => QueryInterfaceSaveResult;
  onClearActiveQueryInterface: () => void;
  onOpenQueryInterface: (id: string) => void;
  onRenameQueryInterface: (id: string, name: string) => void;
  onPublishQueryInterface: (id: string) => void;
  onRollbackQueryInterface: (id: string, version: string) => void;
  onDeprecateQueryInterface: (id: string) => void;
  onDeleteQueryInterface: (id: string) => void;
  onSaveOperationInterface: (
    operationInterface: OperationInterface,
    name: string,
    description: string,
    activeInterfaceId?: string,
  ) => OperationInterfaceSaveResult;
  onClearActiveOperationInterface: () => void;
  onOpenOperationInterface: (id: string) => void;
  onPublishOperationInterface: (id: string) => void;
  onRollbackOperationInterface: (id: string, version: string) => void;
  onDeprecateOperationInterface: (id: string) => void;
  onDeleteOperationInterface: (id: string) => void;
  onSaveBindingSurface: (
    surface: BindingSurface,
    name: string,
    description: string,
    activeId?: string,
  ) => OperationInterfaceSaveResult;
  onClearActiveBindingSurface: () => void;
  onOpenBindingSurface: (id: string) => void;
  onPublishBindingSurface: (id: string) => void;
  onRollbackBindingSurface: (id: string, version: string) => void;
  onDeprecateBindingSurface: (id: string) => void;
  onDeleteBindingSurface: (id: string) => void;
  onRequestClearCanvasSelection: () => void;
  children: ReactNode;
}): ReactElement {
  const { i18n, appearance, modes, data, config, notifications, asyncOps } = useDesigner();
  const confirm = useAppConfirm();
  const [, bump] = useState(0);
  const [notifyBump, setNotifyBump] = useState(0);
  useEffect(() => i18n.subscribe(() => bump((n) => n + 1)), [i18n]);
  useEffect(() => appearance.subscribe(() => bump((n) => n + 1)), [appearance]);
  useEffect(() => modes.subscribe(() => bump((n) => n + 1)), [modes]);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);
  useEffect(() => notifications.subscribe(() => setNotifyBump((n) => n + 1)), [notifications]);
  void notifyBump;

  const readOnly = isSidePanelReadOnly(modes.mode);
  const selectedRel = props.selectedRelationId
    ? data.relations.find((r) => r.id === props.selectedRelationId)
    : undefined;
  const inheritAsModelId =
    selectedRel && isInheritRelation(selectedRel.kind) ? selectedRel.target_model_id : undefined;
  const effectiveModelId = props.selectedModelId ?? inheritAsModelId;
  const showRelationDetail = Boolean(
    props.selectedRelationId && selectedRel && !isInheritRelation(selectedRel.kind),
  );

  const [manualPanel, setManualPanel] = useState<ManualPanelKind | null>(null);
  const [pivotContext, setPivotContext] = useState<PivotContext | undefined>();
  const [pivotReturnPanel, setPivotReturnPanel] = useState<ManualPanelKind | null>(null);
  const [pivotReturnInterfaceId, setPivotReturnInterfaceId] = useState<string>();
  const [modelMapOpen, setModelMapOpen] = useState(false);
  const [securityReturnPanel, setSecurityReturnPanel] = useState<ManualPanelKind | null>(null);

  useEffect(() => {
    if (isQueryDesignerMode(modes.mode)) {
      setManualPanel((current) =>
        current === 'interfaces' ||
        current === 'query-interface' ||
        current === 'operations' ||
        current === 'bindings' ||
        current === 'pivot' ||
        current === 'security'
          ? current
          : null,
      );
    }
  }, [modes.mode]);

  useEffect(() => {
    if (modes.mode === 'page') {
      setManualPanel('hierarchy');
    }
  }, [modes.mode]);

  const passiveOpen = Boolean(effectiveModelId || showRelationDetail);
  const manualOpen = manualPanel !== null;
  const queryOpen = isQueryDesignerMode(modes.mode);
  const shellOpen = passiveOpen || manualOpen || queryOpen;
  const interfaceWorkspaceOpen =
    manualPanel === 'interfaces' ||
    manualPanel === 'query-interface' ||
    manualPanel === 'operations' ||
    manualPanel === 'bindings';
  const pivotOpen = manualPanel === 'pivot';
  const securityOpen = manualPanel === 'security';

  const closeAll = useCallback((): void => {
    if (securityOpen) {
      setManualPanel(securityReturnPanel);
      setSecurityReturnPanel(null);
      return;
    }
    if (pivotOpen) {
      setManualPanel(pivotReturnPanel);
      setPivotContext(undefined);
      return;
    }
    if (manualOpen) {
      setManualPanel(null);
      setPivotContext(undefined);
      if (modes.mode === 'page') {
        modes.setMode('select');
      }
      return;
    }
    if (passiveOpen) {
      props.onRequestClearCanvasSelection();
      return;
    }
    if (queryOpen) {
      modes.setMode('select');
    }
  }, [
    securityOpen,
    securityReturnPanel,
    pivotOpen,
    pivotReturnPanel,
    manualOpen,
    modes,
    passiveOpen,
    props,
    queryOpen,
  ]);

  const openPivot = useCallback(
    (context: PivotContext): void => {
      setPivotReturnPanel(manualPanel === 'pivot' ? pivotReturnPanel : manualPanel);
      setPivotReturnInterfaceId(context.kind === 'interface' ? context.interfaceId : undefined);
      setPivotContext(context);
      setManualPanel('pivot');
    },
    [manualPanel, pivotReturnPanel],
  );

  const openManual = useCallback(
    (kind: ManualPanelKind): void => {
      const next = manualPanel === kind ? null : kind;
      if (next === 'notifications') {
        notifications.markAllRead();
      }
      setManualPanel(next);
      if (modes.mode === 'page' && next !== 'hierarchy') {
        modes.setMode('select');
      }
    },
    [manualPanel, modes, notifications],
  );

  const openSecurityCenter = useCallback((): void => {
    if (manualPanel === 'security') {
      setManualPanel(securityReturnPanel);
      setSecurityReturnPanel(null);
      return;
    }
    setSecurityReturnPanel(manualPanel);
    setManualPanel('security');
  }, [manualPanel, securityReturnPanel]);

  const title = (): string => {
    if (manualPanel === 'hierarchy') {
      return i18n.t('ui', 'panelHierarchy');
    }
    if (manualPanel === 'settings') {
      return i18n.t('ui', 'settings');
    }
    if (manualPanel === 'security') {
      return i18n.t('ui', 'securityCenterTitle');
    }
    if (manualPanel === 'notifications') {
      return i18n.t('ui', 'notifyCenterTitle');
    }
    if (manualPanel === 'interfaces') {
      return i18n.t('ui', 'interfaceWorkspaceQueries');
    }
    if (manualPanel === 'query-interface') {
      return props.activeQueryInterface?.name ?? i18n.t('ui', 'interfaceWorkspaceQueryEditor');
    }
    if (manualPanel === 'operations') {
      return i18n.t('ui', 'operationDesigner');
    }
    if (manualPanel === 'bindings') {
      return i18n.t('ui', 'bindingSurfaceDesigner');
    }
    if (manualPanel === 'pivot') {
      return i18n.t('ui', 'pivotTitle');
    }
    if (queryOpen) {
      return i18n.t('ui', 'modeQueryDesigner');
    }
    if (showRelationDetail) {
      return i18n.t('ui', 'relations');
    }
    if (effectiveModelId) {
      return i18n.t('ui', 'panelModelDetails');
    }
    return '';
  };

  const renderBody = (): ReactElement | null => {
    if (manualPanel === 'security') {
      return <SecurityCenterWorkspace />;
    }
    if (manualPanel === 'hierarchy') {
      return <LayerTreePanel selectedId={effectiveModelId} readOnly={readOnly} />;
    }
    if (manualPanel === 'notifications') {
      return <NotificationCenter />;
    }
    if (manualPanel === 'interfaces') {
      return (
        <div className="interface-manager-stack interface-workspace-query-list">
          <QueryInterfaceManagerPanel
            expandedInterfaceId={pivotReturnInterfaceId}
            savedQueryInterfaces={props.savedQueryInterfaces}
            onOpenQueryInterface={(id) => {
              props.onOpenQueryInterface(id);
              setManualPanel('query-interface');
            }}
            onOpenPivot={(id) => openPivot({ kind: 'interface', interfaceId: id })}
            onRenameQueryInterface={props.onRenameQueryInterface}
            onPublishQueryInterface={props.onPublishQueryInterface}
            onRollbackQueryInterface={props.onRollbackQueryInterface}
            onDeprecateQueryInterface={props.onDeprecateQueryInterface}
            onDeleteQueryInterface={props.onDeleteQueryInterface}
          />
        </div>
      );
    }
    if (manualPanel === 'query-interface') {
      return (
        <div className="query-interface-editor-stack">
          <div className="pivot-context-action">
            <span>{i18n.t('ui', 'pivotInterfacePreviewHint')}</span>
            <button
              type="button"
              className="designer-btn"
              disabled={!props.activeQueryInterface?.publishedRelease}
              onClick={() => {
                if (props.activeQueryInterface) {
                  openPivot({ kind: 'interface', interfaceId: props.activeQueryInterface.id });
                }
              }}
            >
              {i18n.t('ui', 'pivotOpenViewer')}
            </button>
          </div>
          <QueryDesignerPanel
            selectedModelId={props.selectedModelId}
            queryChain={props.queryChain}
            pendingQueryRelationPick={props.pendingQueryRelationPick}
            pendingQueryModelPick={props.pendingQueryModelPick}
            activeQueryInterface={props.activeQueryInterface}
            onQueryChainChange={props.onQueryChainChange}
            onResolveQueryRelationPick={props.onResolveQueryRelationPick}
            onCancelQueryRelationPick={props.onCancelQueryRelationPick}
            onResolveQueryModelPick={props.onResolveQueryModelPick}
            onCancelQueryModelPick={props.onCancelQueryModelPick}
            onSaveQueryInterface={props.onSaveQueryInterface}
            onClearActiveQueryInterface={props.onClearActiveQueryInterface}
          />
        </div>
      );
    }
    if (manualPanel === 'operations') {
      return (
        <Suspense fallback={<div className="operation-designer-loading" aria-busy="true" />}>
          <OperationDesignerPanel
            savedOperationInterfaces={props.savedOperationInterfaces}
            activeOperationInterface={props.activeOperationInterface}
            selectedModelId={props.selectedModelId}
            onSaveOperationInterface={props.onSaveOperationInterface}
            onClearActiveOperationInterface={props.onClearActiveOperationInterface}
            onOpenOperationInterface={props.onOpenOperationInterface}
            onPublishOperationInterface={props.onPublishOperationInterface}
            onRollbackOperationInterface={props.onRollbackOperationInterface}
            onDeprecateOperationInterface={props.onDeprecateOperationInterface}
            onDeleteOperationInterface={props.onDeleteOperationInterface}
          />
        </Suspense>
      );
    }
    if (manualPanel === 'bindings') {
      return (
        <Suspense fallback={<div className="operation-designer-loading" aria-busy="true" />}>
          <BindingSurfaceDesignerPanel
            savedBindingSurfaces={props.savedBindingSurfaces}
            activeBindingSurface={props.activeBindingSurface}
            savedQueryInterfaces={props.savedQueryInterfaces}
            savedOperationInterfaces={props.savedOperationInterfaces}
            onSaveBindingSurface={props.onSaveBindingSurface}
            onClearActiveBindingSurface={props.onClearActiveBindingSurface}
            onOpenBindingSurface={props.onOpenBindingSurface}
            onPublishBindingSurface={props.onPublishBindingSurface}
            onRollbackBindingSurface={props.onRollbackBindingSurface}
            onDeprecateBindingSurface={props.onDeprecateBindingSurface}
            onDeleteBindingSurface={props.onDeleteBindingSurface}
          />
        </Suspense>
      );
    }
    if (manualPanel === 'pivot') {
      return (
        <PivotTab
          savedQueryInterfaces={props.savedQueryInterfaces}
          sourceContext={pivotContext}
          onBack={closeAll}
        />
      );
    }
    if (manualPanel === 'settings') {
      const currentAccent = appearance.accent.toLowerCase();
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <label className="designer-settings-row">
            <span className="designer-panel-section-title" style={{ margin: 0 }}>
              {i18n.t('ui', 'locale')}
            </span>
            <DesignerSelect
              value={i18n.locale}
              options={[
                { value: 'en', label: 'English' },
                { value: 'zh', label: 'Chinese' },
                { value: 'ja', label: 'Japanese' },
              ]}
              onChange={(value) => i18n.setLocale(value as LocaleCode)}
            />
          </label>

          <div className="designer-settings-row">
            <span className="designer-panel-section-title" style={{ margin: 0 }}>
              {i18n.t('ui', 'themeColor')}
            </span>
            <div className="designer-accent-row">
              {appearance.presets.map((preset) => {
                const swatchStyle = { '--swatch-color': preset.color } as CSSProperties;
                const selected = preset.color.toLowerCase() === currentAccent;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className="designer-accent-swatch"
                    aria-pressed={selected}
                    aria-label={preset.id}
                    title={preset.color}
                    style={swatchStyle}
                    onClick={() => appearance.setAccent(preset.color)}
                  />
                );
              })}
              <input
                className="designer-accent-picker"
                type="color"
                aria-label={i18n.t('ui', 'themeColorCustom')}
                title={i18n.t('ui', 'themeColorCustom')}
                value={currentAccent}
                onChange={(e) => appearance.setAccent(e.target.value)}
              />
            </div>
          </div>

          <ActiveLibraryPanel onLibrarySwitched={props.onRequestClearCanvasSelection} />

          <div
            className="designer-settings-row"
            style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}
          >
            <span className="designer-panel-section-title" style={{ margin: 0 }}>
              {i18n.t('ui', 'dataSectionTitle')}
            </span>
            <p style={{ fontSize: 12, color: 'var(--designer-text-soft)', margin: 0 }}>
              {i18n.t('ui', 'dataClearAllHint')}
            </p>
            <button
              type="button"
              className="designer-tree-action designer-tree-action--danger"
              disabled={!config.remoteClient || !config.activeLibraryName || asyncOps.isBusy}
              onClick={async () => {
                const lib = config.activeLibraryName;
                if (!config.remoteClient || !lib) {
                  return;
                }
                if (
                  !(await confirm({
                    title: i18n.t('ui', 'dataConfirmClearAll', { name: lib }),
                    tone: 'danger',
                  }))
                ) {
                  return;
                }
                try {
                  await asyncOps.run(
                    'clearAllData',
                    () =>
                      withBusinessLibrarySession(lib, (businessClient) =>
                        businessClient.apply({ op: 'clearAllData' }),
                      ),
                    { detail: lib },
                  );
                } catch {
                  // The async operation manager displays the failure toast.
                }
              }}
            >
              {i18n.t('ui', 'dataClearAll')}
            </button>
          </div>
        </div>
      );
    }
    if (queryOpen) {
      return (
        <QueryDesignerPanel
          selectedModelId={props.selectedModelId}
          queryChain={props.queryChain}
          pendingQueryRelationPick={props.pendingQueryRelationPick}
          pendingQueryModelPick={props.pendingQueryModelPick}
          activeQueryInterface={props.activeQueryInterface}
          onQueryChainChange={props.onQueryChainChange}
          onResolveQueryRelationPick={props.onResolveQueryRelationPick}
          onCancelQueryRelationPick={props.onCancelQueryRelationPick}
          onResolveQueryModelPick={props.onResolveQueryModelPick}
          onCancelQueryModelPick={props.onCancelQueryModelPick}
          onSaveQueryInterface={props.onSaveQueryInterface}
          onClearActiveQueryInterface={props.onClearActiveQueryInterface}
        />
      );
    }
    if (showRelationDetail && props.selectedRelationId) {
      return (
        <RelationDetailPanel
          key={props.selectedRelationId}
          relationId={props.selectedRelationId}
          readOnly={readOnly}
        />
      );
    }
    if (effectiveModelId) {
      return (
        <div className="designer-passive-panels">
          <section className="designer-passive-section">
            <div className="designer-passive-section-header">
              <h3 className="designer-panel-section-title">{i18n.t('ui', 'info')}</h3>
              <button
                type="button"
                className="designer-btn"
                onClick={() => openPivot({ kind: 'model', modelId: effectiveModelId })}
              >
                {i18n.t('ui', 'pivotOpenViewer')}
              </button>
            </div>
            <InfoPanel key={effectiveModelId} modelId={effectiveModelId} readOnly={readOnly} />
          </section>
          <section className="designer-passive-section">
            <h3 className="designer-panel-section-title">{i18n.t('ui', 'props')}</h3>
            <PropsEditor key={effectiveModelId} modelId={effectiveModelId} readOnly={readOnly} />
          </section>
        </div>
      );
    }
    return null;
  };

  const body = renderBody();
  const workspaceBody = interfaceWorkspaceOpen ? (
    <div className="interface-workspace-layout">
      <aside
        className="interface-workspace-navigation"
        aria-label={i18n.t('ui', 'interfaceManager')}
      >
        <div className="interface-workspace-navigation-title">
          <span>{i18n.t('ui', 'interfaceWorkspaceTitle')}</span>
          <small>{config.activeLibraryName ?? '-'}</small>
        </div>
        <nav>
          <button
            type="button"
            data-active={
              manualPanel === 'interfaces' || manualPanel === 'query-interface' ? 'true' : 'false'
            }
            onClick={() => setManualPanel('interfaces')}
          >
            <IconDocument />
            <span>{i18n.t('ui', 'interfaceWorkspaceQueries')}</span>
            <strong>{props.savedQueryInterfaces.length}</strong>
          </button>
          <button
            type="button"
            data-active={manualPanel === 'operations' ? 'true' : 'false'}
            onClick={() => setManualPanel('operations')}
          >
            <IconLink />
            <span>{i18n.t('ui', 'interfaceWorkspaceOperations')}</span>
            <strong>{props.savedOperationInterfaces.length}</strong>
          </button>
          <button
            type="button"
            data-active={manualPanel === 'bindings' ? 'true' : 'false'}
            onClick={() => setManualPanel('bindings')}
          >
            <IconGrid />
            <span>{i18n.t('ui', 'interfaceWorkspaceBindings')}</span>
            <strong>{props.savedBindingSurfaces.length}</strong>
          </button>
        </nav>
      </aside>
      <main className="interface-workspace-content">{body}</main>
    </div>
  ) : (
    body
  );

  return (
    <>
      {props.children}

      {modelMapOpen ? <ModelMapWorkspace onClose={() => setModelMapOpen(false)} /> : null}

      <div className="designer-panel-fabs designer-panel-fabs--row" aria-label="Panel toggles">
        <button
          type="button"
          className="designer-fab designer-fab--panel"
          aria-label={i18n.t('ui', 'modelMapTitle')}
          title={i18n.t('ui', 'modelMapTitle')}
          onClick={() => setModelMapOpen(true)}
        >
          <IconLayers />
        </button>
        <button
          type="button"
          className="designer-fab designer-fab--panel"
          data-active={manualPanel === 'hierarchy' ? 'true' : 'false'}
          title={i18n.t('ui', 'fabLayers')}
          onClick={() => openManual('hierarchy')}
        >
          <IconGrid />
        </button>
        <button
          type="button"
          className="designer-fab designer-fab--panel"
          data-active={interfaceWorkspaceOpen ? 'true' : 'false'}
          title={i18n.t('ui', 'interfaceManager')}
          onClick={() => openManual('interfaces')}
        >
          <IconDocument />
        </button>
        <button
          type="button"
          className="designer-fab designer-fab--panel designer-fab--notify"
          data-active={manualPanel === 'notifications' ? 'true' : 'false'}
          title={i18n.t('ui', 'fabNotifications')}
          onClick={() => openManual('notifications')}
        >
          <IconBell />
          {notifications.unreadCount > 0 ? (
            <span className="designer-notify-fab-badge" aria-hidden>
              {notifications.unreadCount > 99 ? '99+' : notifications.unreadCount}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="designer-fab designer-fab--panel"
          data-active={manualPanel === 'security' ? 'true' : 'false'}
          title={i18n.t('ui', 'fabSecurity')}
          onClick={openSecurityCenter}
        >
          <IconShield />
        </button>
        <button
          type="button"
          className="designer-fab designer-fab--panel"
          data-active={manualPanel === 'settings' ? 'true' : 'false'}
          title={i18n.t('ui', 'fabSettings')}
          onClick={() => openManual('settings')}
        >
          <IconSettings />
        </button>
      </div>

      <AppDrawer
        open={shellOpen}
        title={shellOpen ? title() : ''}
        eyebrow={interfaceWorkspaceOpen ? i18n.t('ui', 'interfaceWorkspaceEyebrow') : 'ModeDB'}
        side="right"
        width={
          pivotOpen || securityOpen ? '100vw' : interfaceWorkspaceOpen ? 'calc(100vw - 32px)' : 430
        }
        closeLabel={i18n.t('ui', 'notifyDismiss')}
        onClose={closeAll}
        className={
          pivotOpen
            ? 'designer-pivot-workspace'
            : securityOpen
              ? 'designer-security-center-workspace'
              : interfaceWorkspaceOpen
                ? 'designer-interface-workspace'
                : undefined
        }
        bodyClassName={[
          'designer-panel-body',
          !pivotOpen ? 'designer-scrollbar-hide' : '',
          queryOpen && !manualOpen ? 'designer-panel-body--query' : '',
          manualPanel === 'notifications' ? 'designer-panel-body--notifications' : '',
          interfaceWorkspaceOpen ? 'designer-panel-body--interface-workspace' : '',
          pivotOpen ? 'designer-panel-body--pivot' : '',
          securityOpen ? 'designer-panel-body--security-center' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        labelledById="designer-drawer-title"
        withScrim={pivotOpen}
      >
        {workspaceBody}
      </AppDrawer>
    </>
  );
}
