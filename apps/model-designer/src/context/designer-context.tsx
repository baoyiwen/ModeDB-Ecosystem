import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { ConfigManager } from '../managers/config-manager.js';
import { DataManager } from '../managers/data-manager.js';
import { EventManager } from '../managers/event-manager.js';
import { GraphLinker } from '../managers/graph-linker.js';
import { I18nManager } from '../managers/i18n-manager.js';
import { LayerManager } from '../managers/layer-manager.js';
import { PropVaultController } from '../managers/prop-vault-controller.js';
import { StateManager } from '../managers/state-manager.js';

export interface DesignerManagers {
  state: StateManager;
  events: EventManager;
  config: ConfigManager;
  data: DataManager;
  i18n: I18nManager;
  layers: LayerManager;
  graphLink: GraphLinker;
  propVault: PropVaultController;
}

/** Class 组件可通过 `static contextType = DesignerContext` 订阅。 */
export const DesignerContext = createContext<DesignerManagers | null>(null);

export function DesignerProvider({ children }: { children: ReactNode }): React.ReactElement {
  const managers = useRef<DesignerManagers | null>(null);
  if (!managers.current) {
    const data = new DataManager();
    managers.current = {
      state: new StateManager(),
      events: new EventManager(),
      config: new ConfigManager(),
      data,
      i18n: new I18nManager(),
      layers: new LayerManager(data),
      graphLink: new GraphLinker(data),
      propVault: new PropVaultController(),
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
