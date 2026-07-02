import type { ReactElement } from 'react';
import { DataTable } from './data-table.js';
import { QueryResultView } from './query-result-view.js';
import { useDataPage } from '../context/data-page-context.js';
import './data-view-panel.css';

/** Renders DataTable (editable tabular) or QueryResultView (pivot / tree / grouped). */
export function DataViewPanel(): ReactElement {
  const page = useDataPage();
  const shape = page.viewData;

  if (shape?.kind === 'tabular') {
    return (
      <div className="data-view-panel">
        <DataTable />
      </div>
    );
  }

  return (
    <div className="data-view-panel">
      <QueryResultView />
    </div>
  );
}
