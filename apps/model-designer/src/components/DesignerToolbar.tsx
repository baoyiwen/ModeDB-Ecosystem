import type { ReactNode } from 'react';
import { DesignerComponent } from './base/designer-component.js';
import {
  IconCheckSquare,
  IconDocument,
  IconExport,
  IconGrid,
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

  override componentDidMount(): void {
    this.i18nUnsub = this.managers.i18n.subscribe(() => this.forceUpdate());
    this.modesUnsub = this.managers.modes.subscribe(() => this.forceUpdate());
  }

  override componentWillUnmount(): void {
    this.i18nUnsub?.();
    this.modesUnsub?.();
  }

  override render(): ReactNode {
    const { state, i18n, data, config, modes, graphSync } = this.managers;
    const st = state.state;
    const client = config.remoteClient;
    const mode = modes.mode;
    const libName = config.activeLibraryName;

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
            {libName ? <span className="designer-library-tag"> · {libName}</span> : null}
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
              state.transition('SELECT');
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
              state.transition('ADD_NODE');
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
              state.transition('SELECT');
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
              state.transition('SELECT');
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
            disabled={!client}
            onClick={async () => {
              if (!client) {
                return;
              }
              try {
                if (graphSync.hasDirty) {
                  await graphSync.push(client, data);
                }
                await data.pushGraphToEngine(client);
              } catch {
                window.alert(i18n.t('errors', 'pushFailed'));
              }
            }}
          >
            <IconSave />
          </button>
          <button
            type="button"
            className="designer-fab"
            title={i18n.t('ui', 'toolExport')}
            disabled={!client}
            onClick={async () => {
              if (!client) {
                return;
              }
              try {
                await data.pullGraphFromEngine(client);
              } catch {
                window.alert(i18n.t('errors', 'pullFailed'));
              }
            }}
          >
            <IconExport />
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
          {i18n.t('ui', 'stateLabel')}: {st}
        </div>
      </div>
    );
  }
}
