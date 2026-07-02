import type { ReactElement } from 'react';
import { useDataPage } from '../context/data-page-context.js';
import './pivot-table.css';

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

/** Read-only pivot with dimension drill-down; metrics are never editable. */
export function PivotTable(): ReactElement {
  const page = useDataPage();
  const shape = page.viewData;

  if (!shape) {
    if (page.lastError) {
      return <div className="data-table-empty">Error: {page.lastError}</div>;
    }
    return <div className="data-table-empty">{page.isRefreshing ? 'Loading…' : 'No data.'}</div>;
  }

  if (shape.kind === 'empty') {
    return (
      <div className="data-table-empty">
        No pivot data{shape.reason ? ` (${shape.reason})` : ''}.
      </div>
    );
  }

  if (shape.kind !== 'pivot') {
    return <div className="data-table-empty">PivotTable requires pivot data.</div>;
  }

  const drillDim = page.nextDrillDimension;
  const dimSet = new Set(shape.dimensions);

  return (
    <div className="data-pivot-wrap">
      {page.drillPath.length > 0 ? (
        <nav className="data-pivot-crumb" aria-label="Pivot drill path">
          <button type="button" onClick={() => void page.resetDrill()}>
            All
          </button>
          {page.drillPath.map((step, i) => (
            <span key={`${step.dimension}-${i}`}>
              <span aria-hidden="true"> › </span>
              <button type="button" onClick={() => void page.drillUp(page.drillPath.length - i)}>
                {step.dimension}={formatCell(step.value)}
              </button>
            </span>
          ))}
        </nav>
      ) : null}

      <div className="data-pivot-scroll">
        <table className="data-pivot-table">
          <thead>
            <tr>
              {shape.columns.map((col) => (
                <th key={col.key} scope="col">
                  {col.label ?? col.key}
                  {col.isMetric ? ' ∑' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shape.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {shape.columns.map((col) => {
                  const value = row[col.key];
                  const isDrillCol = drillDim !== null && col.key === drillDim && !col.isMetric;
                  return (
                    <td key={col.key}>
                      {isDrillCol ? (
                        <button
                          type="button"
                          className="data-pivot-drill"
                          onClick={() => void page.drillInto(value)}
                        >
                          {formatCell(value)}
                        </button>
                      ) : (
                        <span className={dimSet.has(col.key) ? '' : 'data-pivot-metric'}>
                          {formatCell(value)}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="data-pivot-hint">
        {drillDim
          ? `Click a ${drillDim} value to drill down. Aggregates are read-only.`
          : 'Leaf level reached — switch to edit mode on the table view to change row data.'}
      </p>
    </div>
  );
}
