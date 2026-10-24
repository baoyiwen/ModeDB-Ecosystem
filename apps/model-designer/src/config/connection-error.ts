import { connectionSecurityIssue } from '@mode-db/sdk';
import type { I18nManager } from '../managers/i18n-manager.js';

/** Translate connection failures while retaining their safe diagnostic code. */
export function connectionErrorMessage(error: unknown, i18n: I18nManager): string {
  const issue = connectionSecurityIssue(error);
  const detail = error instanceof Error ? error.message : String(error);
  return issue ? `${i18n.t('errors', `security_${issue}`)} (${detail})` : detail;
}
