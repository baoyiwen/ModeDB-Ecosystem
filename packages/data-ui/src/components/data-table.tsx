import { useCallback, useMemo, useRef, type ReactElement } from 'react';
import { overlayPendingEdits, pendingDeleteRowIndices, type ColumnDef } from '@mode-db/data-kit';
import { useDataPage } from '../context/data-page-context.js';
import { useVirtualRange } from '../hooks/use-virtual-range.js';
import './data-table.css';

const ROW_HEIGHT_PX = 36;
const VIRTUAL_THRESHOLD = 40;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function isColumnEditable(col: ColumnDef, mode: string): boolean {
  if (mode !== 'edit') {
    return false;
  }
  if (col.readOnly || col.isMetric || col.key === '_id') {
    return false;
  }
  return true;
}

/** Tabular view with pagination, edit staging, and delete selection. */
export function DataTable(): ReactElement {
  const page = useDataPage();
  const shape = page.viewData;

  const tabular = shape?.kind === 'tabular' ? shape : null;

  const displayRows = useMemo(() => {
    if (!tabular) {
      return [];
    }
    return overlayPendingEdits(tabular.rows, tabular.rowRefs, page.binding.pendingOps);
  }, [tabular, page.binding.pendingOps]);

  const deleteMarked = useMemo(
    () => pendingDeleteRowIndices(tabular?.rowRefs, page.binding.pendingOps),
    [tabular?.rowRefs, page.binding.pendingOps],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const useVirtual = displayRows.length > VIRTUAL_THRESHOLD;
  const virtual = useVirtualRange(scrollRef, useVirtual ? displayRows.length : 0, ROW_HEIGHT_PX);

  const handleCellChange = useCallback(
    (rowIndex: number, column: string, raw: string) => {
      if (!tabular?.rowRefs) {
        return;
      }
      const ref = tabular.rowRefs[rowIndex];
      if (!ref) {
        return;
      }
      const prev = tabular.rows[rowIndex]?.[column];
      let value: unknown = raw;
      if (typeof prev === 'number' && raw.trim() !== '') {
        const n = Number(raw);
        if (!Number.isNaN(n)) {
          value = n;
        }
      } else if (typeof prev === 'boolean') {
        value = raw === 'true' || raw === '1';
      }
      page.stageCellUpdate(ref, column, value);
    },
    [tabular, page],
  );

  const toggleDelete = useCallback(
    (rowIndex: number, checked: boolean) => {
      const ref = tabular?.rowRefs?.[rowIndex];
      if (!ref) {
        return;
      }
      if (checked) {
        page.stageRowDelete(ref);
      } else {
        page.unstageRowDelete(ref);
      }
    },
    [tabular?.rowRefs, page],
  );

  if (!shape) {
    if (page.lastError) {
      return <div className="data-table-empty">Error: {page.lastError}</div>;
    }
    return <div className="data-table-empty">{page.isRefreshing ? 'Loading…' : 'No data.'}</div>;
  }

  if (shape.kind === 'empty') {
    return (
      <div className="data-table-empty">No data{shape.reason ? ` (${shape.reason})` : ''}.</div>
    );
  }

  if (shape.kind !== 'tabular') {
    return <div className="data-table-empty">DataTable requires tabular data.</div>;
  }

  const pagination = shape.pagination;
  const showDeleteCol = page.mode === 'delete' && shape.rowRefs !== undefined;
  const visibleRows = useVirtual ? displayRows.slice(virtual.start, virtual.end) : displayRows;
  const colSpan = shape.columns.length + (showDeleteCol ? 1 : 0);

  const renderRow = (row: Record<string, unknown>, rowIndex: number): ReactElement => {
    const pendingDelete = deleteMarked.has(rowIndex);
    return (
      <tr
        key={shape.rowRefs?.[rowIndex]?.id ?? rowIndex}
        data-pending-delete={pendingDelete ? 'true' : undefined}
        style={useVirtual ? { height: ROW_HEIGHT_PX } : undefined}
      >
        {showDeleteCol ? (
          <td>
            <input
              type="checkbox"
              className="data-table-check"
              checked={pendingDelete}
              aria-label="Mark row for deletion"
              onChange={(e) => toggleDelete(rowIndex, e.target.checked)}
            />
          </td>
        ) : null}
        {shape.columns.map((col) => {
          const editable = isColumnEditable(col, page.mode);
          const value = row[col.key];
          return (
            <td key={col.key}>
              {editable ? (
                <input
                  className="data-table-input"
                  value={formatCell(value)}
                  aria-label={`${col.label ?? col.key} row ${rowIndex + 1}`}
                  onChange={(e) => handleCellChange(rowIndex, col.key, e.target.value)}
                />
              ) : (
                formatCell(value)
              )}
            </td>
          );
        })}
      </tr>
    );
  };

  return (
    <div className="data-table-wrap">
      <div className="data-table-scroll" ref={scrollRef}>
        <table className="data-table">
          <thead>
            <tr>
              {showDeleteCol ? <th scope="col" aria-label="Select row" /> : null}
              {shape.columns.map((col) => (
                <th key={col.key} scope="col">
                  {col.label ?? col.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {useVirtual && virtual.paddingTop > 0 ? (
              <tr aria-hidden="true" className="data-table-virtual-spacer">
                <td
                  colSpan={colSpan}
                  style={{ height: virtual.paddingTop, padding: 0, border: 0 }}
                />
              </tr>
            ) : null}
            {visibleRows.map((row, i) => renderRow(row, useVirtual ? virtual.start + i : i))}
            {useVirtual && virtual.paddingBottom > 0 ? (
              <tr aria-hidden="true" className="data-table-virtual-spacer">
                <td
                  colSpan={colSpan}
                  style={{ height: virtual.paddingBottom, padding: 0, border: 0 }}
                />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {pagination ? (
        <div className="data-table-pager">
          <button
            type="button"
            disabled={pagination.page <= 0 || page.isRefreshing}
            onClick={() => {
              void page.setPage(pagination.page - 1).catch((e: unknown) => {
                console.error(e);
              });
            }}
          >
            Previous
          </button>
          <span>
            Page {pagination.page + 1} / {Math.max(1, pagination.pageCount)} ({pagination.total}{' '}
            rows)
          </span>
          <button
            type="button"
            disabled={pagination.page + 1 >= pagination.pageCount || page.isRefreshing}
            onClick={() => {
              void page.setPage(pagination.page + 1).catch((e: unknown) => {
                console.error(e);
              });
            }}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
