/** Registration approval and maintenance use an explicit configuration and OS-local pipe. */
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadModelDBServerConfig } from './config-loader.js';
import { callLocalSecurity } from './security/local-management-channel.js';
import { parseRegistrationApprovalRequest } from './security/registration-approval.js';
import { parseRegistrationMaintenance } from './security/registration-maintenance.js';
import { SecurityError } from './security/security-errors.js';

export async function runRegistrationApprovalCli(argv: string[]): Promise<void> {
  const action = argv[0];
  const fields: Record<string, readonly string[]> = {
    'registration-list': ['--instance', '--offset', '--limit'],
    'registration-approve': [
      '--instance',
      '--id',
      '--revision',
      '--principal',
      '--name',
      '--grants-file',
    ],
    'registration-reject': ['--instance', '--id', '--revision'],
    'registration-credentials-list': ['--instance', '--offset', '--limit', '--user'],
    'registration-users-list': ['--instance', '--offset', '--limit'],
    'registration-credential-disable': ['--instance', '--id', '--revision'],
    'registration-credential-enable': ['--instance', '--id', '--revision'],
    'registration-credential-revoke': ['--instance', '--id', '--revision'],
    'registration-user-disable': ['--instance', '--id', '--revision'],
    'registration-user-enable': ['--instance', '--id', '--revision'],
    'registration-credential-restrict': ['--instance', '--id', '--revision', '--grants-file'],
    'registration-credential-replace': [
      '--instance',
      '--id',
      '--revision',
      '--application',
      '--grants-file',
    ],
  };
  if (!action || !Object.hasOwn(fields, action)) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const options = new Map<string, string>();
  let yes = false;
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i] === '-c' ? '--config' : argv[i]!;
    if (key === '--yes') {
      if (yes || action === 'registration-list' || action.endsWith('-list')) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      yes = true;
      continue;
    }
    if (
      (key !== '--config' && !fields[action]!.includes(key)) ||
      options.has(key) ||
      !argv[i + 1] ||
      argv[i + 1]!.startsWith('--')
    ) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    options.set(key, argv[++i]!);
  }
  if (!options.has('--config')) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  let grants: unknown;
  if (
    [
      'registration-approve',
      'registration-credential-restrict',
      'registration-credential-replace',
    ].includes(action)
  ) {
    const file = options.get('--grants-file');
    if (!file) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    try {
      const path = resolve(file),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 32768) {
        throw new Error();
      }
      const bytes = readFileSync(path);
      if (bytes.length > 32768) {
        throw new Error();
      }
      grants = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
  }
  const maintenance = ![
    'registration-list',
    'registration-approve',
    'registration-reject',
  ].includes(action);
  const request = maintenance
    ? parseRegistrationMaintenance({
        action: action.replaceAll('-', '.'),
        instanceId: options.get('--instance'),
        ...(action.endsWith('-list')
          ? {
              offset: Number(options.get('--offset') ?? 0),
              limit: Number(options.get('--limit') ?? 25),
              ...(options.has('--user') ? { userId: options.get('--user') } : {}),
            }
          : {
              id: options.get('--id'),
              revision: options.has('--revision') ? Number(options.get('--revision')) : undefined,
              confirm: yes,
              ...(grants !== undefined ? { grants } : {}),
              ...(options.has('--application')
                ? { applicationId: options.get('--application') }
                : {}),
            }),
      })
    : parseRegistrationApprovalRequest(
        action === 'registration-list'
          ? {
              action: 'registration.list',
              instanceId: options.get('--instance'),
              offset: Number(options.get('--offset') ?? 0),
              limit: Number(options.get('--limit') ?? 25),
            }
          : {
              action:
                action === 'registration-approve' ? 'registration.approve' : 'registration.reject',
              instanceId: options.get('--instance'),
              id: options.get('--id'),
              revision: options.has('--revision') ? Number(options.get('--revision')) : undefined,
              confirm: yes,
              ...(action === 'registration-approve'
                ? { principalId: options.get('--principal'), name: options.get('--name'), grants }
                : {}),
            },
      );
  const cfg = await loadModelDBServerConfig(options.get('--config'), {});
  if (cfg.securityMode !== 'registry') {
    throw new SecurityError('SECURITY_INVALID_CONFIG');
  }
  const result = await callLocalSecurity(resolve(dirname(cfg.configFilePath), 'security'), request);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
