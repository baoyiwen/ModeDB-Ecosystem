import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  TRANSFER_MAX_BYTES,
  TransferError,
  type TransferIssue,
  type TransferModel,
  type TransferPreflight,
  type TransferProgress,
} from '@mode-db/data-kit';
import { useDesigner } from '../context/designer-context.js';
import {
  exportModelTransfer,
  exportInterfaceTransfer,
  validateModelTransfer,
  validateInterfaceTransfer,
} from '../data-transfer/execute.js';
import { interfaceResultHasRecordRefs } from '../data-transfer/interface-transfer.js';
import type { QueryInterfaceRelease } from '../query-designer/query-interface-publication.js';
import type { PivotDocument } from '../pivot/types.js';
import type { TransferFilter } from '../data-transfer/filters.js';

export interface PivotTransferFeedback {
  readonly busy: boolean;
  readonly progress?: TransferProgress;
  readonly message: string;
  readonly error: string;
  readonly cancel: () => void;
}

function download(bytes: BlobPart, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ]
    .map((part) => String(part).padStart(2, '0'))
    .join('');
}

/** Inline tools for the current Pivot source; never opens a second dialog. */
export function DataTransferPanel(props: {
  readonly modelName: string;
  readonly database: string;
  readonly schema?: TransferModel;
  readonly filters: readonly TransferFilter[];
  readonly disabled: boolean;
  readonly beforeExport: (signal: AbortSignal) => Promise<boolean>;
  readonly onFeedbackChange: (feedback: PivotTransferFeedback | null) => void;
  readonly refreshControl: ReactElement;
  readonly queryInterface?: {
    readonly release: QueryInterfaceRelease;
    readonly getDocument: () => PivotDocument | null;
  };
}): ReactElement {
  const { data, i18n } = useDesigner();
  const [importOpen, setImportOpen] = useState(false);
  const [includeRelations, setIncludeRelations] = useState(true);
  const [progress, setProgress] = useState<TransferProgress>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [filename, setFilename] = useState('');
  const [result, setResult] = useState<TransferPreflight>();
  const [parseIssues, setParseIssues] = useState<TransferIssue[]>([]);
  const upload = useRef<HTMLInputElement>(null);
  const job = useRef<AbortController | null>(null);
  const t = (key: string, values?: Record<string, string>): string => i18n.t('ui', key, values);
  const issues = result?.issues ?? parseIssues;
  const disabled = busy || props.disabled;
  const derived =
    props.queryInterface?.release.executionTemplate.resultAdapter.kind === 'aggregation';
  const currentDocument = props.queryInterface?.getDocument();
  const reportOnly =
    derived ||
    (props.queryInterface &&
      (currentDocument
        ? !interfaceResultHasRecordRefs(props.queryInterface.release, currentDocument)
        : !props.queryInterface.release.queryInterface.query.result.includesRecordRefs));

  const cancel = useCallback(() => {
    job.current?.abort();
    setMessage(i18n.t('ui', 'transferCancelling'));
  }, [i18n]);
  useEffect(() => {
    props.onFeedbackChange({ busy, progress, message, error, cancel });
  }, [busy, progress, message, error, cancel, props.onFeedbackChange]);
  useEffect(
    () => () => {
      job.current?.abort();
      job.current = null;
      props.onFeedbackChange(null);
    },
    [props.onFeedbackChange],
  );

  const describe = (issue: TransferIssue): string =>
    `${t(`transferIssue_${issue.code}`)}${issue.detail ? ` (${issue.detail})` : ''}`;
  const run = async (
    action: (signal: AbortSignal, notify: (value: TransferProgress) => void) => Promise<string>,
  ): Promise<void> => {
    if (job.current || props.disabled) return;
    const controller = new AbortController();
    job.current = controller;
    setBusy(true);
    setError('');
    setMessage('');
    setResult(undefined);
    setParseIssues([]);
    setProgress(undefined);
    try {
      const next = await action(controller.signal, (value) => {
        if (job.current === controller && !controller.signal.aborted) setProgress(value);
      });
      if (job.current === controller && !controller.signal.aborted) {
        setMessage(next);
        setProgress({ stage: 'complete', completed: 1, total: 1 });
      }
    } catch (caught) {
      if (job.current !== controller) return;
      if (
        controller.signal.aborted ||
        (caught instanceof TransferError && caught.code === 'cancelled')
      )
        setMessage(t('transferCancelled'));
      else if (caught instanceof TransferError) {
        const location = caught.location;
        const context = location
          ? [
              `${t('transferSheet')}: ${location.sheet}`,
              `${t('transferRow')}: ${location.row}`,
              ...(location.column ? [`${t('transferColumn')}: ${location.column}`] : []),
            ].join(' · ')
          : '';
        setError(
          [t(`transferIssue_${caught.code}`), context, caught.detail].filter(Boolean).join(' · '),
        );
        if (caught.location)
          setParseIssues([{ ...caught.location, code: caught.code, detail: caught.detail }]);
      } else setError(caught instanceof Error ? caught.message : t('transferFailed'));
    } finally {
      if (job.current === controller) {
        job.current = null;
        setBusy(false);
      }
    }
  };

  const exportFile = (template: boolean): void => {
    void run(async (signal, notify) => {
      if (!template) {
        notify({ stage: 'query', completed: 0 });
        if (!(await props.beforeExport(signal))) throw new Error(t('transferPreviewFailed'));
      }
      if (signal.aborted) throw new TransferError('cancelled');
      const pack = props.queryInterface
        ? await exportInterfaceTransfer({
            database: props.database,
            release: props.queryInterface.release,
            models: data.models,
            relations: data.relations,
            locale: i18n.locale,
            document: props.queryInterface.getDocument() ?? undefined,
            template,
            aggregateLabels: Object.fromEntries(
              ['count', 'sum', 'avg', 'min', 'max', 'distinct'].map((fn) => [
                fn,
                t(`pivotMetric_${fn}`),
              ]),
            ),
          })
        : await exportModelTransfer({
            database: props.database,
            modelName: props.modelName,
            models: data.models,
            locale: i18n.locale,
            filters: template ? [] : props.filters,
            template,
            signal,
            notify,
            includeRelations,
          });
      if (signal.aborted) throw new TransferError('cancelled');
      notify({ stage: 'workbook', completed: 0 });
      const { writeTransferWorkbook } = await import('../data-transfer/workbook.js');
      const bytes = await writeTransferWorkbook(pack, t);
      if (signal.aborted) throw new TransferError('cancelled');
      const base = `${props.modelName}-${template ? 'template' : 'data'}-${timestamp()}`.replace(
        /[<>:"/\\|?*\x00-\x1f]/g,
        '_',
      );
      download(
        bytes,
        `${base}.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      return t(
        pack.manifest.kind === 'report'
          ? 'transferInterfaceReportReady'
          : template
            ? 'transferTemplateReady'
            : 'transferExportReady',
        {
          rows: String(pack.rows.length),
          relations: String(pack.edges.length),
        },
      );
    });
  };

  const inspectFile = (file: File): void => {
    setFilename(file.name);
    void run(async (signal, notify) => {
      if (file.size > TRANSFER_MAX_BYTES) throw new TransferError('limit');
      notify({ stage: 'parse', completed: 0 });
      const { readTransferWorkbook } = await import('../data-transfer/workbook.js');
      const pack = await readTransferWorkbook(await file.arrayBuffer());
      if (signal.aborted) throw new TransferError('cancelled');
      if (
        !props.queryInterface &&
        (pack.manifest.models.length !== 1 || pack.manifest.models[0]?.name !== props.modelName)
      )
        throw new TransferError('model');
      const input = {
        database: props.database,
        data: pack,
        models: data.models,
        locale: i18n.locale,
        signal,
        notify,
      };
      const checked = props.queryInterface
        ? await validateInterfaceTransfer({
            ...input,
            release: props.queryInterface.release,
            relations: data.relations,
          })
        : await validateModelTransfer(input);
      if (!signal.aborted && job.current) setResult(checked);
      return t(checked.valid ? 'transferValid' : 'transferInvalid');
    });
  };

  return (
    <section
      className="data-transfer-panel"
      aria-label={t(props.queryInterface ? 'transferInterfaceTitle' : 'transferTitle')}
    >
      <div className="data-transfer-actions">
        {props.refreshControl}
        <button
          type="button"
          className="designer-btn"
          disabled={disabled || (!props.queryInterface && !props.schema)}
          data-unavailable={!props.queryInterface && !props.schema}
          onClick={() => exportFile(false)}
        >
          {t(props.queryInterface ? 'transferExportResult' : 'transferExportData')}
        </button>
        <button
          type="button"
          className="designer-btn"
          disabled={disabled || derived || (!props.queryInterface && !props.schema)}
          data-unavailable={derived || (!props.queryInterface && !props.schema)}
          title={derived ? t('transferInterfaceDerivedHint') : undefined}
          onClick={() => exportFile(true)}
        >
          {t('transferDownloadTemplate')}
        </button>
        <button
          type="button"
          className="designer-btn"
          disabled={disabled}
          aria-expanded={importOpen}
          aria-controls="pivot-import-preflight"
          onClick={() => setImportOpen((value) => !value)}
        >
          <span aria-hidden="true">{importOpen ? '▾' : '▸'}</span> {t('transferPreflight')}
        </button>
        {props.queryInterface ? (
          <details className="pivot-export-help">
            <summary>{t('transferExportHelp')}</summary>
            <p className="data-transfer-muted">
              {t('transferInterfaceScope')}{' '}
              {reportOnly ? t('transferInterfaceReportHint') : t('transferInterfaceImportHint')}
            </p>
          </details>
        ) : null}
      </div>
      {!props.queryInterface ? (
        <label className="data-transfer-relation-option">
          <input
            type="checkbox"
            checked={includeRelations}
            disabled={disabled}
            onChange={(event) => setIncludeRelations(event.target.checked)}
          />
          <span>
            {t('transferIncludeRelations')}
            <small>{t('transferRelationHint')}</small>
          </span>
        </label>
      ) : null}
      <div id="pivot-import-preflight" className="data-transfer-import" hidden={!importOpen}>
        <p>{t('transferPreflightHint')}</p>
        <div className="data-transfer-actions">
          <input
            ref={upload}
            type="file"
            accept=".xlsx"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) inspectFile(file);
            }}
          />
          <button
            type="button"
            className="designer-btn"
            disabled={disabled}
            onClick={() => upload.current?.click()}
          >
            {t('transferChooseFile')}
          </button>
          <span className="data-transfer-filename">{filename}</span>
        </div>
        <p className="data-transfer-muted">{t('transferLimits')}</p>
        {result ? (
          <dl className="data-transfer-counts">
            {(
              [
                ['transferRows', result.rows],
                ['transferNewRows', result.newRows],
                ['transferExistingRows', result.existingRows],
                ['transferRelations', result.relations],
                ['transferIssues', result.issues.length],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{t(label)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {issues.length || result ? (
          <button
            type="button"
            className="designer-btn data-transfer-report"
            onClick={() =>
              download(
                JSON.stringify(
                  {
                    ...result,
                    database: props.database,
                    filename,
                    issues: issues.map((issue) => ({ ...issue, message: describe(issue) })),
                  },
                  null,
                  2,
                ),
                `validation-${timestamp()}.json`,
                'application/json',
              )
            }
          >
            {t('transferDownloadReport')}
          </button>
        ) : null}
        {issues.length ? (
          <div
            className="data-transfer-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={t('transferIssues')}
          >
            <table>
              <thead>
                <tr>
                  <th>{t('transferSheet')}</th>
                  <th>{t('transferRow')}</th>
                  <th>{t('transferColumn')}</th>
                  <th>{t('transferProblem')}</th>
                </tr>
              </thead>
              <tbody>
                {issues.slice(0, 200).map((issue, index) => (
                  <tr key={index}>
                    <td>{issue.sheet}</td>
                    <td>{issue.row}</td>
                    <td>{issue.column ?? '—'}</td>
                    <td>{describe(issue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {issues.length > 200 ? <p>{t('transferMoreIssues')}</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
