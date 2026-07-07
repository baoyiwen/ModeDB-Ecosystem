import { Component, type ContextType, type ReactNode } from 'react';
import { AppConfirmProvider } from '@mode-db/data-ui';
import { DesignerContext, type DesignerManagers } from '../../context/designer-context.js';

/**
 * 所有需访问 Designer Manager 的 class 页面/片段的基类（`contextType` 注入）。
 */
export abstract class DesignerComponent<
  P = Record<string, unknown>,
  S = Record<string, unknown>,
> extends Component<P, S> {
  static contextType = DesignerContext;
  declare context: ContextType<typeof DesignerContext>;

  protected get managers(): DesignerManagers {
    const ctx = this.context;
    if (!ctx) {
      throw new Error('DesignerComponent must be used within DesignerProvider');
    }
    return ctx;
  }
}

/**
 * 主应用壳层：渐变底 + 毛玻璃控件（连接页与编辑页共用 `.designer-app-root`）。
 */
export abstract class DesignerChromePage<
  P = Record<string, unknown>,
  S = Record<string, unknown>,
> extends DesignerComponent<P, S> {
  protected wrapRoot(children: ReactNode): ReactNode {
    return (
      <AppConfirmProvider defaultEyebrow="Model Designer">
        <div className="designer-app-root">{children}</div>
      </AppConfirmProvider>
    );
  }
}
