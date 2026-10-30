import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadModelDBServerConfig } from './config-loader.js';
import { assertRecoveryPath } from './security/recovery-material.js';
import { SecurityRegistry } from './security/security-registry.js';
import { SecurityError } from './security/security-errors.js';
import { WindowsSecretProtector } from './security/windows-secret-protector.js';

/** Offline metadata listing for the exact stopped instance. Never initializes or migrates it. */
export async function runRecipientListCli(argv: string[]): Promise<void> {
  const options = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const name = argv[i] === '-c' ? '--config' : argv[i]!;
    if (
      !['--config', '--instance', '--offset', '--limit'].includes(name) ||
      options.has(name) ||
      !argv[i + 1] ||
      argv[i + 1]!.startsWith('--')
    ) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    options.set(name, argv[++i]!);
  }
  if (argv[0] !== 'recipient-list' || !options.get('--config') || !options.get('--instance')) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const integer = (name: string, fallback: number) => {
    const value = options.get(name);
    if (value !== undefined && !/^(0|[1-9][0-9]{0,4})$/.test(value)) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    return value === undefined ? fallback : Number(value);
  };
  const offset = integer('--offset', 0),
    limit = integer('--limit', 25);
  const cfg = await loadModelDBServerConfig(options.get('--config'), {});
  if (cfg.securityMode !== 'registry') {
    throw new SecurityError('SECURITY_INVALID_CONFIG');
  }
  const directory = assertRecoveryPath(join(dirname(cfg.configFilePath), 'security'));
  if (!existsSync(join(directory, 'registry.mds'))) {
    throw new SecurityError('SECURITY_NOT_FOUND');
  }
  const registry = SecurityRegistry.open(directory, {
    auditLimit: cfg.securityAudit.maxEvents,
    auditRetentionDays: cfg.securityAudit.retentionDays,
  });
  try {
    const result = registry.withLocalActor(new WindowsSecretProtector().currentIdentity(), () =>
      registry.manageRegistration({
        action: 'registration.recipient.list',
        instanceId: options.get('--instance'),
        offset,
        limit,
      }),
    );
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    registry.close();
  }
}
