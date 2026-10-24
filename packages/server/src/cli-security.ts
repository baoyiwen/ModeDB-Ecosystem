import { basename, dirname, relative, resolve, sep } from 'node:path';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  realpathSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { assertFlatGraphSegment } from '@mode-db/common';
import { runBackupSecurityCli } from './cli-backup-security.js';
import { runAssetCli } from './cli-asset.js';
import {
  securityOrigin,
  isLoopbackAddress,
  SecurityNetworkPolicy,
} from './security/network-policy.js';
import { SecurityProtection } from './security/security-protection.js';
import { SecurityMaintenance } from './security/security-maintenance.js';
import {
  resumeFactoryReset,
  restoreResetArchive,
  verifyResetArchive,
} from './security/reset-recovery.js';
import { LocalVaultKeyProvider } from './security/local-vault-key-provider.js';
import { loadModelDBServerConfig } from './config-loader.js';
import {
  callLocalSecurity,
  startLocalSecurityChannel,
} from './security/local-management-channel.js';
import { SecurityRegistry } from './security/security-registry.js';
import { WindowsSecretProtector } from './security/windows-secret-protector.js';
import { SecurityError } from './security/security-errors.js';
import {
  createRecoveryPackageFile,
  restoreRecoveryPackageFile,
  rotateDatabaseVaultKey,
  verifyRecoveryPackageFile,
  checkRecoveryPackageDependencies,
  readRecoveryPassphraseFile,
  assertRecoveryPath,
} from './security/recovery-material.js';

export function resolveAuditExportPath(directory: string, target: string): string {
  const outputPath = resolve(target);
  let registryPath: string;
  let outputParent: string;
  try {
    registryPath = realpathSync(directory);
    outputParent = realpathSync(dirname(outputPath));
  } catch {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const resolvedOutputPath = resolve(outputParent, basename(outputPath));
  const relativeOutputPath = relative(registryPath, resolvedOutputPath);
  if (
    relativeOutputPath === '' ||
    (relativeOutputPath !== '..' && !relativeOutputPath.startsWith(`..${sep}`))
  ) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  return resolvedOutputPath;
}

/** Security maintenance through the OS-authenticated local pipe only. */
export async function runSecurityCli(argv: string[]): Promise<void> {
  const action = argv[0];
  if (action?.startsWith('asset-')) {
    await runAssetCli(argv);
    return;
  }
  if (['backup-key-create', 'backup-export', 'backup-import'].includes(action)) {
    await runBackupSecurityCli(argv);
    return;
  }
  const options = new Map<string, string>();
  let yes = false;
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--yes') {
      yes = true;
      continue;
    }
    if (
      ![
        '-c',
        '--config',
        '--name',
        '--principal',
        '--id',
        '--grants-file',
        '--days',
        '--grace-minutes',
        '--output',
        '--offset',
        '--limit',
        '--minutes',
        '--origin',
        '--url',
        '--server',
        '--databases',
        '--from',
        '--to',
        '--category',
        '--result',
        '--action',
        '--principal',
        '--credential',
        '--database',
        '--request-id',
        '--client-ip',
        '--rules-file',
        '--revision',
        '--preview',
        '--target',
        '--instance',
        '--passphrase-file',
        '--package',
        '--target-security',
        '--vault',
        '--state',
      ].includes(key) ||
      !argv[i + 1]
    ) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    options.set(key, argv[++i]);
  }
  if (action === 'help' || !action) {
    process.stdout.write(
      'security serve|status|principal-create|credentials|audit|audit-export|token-create|token-rotate|token-revoke|session-pair|browser-open|security-open|reset-access [-c <config>]\n' +
        'credentials [--offset 0] [--limit 25] (use a smaller limit if metadata exceeds the response bound)\n' +
        'audit [--offset 0] [--limit 50] [audit filters] (read a bounded page through the OS-local channel)\n' +
        'audit-export --output <new-file.jsonl> [audit filters] (no-overwrite JSONL export via the OS-authenticated local channel)\n' +
        'audit filters: --from <utc> --to <utc> --category <name> --result <name> --action <name> --principal <id> --credential <id> --database <name> --request-id <id> --client-ip <ip>\n' +
        'token-create --principal <id> --name <name> [--grants-file <json>] [--days 30] --output <protected-file>\n' +
        'token-rotate --id <id> [--grace-minutes 10] --output <protected-file>\n' +
        'session-pair --id <credential-id> --origin <frontend-origin> [--minutes 10] (one-time browser pairing code)\n' +
        'browser-open [--url http://127.0.0.1:5175/] [--server <server-origin>] [--databases <name1,name2>] (trusted local browser launcher)\n' +
        'security-open [--url http://127.0.0.1:5175/] [--server <server-origin>] (opens the Designer with a short-lived security-admin session)\n' +
        'reset-access --yes (revokes access; does not change data keys)\n' +
        'network-status | network-preview --rules-file <json> | network-apply --rules-file <json> --revision <n> --preview <preview-id>\n' +
        'network-confirm --id <pending-id> | network-rollback --revision <n> | network-unban --id <ban-id>\n' +
        'maintenance-status | master-rotate --yes (retains historical masters; resumes interrupted rewrapping)\n' +
        'factory-reset -c <config> --instance <id> --target <exact-workspace> --yes (offline only; verified encrypted backup required)\n' +
        'factory-reset-verify --package <archive.mdreset> --instance <id> --target <original-workspace> -c <config> (same OS account)\n' +
        'factory-reset-resume --package <archive.mdreset> --instance <id> --target <exact-workspace> --yes -c <config> (offline; unchanged remaining files only)\n' +
        'factory-reset-restore --package <archive.mdreset> --instance <id> --target <original-workspace> --output <new-directory> --yes -c <config> (quarantine copy; excludes archived access ledger)\n' +
        'recovery-create --instance <id> --yes --output <external-package> --passphrase-file <protected-file> -c <config> (offline)\n' +
        'recovery-verify --package <package> --passphrase-file <protected-file>\n' +
        'recovery-check --package <package> --vault <vault-or-backup.mld> --passphrase-file <protected-file>\n' +
        'recovery-restore --yes --package <package> --target-security <new-security-dir> --passphrase-file <protected-file>\n' +
        'database-key-rotate --instance <id> --yes --vault <exact-vault> --database <name> -c <config> (offline; resumable)\n' +
        'asset-signing-key-create --output <protected-prefix> --passphrase-file <protected-file>\n' +
        'asset-export -c <config> --instance <id> --database <db> --selection <json> --asset-id <id> --asset-version <semver> --public-key <recipient.pem> --signing-key <private.json> --passphrase-file <protected-file> --output <new-file> --yes (offline; selected business models only)\n' +
        'asset-preview|asset-import -c <config> --instance <id> --database <new-db> --package <file> --private-key <recipient.private.json> --passphrase-file <protected-file> --publisher-key <publisher.pem> --publisher-fingerprint <verified-sha256> [--preview-digest <digest> --yes] (offline; import requires preview confirmation)\n' +
        'backup-key-create --output <protected-prefix> --passphrase-file <protected-file>\n' +
        'backup-export --database <name> --public-key <pem> --output <new-package> --instance <id> --yes -c <config> (offline)\n' +
        'backup-import --database <new-name> --private-key <private.json> --package <package> --passphrase-file <protected-file> --instance <id> --yes -c <config> (offline; stores a verified local backup)\n',
    );
    return;
  }
  const readPassphrase = (): string => {
    const file = options.get('--passphrase-file');
    if (!file) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    return readRecoveryPassphraseFile(file, (path) =>
      new WindowsSecretProtector().ensureDirectory(path),
    );
  };
  if (action === 'recovery-verify' || action === 'recovery-check') {
    const packagePath = options.get('--package');
    if (!packagePath) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    const passphrase = readPassphrase();
    if (action === 'recovery-check') {
      const vault = options.get('--vault');
      if (!vault) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      const result = checkRecoveryPackageDependencies(packagePath, passphrase, [vault]);
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!result.covered) {
        throw new SecurityError('SECURITY_NOT_FOUND');
      }
    } else {
      process.stdout.write(
        JSON.stringify(verifyRecoveryPackageFile(packagePath, passphrase)) + '\n',
      );
    }
    return;
  }
  if (action === 'recovery-restore') {
    const packagePath = options.get('--package');
    const targetSecurity = options.get('--target-security');
    if (!yes) {
      throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
    }
    if (!packagePath || !targetSecurity) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    process.stdout.write(
      JSON.stringify(restoreRecoveryPackageFile(packagePath, readPassphrase(), targetSecurity)) +
        '\n',
    );
    return;
  }
  if (
    (action === 'recovery-create' ||
      action === 'database-key-rotate' ||
      action?.startsWith('factory-reset')) &&
    !options.get('-c') &&
    !options.get('--config')
  ) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const cfg = await loadModelDBServerConfig(options.get('-c') ?? options.get('--config'), {});
  const directory = resolve(dirname(cfg.configFilePath), 'security');
  if (['factory-reset-verify', 'factory-reset-resume', 'factory-reset-restore'].includes(action)) {
    const archive = options.get('--package'),
      instanceId = options.get('--instance'),
      target = options.get('--target');
    if (cfg.securityMode !== 'registry' || !archive || !instanceId || !target) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    const workspace = resolve(cfg.workspace ?? cfg.storageRoot);
    if (resolve(target) !== workspace) {
      throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
    }
    const input = { directory, workspace, instanceId, archive, yes };
    let result: unknown;
    if (action === 'factory-reset-verify') {
      result = verifyResetArchive(input);
    } else if (action === 'factory-reset-resume') {
      result = resumeFactoryReset(input);
    } else {
      const output = options.get('--output');
      if (!output) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      result = restoreResetArchive({ ...input, output });
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (action === 'recovery-create' || action === 'database-key-rotate') {
    if (cfg.securityMode !== 'registry') {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    if (!yes || !options.get('--instance')) {
      throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
    }
    assertRecoveryPath(directory);
    if (!existsSync(resolve(directory, 'registry.mds'))) {
      throw new SecurityError('SECURITY_NOT_FOUND');
    }
    const registry = SecurityRegistry.open(directory, {
      auditLimit: cfg.securityAudit.maxEvents,
      auditRetentionDays: cfg.securityAudit.retentionDays,
      resumeDatabaseRotation: action === 'database-key-rotate',
    });
    try {
      const provider = new LocalVaultKeyProvider(directory);
      if (registry.status().instanceId !== options.get('--instance')) {
        throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
      }
      if (action === 'recovery-create') {
        const output = options.get('--output');
        if (!output) {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
        const passphrase = readPassphrase();
        registry.recordMaintenance('recovery.export.started');
        const result = createRecoveryPackageFile(provider, output, passphrase, directory, registry);
        registry.recordMaintenance('recovery.export.completed');
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        const vault = options.get('--vault');
        const database = options.get('--database');
        if (!vault || !database) {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
        assertFlatGraphSegment(database, 'database');
        const nested = resolve(cfg.storageRoot, database, 'atlas.mld');
        const expected = existsSync(nested) ? nested : resolve(cfg.storageRoot, `${database}.mld`);
        if (assertRecoveryPath(vault) !== assertRecoveryPath(expected)) {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
        const state = resolve(directory, 'database-key-rotation.json');
        if (options.has('--state') && resolve(options.get('--state')!) !== state) {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
        registry.recordMaintenance('database.rotate.started');
        const result = rotateDatabaseVaultKey(
          vault,
          database,
          provider,
          state,
          undefined,
          registry,
        );
        registry.recordMaintenance('database.rotate.completed');
        process.stdout.write(JSON.stringify(result) + '\n');
      }
    } catch (error) {
      registry.recordMaintenance(
        action === 'recovery-create' ? 'recovery.export.failed' : 'database.rotate.failed',
      );
      throw error;
    } finally {
      registry.close();
    }
    return;
  }
  if (action === 'factory-reset') {
    if (cfg.securityMode !== 'registry') {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    if (!yes || !options.get('--instance') || !options.get('--target')) {
      throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
    }
    if (!existsSync(resolve(directory, 'registry.mds'))) {
      throw new SecurityError('SECURITY_NOT_FOUND');
    }
    const registry = SecurityRegistry.open(directory, {
      auditLimit: cfg.securityAudit.maxEvents,
      auditRetentionDays: cfg.securityAudit.retentionDays,
    });
    try {
      const maintenance = new SecurityMaintenance(
        registry,
        new LocalVaultKeyProvider(directory),
        directory,
        cfg.workspace ?? cfg.storageRoot,
      );
      process.stdout.write(
        JSON.stringify(
          maintenance.factoryReset({
            instanceId: options.get('--instance')!,
            target: options.get('--target')!,
            yes,
          }),
        ) + '\n',
      );
    } finally {
      registry.close();
    }
    return;
  }
  if (action === 'browser-open' || action === 'security-open') {
    const target = new URL(options.get('--url') ?? 'http://127.0.0.1:5175/');
    const origin = securityOrigin(target.origin);
    if (
      !isLoopbackAddress(target.hostname) ||
      target.username ||
      target.password ||
      target.hash ||
      target.search
    ) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    const mode = cfg.securityNetwork?.transport?.mode ?? 'loopback';
    const server = securityOrigin(
      options.get('--server') ??
        (cfg.publicBaseUrl || `${mode === 'loopback' ? 'http' : 'https'}://127.0.0.1:${cfg.port}`),
    );
    const serverUrl = new URL(server);
    if (
      !isLoopbackAddress(serverUrl.hostname) ||
      target.protocol !== serverUrl.protocol ||
      target.hostname !== serverUrl.hostname
    ) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    const paired = (await callLocalSecurity(directory, {
      action: action === 'security-open' ? 'browser.security.launch' : 'browser.launch',
      origin,
      databases: options
        .get('--databases')
        ?.split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    })) as { code: string; expiresAt: string };
    target.hash = new URLSearchParams({
      'modeldb-pair': paired.code,
      'modeldb-server': server,
    }).toString();
    await new Promise<void>((done, reject) => {
      const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', target.href], {
        windowsHide: true,
        stdio: 'ignore',
      });
      opener.once('error', () => reject(new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE')));
      opener.once('exit', (code) =>
        code === 0 ? done() : reject(new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE')),
      );
    });
    process.stdout.write(
      JSON.stringify({ opened: true, origin, expiresAt: paired.expiresAt }) + '\n',
    );
    return;
  }
  if (action === 'serve') {
    const registry = SecurityRegistry.open(directory, {
      auditLimit: cfg.securityAudit.maxEvents,
      auditRetentionDays: cfg.securityAudit.retentionDays,
    });
    let channel: Awaited<ReturnType<typeof startLocalSecurityChannel>> | undefined;
    let protection: SecurityProtection | undefined;
    try {
      const network = new SecurityNetworkPolicy(cfg.securityNetwork, {
        host: cfg.host,
        port: cfg.port,
        publicBaseUrl: cfg.publicBaseUrl,
        directory: dirname(directory),
      });
      protection = new SecurityProtection(registry, network);
      const maintenance = new SecurityMaintenance(
        registry,
        new LocalVaultKeyProvider(directory),
        directory,
        cfg.workspace ?? cfg.storageRoot,
      );
      maintenance.resumeRotation();
      channel = await startLocalSecurityChannel(directory, registry, () => [], {
        protection,
        maintenance,
      });
      process.stderr.write('[ModelDB] Local security maintenance ready.\n');
      await new Promise<void>((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
    } finally {
      await channel?.close();
      protection?.close();
      registry.close();
    }
    return;
  }
  let request: Record<string, unknown>;
  const auditQuery = {
    ...(options.has('--from') ? { fromUtc: options.get('--from') } : {}),
    ...(options.has('--to') ? { toUtc: options.get('--to') } : {}),
    ...(options.has('--category') ? { category: options.get('--category') } : {}),
    ...(options.has('--result') ? { result: options.get('--result') } : {}),
    ...(options.has('--action') ? { action: options.get('--action') } : {}),
    ...(options.has('--principal') ? { principalId: options.get('--principal') } : {}),
    ...(options.has('--credential') ? { credentialId: options.get('--credential') } : {}),
    ...(options.has('--database') ? { database: options.get('--database') } : {}),
    ...(options.has('--request-id') ? { requestId: options.get('--request-id') } : {}),
    ...(options.has('--client-ip') ? { clientIp: options.get('--client-ip') } : {}),
  };
  switch (action) {
    case 'network-status':
      request = { action: 'network.status' };
      break;
    case 'network-preview':
    case 'network-apply':
      if (!options.get('--rules-file')) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      request = {
        action: action === 'network-preview' ? 'network.preview' : 'network.apply',
        config: JSON.parse(readFileSync(resolve(options.get('--rules-file')!), 'utf8')),
        ...(action === 'network-apply'
          ? { revision: Number(options.get('--revision')), previewId: options.get('--preview') }
          : {}),
      };
      break;
    case 'network-confirm':
      request = { action: 'network.confirm', id: options.get('--id') };
      break;
    case 'network-rollback':
      request = { action: 'network.rollback', revision: Number(options.get('--revision')) };
      break;
    case 'network-unban':
      request = { action: 'network.unban', id: options.get('--id') };
      break;
    case 'maintenance-status':
      request = { action: 'maintenance.status' };
      break;
    case 'master-rotate':
      if (!yes) {
        throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
      }
      request = { action: 'master.rotate', confirm: true };
      break;
    case 'status':
      request = { action: 'status' };
      break;
    case 'principal-create':
      request = { action: 'principal.create', name: options.get('--name') };
      break;
    case 'credentials':
      request = {
        action: 'credentials.list',
        offset: Number(options.get('--offset') ?? 0),
        limit: Number(options.get('--limit') ?? 25),
      };
      break;
    case 'audit':
      request = {
        action: 'audit.page',
        query: {
          ...auditQuery,
          offset: Number(options.get('--offset') ?? 0),
          limit: Number(options.get('--limit') ?? 50),
        },
      };
      break;
    case 'audit-export': {
      const target = options.get('--output');
      if (!target) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      const outputPath = resolveAuditExportPath(directory, target);
      let fd: number | undefined;
      let created = false;
      try {
        fd = openSync(outputPath, 'wx', 0o600);
        created = true;
        let offset = 0;
        let total = 0;
        for (;;) {
          const page = (await callLocalSecurity(directory, {
            action: 'audit.page',
            query: { ...auditQuery, offset, limit: 50 },
          })) as { events: readonly unknown[]; total: number; hasMore: boolean };
          if (!Array.isArray(page.events)) {
            throw new SecurityError('SECURITY_RESPONSE_LIMIT');
          }
          if (page.events.length) {
            writeFileSync(fd, page.events.map((event) => JSON.stringify(event)).join('\n') + '\n');
            total += page.events.length;
          }
          offset += page.events.length;
          if (!page.hasMore || page.events.length === 0 || offset >= page.total) {
            break;
          }
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        await callLocalSecurity(directory, { action: 'audit.export', query: auditQuery });
        process.stdout.write(JSON.stringify({ exported: total, output: outputPath }) + '\n');
      } catch (error) {
        if (fd !== undefined) {
          closeSync(fd);
        }
        if (created) {
          unlinkSync(outputPath);
        }
        throw error;
      }
      return;
    }
    case 'token-create':
      request = {
        action: 'credential.create',
        principalId: options.get('--principal'),
        name: options.get('--name'),
        grants: options.has('--grants-file')
          ? JSON.parse(readFileSync(resolve(options.get('--grants-file')!), 'utf8'))
          : [],
        expiresInDays: options.has('--days') ? Number(options.get('--days')) : 30,
      };
      break;
    case 'token-rotate':
      request = {
        action: 'credential.rotate',
        id: options.get('--id'),
        graceMinutes: options.has('--grace-minutes') ? Number(options.get('--grace-minutes')) : 10,
      };
      break;
    case 'token-revoke':
      request = { action: 'credential.revoke', id: options.get('--id') };
      break;
    case 'session-pair':
      request = {
        action: 'session.pair',
        credentialId: options.get('--id'),
        lifetimeMinutes: options.has('--minutes') ? Number(options.get('--minutes')) : 10,
        origin: options.get('--origin'),
      };
      break;
    case 'reset-access':
      if (!yes) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      request = { action: 'access.reset', confirm: true };
      break;
    default:
      throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const secret = action === 'token-create' || action === 'token-rotate';
  let fd: number | undefined;
  if (secret) {
    const target = options.get('--output');
    if (!target) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    new WindowsSecretProtector().ensureDirectory(dirname(resolve(target)));
    // Reserve the destination before issuing/rotating. Never overwrite an old secret.
    try {
      fd = openSync(resolve(target), 'wx', 0o600);
    } catch {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
  }
  try {
    const result = await callLocalSecurity(directory, request);
    if (fd !== undefined) {
      writeFileSync(fd, JSON.stringify(result, null, 2) + '\n');
      fsyncSync(fd);
      process.stderr.write(
        '[ModelDB] Credential delivered to protected file; it cannot be retrieved again.\n',
      );
    } else {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
