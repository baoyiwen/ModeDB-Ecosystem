import { Component, type ContextType, type CSSProperties, type ReactNode } from 'react';
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
 * 主应用壳层（浅色画布区 + 浮动控件；连接门页仍单独使用深色）。
 */
export abstract class DesignerChromePage<
  P = Record<string, unknown>,
  S = Record<string, unknown>,
> extends DesignerComponent<P, S> {
  protected readonly rootStyle: CSSProperties = {
    position: 'relative',
    height: '100vh',
    width: '100%',
    overflow: 'hidden',
    background: '#f1f5f9',
    color: '#0f172a',
  };

  protected wrapRoot(children: ReactNode): ReactNode {
    return <div style={this.rootStyle}>{children}</div>;
  }
}
