import { connectionSecurityIssue } from '@mode-db/sdk';
import type { StudioI18n } from '../managers/i18n-manager.js';

/** Translate the SDK's stable security failures for the connection panel. */
export function connectionErrorMessage(error: unknown, i18n: StudioI18n): string {
  const issue = connectionSecurityIssue(error);
  const detail = error instanceof Error ? error.message : String(error);
  return issue ? `${i18n.t(`security_${issue}`)} (${detail})` : detail;
}
