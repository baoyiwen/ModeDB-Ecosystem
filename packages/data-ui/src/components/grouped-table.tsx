import { useCallback, useState, type ReactElement } from 'react';
import type { ColumnDef, ViewGroupBucket } from '@mode-db/data-kit';
import { TreeTable } from './tree-table.js';
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

export interface GroupedTableProps {
  readonly columns: readonly ColumnDef[];
  readonly groups: readonly ViewGroupBucket[];
  readonly hint?: string;
}

/** Grouped analysis view: aggregate header rows with expandable member trees. */
export function GroupedTable(props: GroupedTableProps): ReactElement {
  const { columns, groups, hint } = props;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

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

  return (
    <div className="data-result-wrap">
      <div className="data-result-scroll">
        <table className="data-result-table">
          <thead>
            <tr>
              <th scope="col">Group</th>
              {columns.map((col) => (
                <th key={col.key} scope="col">
                  {col.label ?? col.key}
                  {col.isMetric ? ' ∑' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const isOpen = expanded.has(group.key);
              const memberCount = group.members.length;
              return (
                <GroupSection
                  key={group.key}
                  group={group}
                  columns={columns}
                  isOpen={isOpen}
                  memberCount={memberCount}
                  onToggle={() => toggle(group.key)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {hint ? <p className="data-result-hint">{hint}</p> : null}
    </div>
  );
}

function GroupSection(props: {
  readonly group: ViewGroupBucket;
  readonly columns: readonly ColumnDef[];
  readonly isOpen: boolean;
  readonly memberCount: number;
  readonly onToggle: () => void;
}): ReactElement {
  const { group, columns, isOpen, memberCount, onToggle } = props;
  const dimLabel = columns
    .filter((c) => !c.isMetric)
    .map((c) => formatCell(group.headerRow[c.key]))
    .filter((v) => v !== '—')
    .join(' · ');

  return (
    <>
      <tr className="data-group-header" onClick={onToggle}>
        <td>
          <span className="data-group-toggle" aria-hidden="true">
            {memberCount > 0 ? (isOpen ? '▼' : '▶') : '·'}
          </span>
          {dimLabel || group.key}
          {memberCount > 0 ? (
            <span style={{ marginLeft: 8, fontWeight: 400, color: '#64748b' }}>
              ({memberCount} rows)
            </span>
          ) : null}
        </td>
        {columns.map((col) => (
          <td key={col.key}>
            <span className={col.isMetric ? 'data-result-metric' : ''}>
              {formatCell(group.headerRow[col.key])}
            </span>
          </td>
        ))}
      </tr>
      {isOpen && memberCount > 0 ? (
        <tr className="data-group-members">
          <td colSpan={columns.length + 1}>
            <TreeTable columns={group.memberColumns} roots={group.members} treeKind="entity" />
          </td>
        </tr>
      ) : null}
    </>
  );
}
