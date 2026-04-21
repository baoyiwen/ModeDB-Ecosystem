import type { ReactNode } from 'react';
import type { RemoteModelDBClient } from '@mode-db/sdk';
import './styles/designer-shell.css';
import { CanvasContainer } from './components/CanvasContainer.js';
import { ConnectionFlow } from './components/ConnectionFlow.js';
import { EditorChrome } from './components/EditorChrome.js';
import { DesignerToolbar } from './components/DesignerToolbar.js';
import { DesignerChromePage } from './components/base/designer-component.js';
interface AppState {
  selectedModelId: string | undefined;
  selectedRelationId: string | undefined;
  sessionEpoch: number;
  connected: boolean;
}

/**
 * 根页面：未连接时 {@link ConnectionFlow}；连接并选择逻辑库后进入画布（当前库名见 {@link ConfigManager#activeLibraryName}）。
 */
export default class App extends DesignerChromePage<Record<string, never>, AppState> {
  constructor(props: Record<string, never>) {
    super(props);
    this.state = {
      selectedModelId: undefined,
      selectedRelationId: undefined,
      sessionEpoch: 0,
      connected: false,
    };
  }

  private readonly handleEditorReady = (client: RemoteModelDBClient, libraryName: string): void => {
    const { config, data, layers, modes, state } = this.managers;
    config.setRemoteClient(client, true);
    config.setActiveLibraryName(libraryName);
    data.resetToNewLibrary();
    config.resetViewport();
    modes.setMode('select');
    state.transition('SELECT');
    layers.setActiveLayer(data.defaultPageLayerId);
    this.setState((s) => ({
      connected: true,
      selectedModelId: undefined,
      selectedRelationId: undefined,
      sessionEpoch: s.sessionEpoch + 1,
    }));
  };

  private handleDisconnected = (): void => {
    const { config, data } = this.managers;
    data.resetToNewLibrary();
    config.resetViewport();
    config.setActiveLibraryName(null);
    this.setState((s) => ({
      connected: false,
      selectedModelId: undefined,
      selectedRelationId: undefined,
      sessionEpoch: s.sessionEpoch + 1,
    }));
  };

  private handleSelectModel = (id: string | undefined): void => {
    this.setState({ selectedModelId: id, selectedRelationId: undefined });
  };

  private handleSelectRelation = (id: string | undefined): void => {
    this.setState({ selectedRelationId: id, selectedModelId: undefined });
  };

  private handleClearCanvasSelection = (): void => {
    this.setState({ selectedModelId: undefined, selectedRelationId: undefined });
  };

  override render(): ReactNode {
    const { selectedModelId, selectedRelationId, connected, sessionEpoch } = this.state;

    if (!connected) {
      return this.wrapRoot(<ConnectionFlow onEditorReady={this.handleEditorReady} />);
    }

    return this.wrapRoot(
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
            <DesignerToolbar
              selectedId={selectedModelId}
              onSelect={this.handleSelectModel}
              onDisconnected={this.handleDisconnected}
            />
          </div>
        </div>
      </EditorChrome>,
    );
  }
}
