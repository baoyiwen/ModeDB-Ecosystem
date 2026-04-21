import type { ReactNode } from 'react';
import './styles/designer-shell.css';
import { CanvasContainer } from './components/CanvasContainer.js';
import { PanelGroup } from './components/PanelGroup.js';
import { WorkspaceGate } from './components/WorkspaceGate.js';
import { DesignerToolbar } from './components/DesignerToolbar.js';
import { DesignerChromePage } from './components/base/designer-component.js';
import type { PropObject } from './types/prop-object.js';

interface AppState {
  selectedId: string | undefined;
  sessionEpoch: number;
  connected: boolean;
}

/**
 * 根页面：继承 {@link DesignerChromePage}，复用深色壳层；未连接时渲染 {@link WorkspaceGate}。
 */
export default class App extends DesignerChromePage<Record<string, never>, AppState> {
  private seeded = false;

  constructor(props: Record<string, never>) {
    super(props);
    this.state = {
      selectedId: undefined,
      sessionEpoch: 0,
      connected: false,
    };
  }

  override componentDidUpdate(_prevProps: Record<string, never>, _prevState: AppState): void {
    const { connected } = this.state;
    const { data } = this.managers;
    if (!connected) {
      this.seeded = false;
      return;
    }
    if (!this.seeded && data.models.length === 0) {
      this.seedDemoModel();
    }
  }

  private seedDemoModel(): void {
    const { data } = this.managers;
    if (this.seeded || data.models.length > 0) {
      return;
    }
    this.seeded = true;
    const id = crypto.randomUUID();
    const layerId = 'layer-main';
    const { layers } = this.managers;
    data.ensureLayer({ id: layerId, label: 'Main', order: 0, isVisible: true });
    layers.setActiveLayer(layerId);
    const prop: PropObject = {
      id: crypto.randomUUID(),
      name: 'id',
      type: 'string',
      is_primary: true,
      encrypt_level: 0,
      metadata: {},
    };
    data.upsertModel(
      {
        id,
        model_name: 'Demo',
        parent_id: null,
        props_objects_array: [prop],
      },
      { position: { x: 64, y: 64 }, color_theme: 'default', z_index: 0 },
    );
    data.assignNodeToLayers(id, [layerId]);
    this.setState({ selectedId: id });
  }

  private handleSessionOpened = (): void => {
    this.setState((s) => ({
      connected: true,
      sessionEpoch: s.sessionEpoch + 1,
    }));
  };

  private handleDisconnected = (): void => {
    this.setState((s) => ({
      connected: false,
      selectedId: undefined,
      sessionEpoch: s.sessionEpoch + 1,
    }));
  };

  private handleSelect = (id: string | undefined): void => {
    this.setState({ selectedId: id });
  };

  override render(): ReactNode {
    const { selectedId, connected } = this.state;

    if (!connected) {
      return <WorkspaceGate onSessionOpened={this.handleSessionOpened} />;
    }

    return this.wrapRoot(
      <div className="designer-editor-root">
        <div className="designer-canvas-wrap">
          <CanvasContainer selectedId={selectedId} onSelect={this.handleSelect} />
          <DesignerToolbar
            selectedId={selectedId}
            onSelect={this.handleSelect}
            onDisconnected={this.handleDisconnected}
          />
        </div>
        <aside className="designer-side-panel">
          <PanelGroup selectedId={selectedId} />
        </aside>
      </div>,
    );
  }
}
