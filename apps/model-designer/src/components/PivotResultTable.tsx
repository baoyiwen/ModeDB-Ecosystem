import { useState, type ReactElement } from 'react';
import { displayPivotValue, type PivotDisplayNode } from '../pivot/display.js';

function childRows(row: Readonly<Record<string, unknown>>, key: string): Record<string, unknown>[] {
  const value = key.startsWith('relates.')
    ? (row.relates as Record<string, unknown> | undefined)?.[key.slice(8)]
    : row[key];
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

interface TableRecord {
  row: Readonly<Record<string, unknown>>;
  path: string;
  number: number;
  expandable: boolean;
}
interface TableBlock {
  key: string;
  label?: string;
  display: PivotDisplayNode;
  depth: number;
  records: TableRecord[];
}

function fieldWidth(type: string): number {
  return type === 'DateTime' ? 200 : ['JSON', 'I18N', 'Unit'].includes(type) ? 240 : 160;
}

export function PivotResultTable(props: {
  rows: readonly Readonly<Record<string, unknown>>[];
  display: PivotDisplayNode;
  locale: string;
  languageMode: 'current' | 'raw' | 'all';
  offset?: number;
  expandLabel: string;
  collapseLabel: string;
  emptyFieldsLabel: string;
}): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const blocks: TableBlock[] = [];
  // Each contiguous set of records owns a table and its sticky header. Expanded
  // children follow in document flow, never inside another scroll container.
  const visit = (
    rows: typeof props.rows,
    display: PivotDisplayNode,
    path: string,
    depth: number,
    label?: string,
  ): void => {
    let records: TableRecord[] = [];
    const flush = (): void => {
      if (!records.length) return;
      blocks.push({ key: records[0]!.path, display, depth, label, records });
      records = [];
    };
    rows.forEach((row, index) => {
      const recordPath = `${path}/${index}`;
      const children = display.children.flatMap((child) => {
        const nested = childRows(row, child.key);
        return nested.length ? [{ ...child, rows: nested }] : [];
      });
      records.push({
        row,
        path: recordPath,
        number: (depth === 0 ? (props.offset ?? 0) : 0) + index + 1,
        expandable: children.length > 0 && depth < 64,
      });
      if (expanded.has(recordPath) && children.length && depth < 64) {
        flush();
        for (const child of children)
          visit(
            child.rows,
            child.node,
            `${recordPath}/${encodeURIComponent(child.key)}`,
            depth + 1,
            `${child.label} · ${child.node.label}`,
          );
      }
    });
    flush();
  };
  visit(props.rows, props.display, 'root', 0);
  return (
    <div className="pivot-table-flow" role="region" aria-label={props.display.label}>
      {blocks.map((block) => (
        <section
          key={block.key}
          className={`pivot-table-block${block.depth ? ' is-nested' : ''}`}
          style={{ marginInlineStart: Math.min(block.depth, 6) * 18 }}
          aria-label={block.label ?? block.display.label}
        >
          {block.label ? <h4 className="pivot-table-caption">{block.label}</h4> : null}
          {!block.display.fields.length && !block.records.some((record) => record.expandable) ? (
            <p className="data-transfer-muted">{props.emptyFieldsLabel}</p>
          ) : (
            <table
              className="pivot-table pivot-data-table"
              style={{
                width:
                  64 +
                  block.display.fields.reduce((width, field) => width + fieldWidth(field.type), 0),
              }}
            >
              <colgroup>
                <col style={{ width: 64 }} />
                {block.display.fields.map((field) => (
                  <col key={field.key} style={{ width: fieldWidth(field.type) }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="pivot-cell-content">#</span>
                  </th>
                  {block.display.fields.map((field) => (
                    <th key={field.key} scope="col" title={field.key}>
                      <span className="pivot-cell-content">{field.label}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.records.map(({ row, path, number, expandable }) => (
                  <tr key={path}>
                    <th scope="row" className="pivot-record-control">
                      {expandable ? (
                        <button
                          type="button"
                          className="pivot-related-toggle"
                          aria-expanded={expanded.has(path)}
                          aria-label={`${expanded.has(path) ? props.collapseLabel : props.expandLabel} ${number}`}
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(path)) next.delete(path);
                              else next.add(path);
                              return next;
                            })
                          }
                        >
                          <span aria-hidden="true">{expanded.has(path) ? '▾' : '▸'}</span>
                          <span>{number}</span>
                        </button>
                      ) : (
                        <span className="pivot-record-number">{number}</span>
                      )}
                    </th>
                    {block.display.fields.map((field) => (
                      <td
                        key={field.key}
                        className={field.type === 'DateTime' ? 'pivot-date-cell' : undefined}
                        title={displayPivotValue(row[field.key], field.type, props.locale, 'raw')}
                      >
                        <span className="pivot-cell-content">
                          {displayPivotValue(
                            row[field.key],
                            field.type,
                            props.locale,
                            props.languageMode,
                          )}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}
