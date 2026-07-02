import {
  countInsertManySuccesses,
  summarizeInsertManyOutcomes,
  type ApplyBatchResult,
} from '@mode-db/data-kit';
import type { StudioI18n } from '../managers/i18n-manager.js';
import type { StudioNotificationManager } from '../managers/notification-manager.js';

/** Shows toasts for import / batch commit results (toolbar + import failure retry). */
export function notifyImportCommitResult(
  result: ApplyBatchResult,
  i18n: StudioI18n,
  notify: StudioNotificationManager,
): void {
  if (result.ok) {
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
    return;
  }

  const inserted = countInsertManySuccesses(result.outcomes);
  if (result.importFailures && result.importFailures.length > 0) {
    notify.warning(
      i18n.t('commitFailed'),
      result.partialSuccess && inserted > 0
        ? i18n.t('importFailurePartialDetail', {
            failed: String(result.importFailures.length),
            inserted: String(inserted),
          })
        : i18n.t('importFailureReviewHint'),
    );
    return;
  }

  notify.error(i18n.t('commitFailed'), result.error ?? undefined);
}
