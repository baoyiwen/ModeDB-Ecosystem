import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { AppearanceManager } from '../managers/appearance-manager.js';
import { ConfigManager } from '../managers/config-manager.js';
import { DataManager } from '../managers/data-manager.js';
import { EventManager } from '../managers/event-manager.js';
import { GraphLinker } from '../managers/graph-linker.js';
import { I18nManager } from '../managers/i18n-manager.js';
import { LayerManager } from '../managers/layer-manager.js';
import { ModeManager } from '../managers/mode-manager.js';
import { PropVaultController } from '../managers/prop-vault-controller.js';
import { GraphSyncManager } from '../managers/graph-sync-manager.js';
import { StateManager } from '../managers/state-manager.js';

export interface DesignerManagers {
  state: StateManager;
  modes: ModeManager;
  events: EventManager;
  config: ConfigManager;
  data: DataManager;
  i18n: I18nManager;
  appearance: AppearanceManager;
  layers: LayerManager;
  graphLink: GraphLinker;
  propVault: PropVaultController;
  graphSync: GraphSyncManager;
}

/** Class 组件可通过 `static contextType = DesignerContext` 订阅。 */
export const DesignerContext = createContext<DesignerManagers | null>(null);

export function DesignerProvider({ children }: { children: ReactNode }): React.ReactElement {
  const managers = useRef<DesignerManagers | null>(null);
  if (!managers.current) {
    const data = new DataManager();
    managers.current = {
      state: new StateManager(),
      modes: new ModeManager(),
      events: new EventManager(),
      config: new ConfigManager(),
      data,
      i18n: new I18nManager(),
      appearance: new AppearanceManager(),
      layers: new LayerManager(data),
      graphLink: new GraphLinker(data),
      propVault: new PropVaultController(),
      graphSync: new GraphSyncManager(),
    };
  }
  const value = useMemo(() => managers.current as DesignerManagers, []);
  return <DesignerContext.Provider value={value}>{children}</DesignerContext.Provider>;
}

export function useDesigner(): DesignerManagers {
  const ctx = useContext(DesignerContext);
  if (!ctx) {
    throw new Error('useDesigner must be used within DesignerProvider');
  }
  return ctx;
}
