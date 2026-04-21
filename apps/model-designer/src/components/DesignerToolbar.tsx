import type { ReactNode } from 'react';
import { DesignerComponent } from './base/designer-component.js';
import type { PropObject } from '../types/prop-object.js';
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

  override componentDidMount(): void {
    this.i18nUnsub = this.managers.i18n.subscribe(() => this.forceUpdate());
  }

  override componentWillUnmount(): void {
    this.i18nUnsub?.();
  }

  override render(): ReactNode {
    const { state, i18n, data, config } = this.managers;
    const st = state.state;
    const client = config.remoteClient;
    const { selectedId } = this.props;
    const themes = config.getThemes();

    const disconnect = (): void => {
      client?.close();
      config.setRemoteClient(null, false);
      this.props.onDisconnected();
    };

    const newModel = (): void => {
      const id = crypto.randomUUID();
      const themeId = themes[Math.floor(Math.random() * themes.length)]!.id;
      const { layers } = this.managers;
      const prop: PropObject = {
        id: crypto.randomUUID(),
        name: 'field_1',
        type: 'string',
        is_primary: true,
        encrypt_level: 0,
        metadata: {},
      };
      data.upsertModel(
        {
          id,
          model_name: 'NewModel',
          parent_id: null,
          props_objects_array: [prop],
        },
        { position: { x: 160, y: 160 }, color_theme: themeId, z_index: 1 },
      );
      layers.assignNodeToActiveLayer(id);
      this.props.onSelect(id);
    };

    const deleteSelected = (): void => {
      if (!selectedId) {
        return;
      }
      data.removeModel(selectedId);
      this.props.onSelect(undefined);
    };

    return (
      <div className="designer-float-layer" aria-hidden={false}>
        <div className="designer-float-top">
          <button type="button" className="designer-mode-pill designer-mode-pill--active" disabled>
            {i18n.t('ui', 'modeModelDesigner')}
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
            data-active={st === 'SELECT'}
            title={i18n.t('ui', 'toolSelect')}
            onClick={() => state.transition('SELECT')}
          >
            <IconHand />
          </button>
          <button
            type="button"
            className="designer-fab"
            data-active={st === 'ADD_NODE'}
            title={i18n.t('ui', 'toolCreate')}
            onClick={() => {
              state.transition('ADD_NODE');
              newModel();
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
            title={i18n.t('ui', 'toolDelete')}
            onClick={deleteSelected}
            disabled={!selectedId}
          >
            <IconTrash />
          </button>
          <button type="button" className="designer-fab" title={i18n.t('ui', 'toolMulti')} disabled>
            <IconCheckSquare />
          </button>
          <button
            type="button"
            className="designer-fab"
            title={i18n.t('ui', 'toolLinkHint')}
            onClick={() => state.transition('SELECT')}
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
