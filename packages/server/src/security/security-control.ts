import type { SecurityProtectionConfig } from '@mode-db/shared';
import type { SecurityProtection } from './security-protection.js';
import type { SecurityMaintenance } from './security-maintenance.js';
import { SecurityError } from './security-errors.js';
import type { DeploymentWizard } from './deployment-files.js';

export interface SecurityControl {
  readonly protection: SecurityProtection;
  readonly maintenance?: SecurityMaintenance;
  readonly deployment?: DeploymentWizard;
}

/** Session refresh never extends the five-minute local pairing proof for key maintenance. */
export function requireRecentSecurityPairing(createdAt: string, now = Date.now()): void {
  const issued = Date.parse(createdAt);
  if (!Number.isFinite(issued) || now < issued || now - issued > 300000) {
    throw new SecurityError('SECURITY_REAUTH_REQUIRED');
  }
}

/** Exactly the same validation/mutation path for paired administrators and OS-authenticated CLI. */
export function dispatchSecurityControl(
  control: SecurityControl,
  input: unknown,
  current?: Parameters<SecurityProtection['preview']>[1],
): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const request = input as Record<string, unknown>;
  const fields: Record<string, readonly string[]> = {
    'network.status': [],
    'network.preview': ['config'],
    'network.apply': ['config', 'revision', 'previewId'],
    'network.confirm': ['id'],
    'network.rollback': ['revision'],
    'network.unban': ['id'],
    'maintenance.status': [],
    'master.rotate': ['confirm'],
    'deployment.status': [],
    'deployment.preview': ['draft'],
  };
  if (
    typeof request.action !== 'string' ||
    !Object.hasOwn(fields, request.action) ||
    Object.keys(request).some(
      (key) => key !== 'action' && !fields[request.action as string]!.includes(key),
    )
  ) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  switch (request.action) {
    case 'deployment.status':
    case 'deployment.preview':
      if (!control.deployment) {
        throw new SecurityError('SECURITY_FORBIDDEN');
      }
      return request.action === 'deployment.status'
        ? control.deployment.status()
        : control.deployment.preview(request.draft as Parameters<DeploymentWizard['preview']>[0]);
    case 'network.status':
      return control.protection.snapshot();
    case 'network.preview':
      return control.protection.preview(request.config as SecurityProtectionConfig, current);
    case 'network.apply':
      return control.protection.apply(
        request.config as SecurityProtectionConfig,
        request.revision as number,
        request.previewId as string,
      );
    case 'network.confirm':
      return control.protection.confirm(request.id as string);
    case 'network.rollback':
      return control.protection.rollback(request.revision as number);
    case 'network.unban':
      return control.protection.unban(request.id as string);
    case 'maintenance.status':
      if (!control.maintenance) {
        throw new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE');
      }
      return control.maintenance.status();
    case 'master.rotate':
      if (!control.maintenance || request.confirm !== true) {
        throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
      }
      return control.maintenance.rotateMaster();
    default:
      throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
}
