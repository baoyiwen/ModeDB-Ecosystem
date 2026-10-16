import { Fragment, useId, useMemo, useState, type ReactElement } from 'react';
import {
  collectPivotExpandableRowIds,
  formatPivotValue,
  resolvePivotColumnAlignment,
  resolvePivotLabel,
  type PivotLanguageMode,
  type PivotTableData,
} from '../pivot/presentation.js';

export interface PivotTableLabels {
  readonly emptyRows: string;
  readonly emptyFields: string;
  readonly expand: string;
  readonly collapse: string;
  readonly expandAll: string;
  readonly collapseAll: string;
  readonly missing: string;
  readonly null: string;
  readonly yes: string;
  readonly no: string;
  readonly rows: (count: number) => string;
}

export interface PivotCompositeTableProps {
  readonly table: PivotTableData;
  readonly locale: string;
  readonly languageMode: PivotLanguageMode;
  readonly labels: PivotTableLabels;
}

interface ModelTableProps extends PivotCompositeTableProps {
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly idPrefix: string;
}

function TableCaption({ table, locale, labels }: PivotCompositeTableProps): ReactElement {
  return (
    <>
      {table.relation ? (
        <span className="pivot-composite-relation">
          {resolvePivotLabel(table.relation.label, locale)}
          <span aria-hidden="true"> / </span>
        </span>
      ) : null}
      <span>{resolvePivotLabel(table.node.label, locale)}</span>
      <span className="pivot-composite-count">{labels.rows(table.rows.length)}</span>
    </>
  );
}

function ModelTable(props: ModelTableProps): ReactElement {
  const { table, locale, languageMode, labels, expanded, onToggle, idPrefix } = props;
  const columnCount = Math.max(1, table.node.columns.length) + 1;
  const columnAlignments = useMemo(
    () => table.node.columns.map((_, index) => resolvePivotColumnAlignment(table, index)),
    [table],
  );
  if (table.node.columns.length === 0 && table.rows.every((row) => row.children.length === 0)) {
    return (
      <div className="pivot-composite-summary">
        <TableCaption {...props} />
        <span className="pivot-composite-empty">
          {table.rows.length === 0 ? labels.emptyRows : labels.emptyFields}
        </span>
      </div>
    );
  }
  return (
    <table
      className="pivot-table pivot-composite-table"
      data-node-id={table.node.id}
      style={{ minWidth: Math.max(360, table.node.columns.length * 120 + 64) }}
    >
      <caption>
        <TableCaption {...props} />
      </caption>
      <colgroup>
        <col className="pivot-composite-index-column" />
        {table.node.columns.length > 0 ? (
          table.node.columns.map((column) => <col key={column.id} />)
        ) : (
          <col />
        )}
      </colgroup>
      <thead>
        <tr>
          <th scope="col">
            <span className="pivot-composite-row-index">
              <span className="pivot-tree-toggle-placeholder" aria-hidden="true" />
              <span>#</span>
            </span>
          </th>
          {table.node.columns.length > 0 ? (
            table.node.columns.map((column, columnIndex) => (
              <th
                key={column.id}
                scope="col"
                title={column.outputName}
                data-align={columnAlignments[columnIndex]}
              >
                {resolvePivotLabel(column.label, locale)}
              </th>
            ))
          ) : (
            <th scope="col">{labels.emptyFields}</th>
          )}
        </tr>
      </thead>
      <tbody>
        {table.rows.length === 0 ? (
          <tr>
            <td colSpan={columnCount} className="pivot-composite-empty">
              {labels.emptyRows}
            </td>
          </tr>
        ) : null}
        {table.rows.map((row, index) => {
          const isExpanded = expanded.has(row.id);
          const hasChildren = row.children.length > 0;
          const childrenId = `${idPrefix}-${encodeURIComponent(row.id)}`;
          return (
            <Fragment key={row.id}>
              <tr className="pivot-composite-record" data-expanded={isExpanded && hasChildren}>
                <th scope="row">
                  <span className="pivot-composite-row-index">
                    {hasChildren ? (
                      <button
                        type="button"
                        className="pivot-tree-toggle"
                        aria-label={`${isExpanded ? labels.collapse : labels.expand} ${index + 1}`}
                        title={`${isExpanded ? labels.collapse : labels.expand} ${index + 1}`}
                        aria-expanded={isExpanded}
                        aria-controls={isExpanded ? childrenId : undefined}
                        onClick={() => onToggle(row.id)}
                      >
                        <span
                          className={`pivot-composite-chevron${isExpanded ? ' is-expanded' : ''}`}
                          aria-hidden="true"
                        />
                      </button>
                    ) : (
                      <span className="pivot-tree-toggle-placeholder" aria-hidden="true" />
                    )}
                    <span>{index + 1}</span>
                  </span>
                </th>
                {table.node.columns.length > 0 ? (
                  table.node.columns.map((column, columnIndex) => {
                    const value = row.values[columnIndex];
                    const empty = value === undefined || value === null;
                    const text = empty
                      ? '-'
                      : typeof value === 'boolean' && languageMode === 'current'
                        ? value
                          ? labels.yes
                          : labels.no
                        : formatPivotValue(value, locale, languageMode, column.type);
                    const title =
                      value === undefined ? labels.missing : value === null ? labels.null : text;
                    return (
                      <td
                        key={column.id}
                        data-align={columnAlignments[columnIndex]}
                        className={empty ? 'pivot-cell-empty' : undefined}
                      >
                        <div className="pivot-cell-content" title={title}>
                          {text}
                        </div>
                      </td>
                    );
                  })
                ) : (
                  <td className="pivot-composite-empty">{labels.emptyFields}</td>
                )}
              </tr>
              {hasChildren && isExpanded ? (
                <tr id={childrenId} className="pivot-composite-children">
                  <td colSpan={columnCount}>
                    <div className="pivot-composite-child-tables">
                      {row.children.map((child) => (
                        <ModelTable key={child.id} {...props} table={child} />
                      ))}
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export function PivotCompositeTable(props: PivotCompositeTableProps): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const expandable = useMemo(() => collectPivotExpandableRowIds(props.table), [props.table]);
  const idPrefix = useId();
  const toggle = (id: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="pivot-composite-result">
      {expandable.length > 0 ? (
        <div className="pivot-composite-actions">
          <button
            type="button"
            className="designer-btn"
            disabled={expandable.every((id) => expanded.has(id))}
            onClick={() => setExpanded(new Set(expandable))}
          >
            <span className="pivot-composite-chevron is-expanded" aria-hidden="true" />
            {props.labels.expandAll}
          </button>
          <button
            type="button"
            className="designer-btn"
            disabled={expanded.size === 0}
            onClick={() => setExpanded(new Set())}
          >
            <span className="pivot-composite-chevron" aria-hidden="true" />
            {props.labels.collapseAll}
          </button>
        </div>
      ) : null}
      <div className="pivot-table-wrap pivot-composite-wrap">
        <ModelTable {...props} expanded={expanded} onToggle={toggle} idPrefix={idPrefix} />
      </div>
    </div>
  );
}
