import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { flattenVisibleTreeNodes, type ViewTreeNode } from '@mode-db/data-kit';
import type { ColumnDef } from '@mode-db/data-kit';
import './query-result-view.css';

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function defaultExpandedKeys(roots: readonly ViewTreeNode[]): Set<string> {
  const keys = new Set<string>();
  for (const root of roots) {
    keys.add(root.key);
  }
  return keys;
}

export interface TreeTableProps {
  readonly columns: readonly ColumnDef[];
  readonly roots: readonly ViewTreeNode[];
  readonly treeKind: 'entity' | 'analysis';
  readonly hint?: string;
}

/** Expandable tree table for entity hierarchies and nested pivot/analysis results. */
export function TreeTable(props: TreeTableProps): ReactElement {
  const { columns, roots, treeKind, hint } = props;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => defaultExpandedKeys(roots));

  const visible = useMemo(() => flattenVisibleTreeNodes(roots, expanded), [roots, expanded]);

  const toggle = useCallback((key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const treeColumnLabel = treeKind === 'analysis' ? 'Dimension' : 'Node';

  return (
    <div className="data-result-wrap">
      <div className="data-result-scroll">
        <table className="data-result-table">
          <thead>
            <tr>
              <th scope="col">{treeColumnLabel}</th>
              {columns.map((col) => (
                <th key={col.key} scope="col">
                  {col.label ?? col.key}
                  {col.isMetric ? ' ∑' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((node) => {
              const hasChildren = node.children.length > 0;
              const isOpen = expanded.has(node.key);
              return (
                <tr key={node.key}>
                  <td>
                    <span
                      className="data-tree-indent"
                      style={{ paddingLeft: `${node.depth * 16}px` }}
                    >
                      {hasChildren ? (
                        <button
                          type="button"
                          className="data-tree-toggle"
                          aria-expanded={isOpen}
                          onClick={() => toggle(node.key)}
                        >
                          {isOpen ? '−' : '+'}
                        </button>
                      ) : (
                        <span className="data-tree-toggle data-tree-toggle--spacer">+</span>
                      )}
                      <span className="data-tree-label">{formatCell(node.label)}</span>
                      {node.relationKey ? (
                        <span className="data-tree-relation">{node.relationKey}</span>
                      ) : null}
                    </span>
                  </td>
                  {columns.map((col) => (
                    <td key={col.key}>
                      <span className={col.isMetric ? 'data-result-metric' : ''}>
                        {formatCell(node.values[col.key])}
                      </span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hint ? <p className="data-result-hint">{hint}</p> : null}
    </div>
  );
}
