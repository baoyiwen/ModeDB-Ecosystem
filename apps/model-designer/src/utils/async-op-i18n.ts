import type { I18nManager } from '../managers/i18n-manager.js';
import type {
  AsyncOperationKey,
  AsyncOperationPhase,
} from '../managers/async-operation-manager.js';

const SUCCESS_UI_KEYS: Record<AsyncOperationKey, string> = {
  save: 'notifySaveSuccess',
  pull: 'notifyPullSuccess',
  loadCanvas: 'notifyLibraryReady',
  clearAllData: 'dataClearAllDone',
  clearModelData: 'dataClearModelDone',
  backupDatabase: 'backupCreateSuccess',
  exportBackup: 'backupExportSuccess',
  importBackup: 'backupImportSuccess',
  restoreDatabase: 'backupRestoreSuccess',
  clearDatabaseManaged: 'backupClearSuccess',
  forceResetDatabase: 'backupForceResetSuccess',
  openLibrary: 'notifyLibraryReady',
  reconnect: 'asyncOpDone_reconnect',
};

const ERROR_KEYS: Record<AsyncOperationKey, { ns: 'ui' | 'errors'; key: string }> = {
  save: { ns: 'errors', key: 'pushFailed' },
  pull: { ns: 'errors', key: 'pullFailed' },
  loadCanvas: { ns: 'ui', key: 'notifyLoadCanvasFailed' },
  clearAllData: { ns: 'errors', key: 'clearDataFailed' },
  clearModelData: { ns: 'errors', key: 'clearDataFailed' },
  backupDatabase: { ns: 'errors', key: 'databaseManagementFailed' },
  exportBackup: { ns: 'errors', key: 'databaseManagementFailed' },
  importBackup: { ns: 'errors', key: 'databaseManagementFailed' },
  restoreDatabase: { ns: 'errors', key: 'databaseManagementFailed' },
  clearDatabaseManaged: { ns: 'errors', key: 'databaseManagementFailed' },
  forceResetDatabase: { ns: 'errors', key: 'databaseManagementFailed' },
  openLibrary: { ns: 'errors', key: 'bootstrapFailed' },
  reconnect: { ns: 'errors', key: 'connectFailed' },
};

const NAME_IN_TITLE_KEYS = new Set<AsyncOperationKey>([
  'loadCanvas',
  'clearAllData',
  'clearModelData',
  'backupDatabase',
  'exportBackup',
  'importBackup',
  'restoreDatabase',
  'clearDatabaseManaged',
  'forceResetDatabase',
  'openLibrary',
]);

export interface AsyncOpLabels {
  title: string;
  message?: string;
}

/** 异步操作 toast 文案（进行中 / 成功 / 失败）。 */
export function resolveAsyncOpLabels(
  i18n: I18nManager,
  key: AsyncOperationKey,
  phase: AsyncOperationPhase,
  detail?: string,
  errorMessage?: string,
): AsyncOpLabels {
  if (phase === 'running') {
    return { title: i18n.t('ui', `asyncOp_${key}`) };
  }
  if (phase === 'success') {
    const successKey = SUCCESS_UI_KEYS[key];
    const title = NAME_IN_TITLE_KEYS.has(key)
      ? i18n.t('ui', successKey, { name: detail ?? '' })
      : i18n.t('ui', successKey);
    const message = NAME_IN_TITLE_KEYS.has(key) ? undefined : detail;
    return { title, message };
  }
  const err = ERROR_KEYS[key];
  return {
    title: i18n.t(err.ns, err.key),
    message: errorMessage ?? detail,
  };
}
