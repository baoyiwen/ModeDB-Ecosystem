import type { ImportRowFailure } from '@mode-db/data-kit';
import { useCallback, type ReactElement } from 'react';
import { useDataPage } from '../context/data-page-context.js';
import './import-failure-panel.css';

export interface ImportFailurePanelLabels {
  readonly title: string;
  readonly summary: string;
  readonly rowNumber: string;
  readonly reasons: string;
  readonly retryCommit: string;
  readonly partialSuccess: string;
}

export interface ImportFailurePanelProps {
  readonly failures: readonly ImportRowFailure[];
  readonly fields: readonly string[];
  readonly labels: ImportFailurePanelLabels;
  readonly partialSuccessCount?: number;
  readonly onRetryCommit: () => void;
  readonly busy?: boolean;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function parseCellInput(raw: string, prev: unknown): unknown {
  if (raw.trim() === '') {
    return '';
  }
  if (typeof prev === 'number' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (typeof prev === 'boolean') {
    return raw === 'true' || raw === '1';
  }
  return raw;
}

/** Editable review table for rows that failed insertMany validation. */
export function ImportFailurePanel(props: ImportFailurePanelProps): ReactElement {
  const { failures, fields, labels, partialSuccessCount = 0, onRetryCommit, busy = false } = props;
  const page = useDataPage();

  const displayFields =
    fields.length > 0 ? fields : [...new Set(failures.flatMap((f) => Object.keys(f.row)))];

  const handleCellChange = useCallback(
    (failure: ImportRowFailure, field: string, raw: string): void => {
      const prev = failure.row[field];
      page.updateImportRow(failure.opIndex, failure.rowIndex, field, parseCellInput(raw, prev));
    },
    [page],
  );

  return (
    <div className="import-failure-panel">
      <div className="import-failure-panel-header">
        <h3>{labels.title}</h3>
        <p className="import-failure-panel-summary">
          {labels.summary.replace('{{count}}', String(failures.length))}
          {partialSuccessCount > 0
            ? ` ${labels.partialSuccess.replace('{{count}}', String(partialSuccessCount))}`
            : null}
        </p>
      </div>
      <div className="import-failure-panel-scroll">
        <table className="import-failure-table">
          <thead>
            <tr>
              <th scope="col">{labels.rowNumber}</th>
              {displayFields.map((f) => (
                <th key={f} scope="col">
                  {f}
                </th>
              ))}
              <th scope="col">{labels.reasons}</th>
            </tr>
          </thead>
          <tbody>
            {failures.map((failure, displayIndex) => (
              <tr key={`${failure.opIndex}-${failure.rowIndex}-${displayIndex}`}>
                <td>{displayIndex + 1}</td>
                {displayFields.map((field) => (
                  <td key={field}>
                    <input
                      className="import-failure-cell-input"
                      value={formatCell(failure.row[field])}
                      aria-label={field}
                      disabled={busy}
                      onChange={(e) => handleCellChange(failure, field, e.target.value)}
                    />
                  </td>
                ))}
                <td className="import-failure-reasons">
                  <ul>
                    {failure.reasons.map((reason, i) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="import-failure-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !page.isDirty}
          onClick={onRetryCommit}
        >
          {labels.retryCommit}
        </button>
      </div>
    </div>
  );
}
