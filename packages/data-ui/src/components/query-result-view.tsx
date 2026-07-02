import type { ReactElement } from 'react';
import { useDataPage } from '../context/data-page-context.js';
import { PivotTable } from './pivot-table.js';
import { TreeTable } from './tree-table.js';
import { GroupedTable } from './grouped-table.js';
import './query-result-view.css';

/**
 * Unified query result renderer: flat pivot, nested tree, grouped buckets, or empty state.
 */
export function QueryResultView(): ReactElement {
  const page = useDataPage();
  const shape = page.viewData;

  if (!shape) {
    if (page.lastError) {
      return <div className="data-result-empty">Error: {page.lastError}</div>;
    }
    return <div className="data-result-empty">{page.isRefreshing ? 'Loading…' : 'No data.'}</div>;
  }

  if (shape.kind === 'empty') {
    return (
      <div className="data-result-empty">No data{shape.reason ? ` (${shape.reason})` : ''}.</div>
    );
  }

  if (shape.kind === 'tree') {
    return (
      <TreeTable
        columns={shape.columns}
        roots={shape.roots}
        treeKind={shape.treeKind}
        hint={
          shape.treeKind === 'entity'
            ? 'Expand nodes to browse nested relations. Relation badges show the edge label.'
            : 'Expand dimension levels to drill into nested aggregates.'
        }
      />
    );
  }

  if (shape.kind === 'grouped') {
    return (
      <GroupedTable
        columns={shape.columns}
        groups={shape.groups}
        hint="Click a group header to expand member rows (including nested relations)."
      />
    );
  }

  if (shape.kind === 'pivot') {
    return <PivotTable />;
  }

  return <div className="data-result-empty">Unexpected view shape: {shape.kind}</div>;
}
