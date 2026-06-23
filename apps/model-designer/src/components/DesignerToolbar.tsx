import type { ReactNode } from 'react';
import { DesignerComponent } from './base/designer-component.js';
import { pushLibraryToEngine } from '../sync/designer-push-sync.js';
import {
  importEngineCatalogIntoDesignerDb,
  readBusinessCatalog,
} from '../sync/engine-catalog-import.js';
import {
  getSessionToken,
  getStoredHost,
  getStoredPort,
  getStoredToken,
} from '../config/connection-prefs.js';
import { formatInteractionState } from '../utils/interaction-state-i18n.js';
import { interactionStateForToolMode } from '../utils/tool-mode-state.js';
import { formatLibraryLabel } from '../sync/library-registry.js';
import {
  IconCheckSquare,
  IconDocument,
  IconExport,
  IconForceLayout,
  IconGrid,
  IconSnap,
  IconHand,
  IconLink,
  IconLogout,
  IconPan,
  IconPlus,
  IconRedo,
  IconSave,
  IconSearch,
  IconTrash,
  IconUndo,
} from './designer-icons.js';
export interface DesignerToolbarProps {
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onDisconnected: () => void;
}

/**
 * 浮动圆形工具栏（顶/左/底）+ 断开连接；与参考图布局一致。
 */
export class DesignerToolbar extends DesignerComponent<
  DesignerToolbarProps,
  Record<string, never>
> {
  private i18nUnsub: (() => void) | undefined;
  private modesUnsub: (() => void) | undefined;
  private stateUnsub: (() => void) | undefined;
  private libraryUnsub: (() => void) | undefined;
  private asyncUnsub: (() => void) | undefined;

  override componentDidMount(): void {
    this.i18nUnsub = this.managers.i18n.subscribe(() => this.forceUpdate());
    this.modesUnsub = this.managers.modes.subscribe(() => this.forceUpdate());
    this.stateUnsub = this.managers.state.subscribe(() => this.forceUpdate());
    this.libraryUnsub = this.managers.config.subscribeLibrary(() => this.forceUpdate());
    this.asyncUnsub = this.managers.asyncOps.subscribe(() => this.forceUpdate());
  }

  override componentWillUnmount(): void {
    this.i18nUnsub?.();
    this.modesUnsub?.();
    this.stateUnsub?.();
    this.libraryUnsub?.();
    this.asyncUnsub?.();
  }

  override render(): ReactNode {
    const { state, i18n, data, config, modes, graphSync, asyncOps } = this.managers;
    const st = state.state;
    const client = config.remoteClient;
    const mode = modes.mode;
    const libName = config.activeLibraryName;
    const libTag =
      libName !== null
        ? formatLibraryLabel(
            { code: libName, name: config.activeLibraryNameI18n ?? { en: libName } },
            i18n.locale,
          )
        : null;
    const remoteBusy = asyncOps.isBusy;

    const disconnect = (): void => {
      client?.close();
      config.setRemoteClient(null, false);
      this.props.onDisconnected();
    };

    return (
      <div className="designer-float-layer" aria-hidden={false}>
        <div className="designer-float-top">
          <button type="button" className="designer-mode-pill designer-mode-pill--active" disabled>
            {i18n.t('ui', 'modeModelDesigner')}
            {libTag ? <span className="designer-library-tag"> · {libTag}</span> : null}
          </button>
          <button
            type="button"
            className="designer-mode-pill designer-mode-pill--inactive"
            disabled
            title={i18n.t('ui', 'modeQueryDesignerHint')}
          >
            {i18n.t('ui', 'modeQueryDesigner')}
          </button>
        </div>

        <div className="designer-float-left">
          <button
            type="button"
            className="designer-fab"
            data-active={mode === 'select' ? 'true' : 'false'}
            title={i18n.t('ui', 'toolSelect')}
            onClick={() => {
              modes.setMode('select');
              state.transition(interactionStateForToolMode('select'));
            }}
          >
            <IconHand />
          </button>
          <button
            type="button"
            className="designer-fab"
            data-active={mode === 'add' ? 'true' : 'false'}
            title={i18n.t('ui', 'toolCreate')}
            onClick={() => {
              modes.setMode('add');
              state.transition(interactionStateForToolMode('add'));
            }}
          >
            <IconPlus />
          </button>
          <button type="button" className="designer-fab" title={i18n.t('ui', 'toolEdit')} disabled>
            <IconDocument />
          </button>
          <button
            type="button"
            className="designer-fab"
            data-active={mode === 'delete' ? 'true' : 'false'}
            title={i18n.t('ui', 'toolDelete')}
            onClick={() => {
              modes.setMode('delete');
              state.transition(interactionStateForToolMode('delete'));
            }}
          >
            <IconTrash />
          </button>
          <button type="button" className="designer-fab" title={i18n.t('ui', 'toolMulti')} disabled>
            <IconCheckSquare />
          </button>
          <button
            type="button"
            className="designer-fab"
            data-active={mode === 'link' ? 'true' : 'false'}
            title={i18n.t('ui', 'toolLinkHint')}
            onClick={() => {
              modes.setMode('link');
              state.transition(interactionStateForToolMode('link'));
            }}
          >
            <IconLink />
          </button>
        </div>

        <div className="designer-float-bottom">
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolPan')}
            disabled
          >
            <IconPan />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolZoom')}
            disabled
          >
            <IconSearch />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolUndo')}
            disabled
          >
            <IconUndo />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolRedo')}
            disabled
          >
            <IconRedo />
          </button>
          <button
            type="button"
            className="designer-fab"
            title={i18n.t('ui', 'toolSave')}
            disabled={!client || !libName || remoteBusy}
            data-busy={asyncOps.isActive('save') ? 'true' : undefined}
            onClick={async () => {
              if (!client || !libName || remoteBusy) {
                return;
              }
              try {
                await asyncOps.run(
                  'save',
                  () =>
                    pushLibraryToEngine({
                      designerClient: client,
                      libraryCode: libName,
                      data,
                      graphSync,
                      host: getStoredHost('127.0.0.1'),
                      port: getStoredPort(9090),
                      token: getSessionToken() ?? getStoredToken(''),
                    }),
                  { detail: libName },
                );
              } catch {
                /* 失败态由右侧 toast 展示 */
              }
            }}
          >
            <IconSave />
          </button>
          <button
            type="button"
            className="designer-fab"
            title={i18n.t('ui', 'toolExport')}
            disabled={!client || !libName || remoteBusy}
            data-busy={asyncOps.isActive('pull') ? 'true' : undefined}
            onClick={async () => {
              if (!client || !libName || remoteBusy) {
                return;
              }
              try {
                await asyncOps.run(
                  'pull',
                  async () => {
                    const token = getSessionToken() ?? getStoredToken('');
                    const catalog = await readBusinessCatalog({
                      host: getStoredHost('127.0.0.1'),
                      port: getStoredPort(9090),
                      token,
                      businessDb: libName,
                    });
                    await importEngineCatalogIntoDesignerDb(client, libName, catalog);
                    await data.loadLibraryCanvas(client, libName, catalog);
                  },
                  { detail: libName },
                );
              } catch {
                /* 失败态由右侧 toast 展示 */
              }
            }}
          >
            <IconExport />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolForceLayout')}
            data-active={config.forceLayoutEnabled}
            onClick={() => {
              config.forceLayoutEnabled = !config.forceLayoutEnabled;
              this.forceUpdate();
            }}
          >
            <IconForceLayout />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolSnap')}
            data-active={config.snapToGrid}
            onClick={() => {
              config.snapToGrid = !config.snapToGrid;
              this.forceUpdate();
            }}
          >
            <IconSnap />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolGrid')}
            data-active={config.gridEnabled}
            onClick={() => {
              config.gridEnabled = !config.gridEnabled;
              this.forceUpdate();
            }}
          >
            <IconGrid />
          </button>
        </div>

        <button
          type="button"
          className="designer-fab designer-float-exit"
          title={i18n.t('ui', 'disconnect')}
          onClick={disconnect}
        >
          <IconLogout />
        </button>

        <div className="designer-state-badge">
          {i18n.t('ui', 'stateLabel')}: {formatInteractionState(i18n, st)}
        </div>
      </div>
    );
  }
}
