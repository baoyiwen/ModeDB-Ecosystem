import {
  coerceInsertManyOps,
  summarizeInsertManyOutcomes,
  type ImportFieldTypeMap,
} from '@mode-db/data-kit';
import type { ReactElement } from 'react';
import { useDataPage } from '@mode-db/data-ui';
import { useStudio, useStudioLocale } from '../context/studio-context.js';
import { notifyImportCommitResult } from '../utils/import-commit-notify.js';

const MODE_KEYS: Record<string, string> = {
  view: 'modeView',
  edit: 'modeEdit',
  delete: 'modeDelete',
};

export interface StudioToolbarProps {
  readonly importFieldTypes?: ImportFieldTypeMap;
}

/** Localized data page toolbar with commit toasts. */
export function StudioToolbar(props: StudioToolbarProps = {}): ReactElement {
  const { importFieldTypes } = props;
  const page = useDataPage();
  const { i18n, notify } = useStudio();
  useStudioLocale();

  const handleCommit = (): void => {
    void (async (): Promise<void> => {
      try {
        if (importFieldTypes) {
          page.replacePendingOps(coerceInsertManyOps(page.binding.pendingOps, importFieldTypes));
        }
        const result = await page.commitBatch();
        if (!result.ok) {
          notifyImportCommitResult(result, i18n, notify);
          return;
        }
        const { inserted } = summarizeInsertManyOutcomes(result.outcomes);
        if (inserted > 0) {
          notify.success(
            i18n.t('commitSuccess'),
            i18n.t('commitSuccessImport', { inserted: String(inserted) }),
          );
        } else {
          notify.success(
            i18n.t('commitSuccess'),
            i18n.t('commitSuccessDetail', { count: String(result.committedCount) }),
          );
        }
      } catch (e) {
        notify.error(i18n.t('commitFailed'), e instanceof Error ? e.message : String(e));
      }
    })();
  };

  return (
    <header className="studio-data-toolbar">
      {page.allowedModes.map((m) => (
        <button
          key={m}
          type="button"
          className="studio-segment-btn"
          aria-pressed={page.mode === m}
          disabled={page.isRefreshing}
          onClick={() => page.setMode(m)}
        >
          {i18n.t(MODE_KEYS[m] ?? m)}
        </button>
      ))}
      <span className="studio-toolbar-spacer" />
      {page.isDirty ? (
        <>
          <button type="button" className="studio-toolbar-btn" onClick={() => page.discard()}>
            {i18n.t('discard')}
          </button>
          <button
            type="button"
            className="studio-toolbar-btn studio-toolbar-btn--primary"
            onClick={handleCommit}
          >
            {i18n.t('commit')} ({page.binding.pendingCount})
          </button>
        </>
      ) : null}
      <button
        type="button"
        className="studio-toolbar-btn"
        disabled={page.isRefreshing}
        onClick={() => void page.refresh()}
      >
        {page.isRefreshing ? i18n.t('loading') : i18n.t('refresh')}
      </button>
      {page.lastError ? <span className="studio-toolbar-error">{page.lastError}</span> : null}
    </header>
  );
}
