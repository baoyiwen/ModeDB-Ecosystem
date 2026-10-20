import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { AppDrawer, AppSelectList, useAppConfirm } from '@mode-db/data-ui';
import { RemoteModelDBClient, type ManagementBackupInfo } from '@mode-db/sdk';
import { useDesigner } from '../context/designer-context.js';
import {
  getSessionToken,
  getStoredHost,
  getStoredPort,
  getStoredToken,
} from '../config/connection-prefs.js';
import { listLibraryRegistry } from '../sync/library-registry.js';
import type { LibraryRegistryRecord } from '../types/library-registry.js';
import { FIXED_MODEL_DESIGNER_DATABASE } from '../config/fixed-database.js';
import type { AsyncOperationKey } from '../managers/async-operation-manager.js';
import {
  backupDisplayName,
  defaultBackupName,
  formatBackupBytes,
  formatBackupTime,
  groupBackups,
} from '../backup/backup-presentation.js';
import { IconDocument, IconExport, IconRestore, IconUpload } from './designer-icons.js';

export interface BackupWorkspaceProps {
  readonly onClose: () => void;
  readonly onRestored: (database: string) => Promise<void>;
}

export function BackupWorkspace({ onClose, onRestored }: BackupWorkspaceProps): ReactElement {
  const { config, i18n, asyncOps } = useDesigner();
  const confirm = useAppConfirm();
  const activeDatabase = config.activeLibraryName ?? '';
  const [, redraw] = useState(0);
  const [backups, setBackups] = useState<readonly ManagementBackupInfo[]>([]);
  const [registry, setRegistry] = useState<readonly LibraryRegistryRecord[]>([]);
  const [database, setDatabase] = useState(activeDatabase);
  const [name, setName] = useState(() => defaultBackupName(activeDatabase));
  const [search, setSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [registryWarning, setRegistryWarning] = useState(false);
  const [serverWarning, setServerWarning] = useState(false);
  const [metadataImported, setMetadataImported] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLDivElement>(null);
  const connection = useMemo(
    () => ({
      host: getStoredHost('127.0.0.1'),
      port: getStoredPort(9090),
      token: getSessionToken() ?? getStoredToken(''),
    }),
    [],
  );
  const t = (key: string, values?: Record<string, string | number>): string =>
    i18n.t(
      'ui',
      key,
      values
        ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]))
        : undefined,
    );

  useEffect(() => {
    const unsubI18n = i18n.subscribe(() => redraw((value) => value + 1));
    const unsubOps = asyncOps.subscribe(() => redraw((value) => value + 1));
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.querySelector<HTMLButtonElement>('button')?.focus();
    mounted.current = true;
    return () => {
      mounted.current = false;
      unsubI18n();
      unsubOps();
      previous?.focus();
    };
  }, [i18n, asyncOps]);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const items = await RemoteModelDBClient.listBackups(connection);
      if (!mounted.current) return;
      setBackups(items);
      try {
        const records = config.remoteClient ? await listLibraryRegistry(config.remoteClient) : [];
        if (mounted.current) {
          setRegistry(records);
          setRegistryWarning(false);
        }
      } catch {
        if (mounted.current) setRegistryWarning(true);
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [config, connection]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groups = useMemo(
    () =>
      groupBackups(
        backups.filter((item) => item.database !== FIXED_MODEL_DESIGNER_DATABASE),
        registry.filter((item) => item.code !== FIXED_MODEL_DESIGNER_DATABASE),
        i18n.locale,
        activeDatabase,
      ),
    [backups, registry, i18n.locale, activeDatabase],
  );
  const group = groups.find((item) => item.code === database);
  const visibleBackups = (group?.backups ?? []).filter((item) =>
    `${backupDisplayName(item)} ${item.fileName} ${formatBackupTime(item.createdAt)}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  const selected = visibleBackups.find((item) => item.fileName === selectedFile);
  const busy = working || asyncOps.isBusy;
  const validName =
    name.trim().length > 0 && name.trim().length <= 120 && !/[\x00-\x1f\x7f]/.test(name);

  const changeGroup = (code: string): void => {
    setDatabase(code);
    setSelectedFile(null);
    setSearch('');
    setName(defaultBackupName(code));
  };
  const run = async (
    key: AsyncOperationKey,
    detail: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    if (lock.current || asyncOps.isBusy) return;
    lock.current = true;
    setWorking(true);
    setError('');
    try {
      await asyncOps.run(key, action, { detail });
      if (mounted.current) await refresh();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      lock.current = false;
      if (mounted.current) setWorking(false);
    }
  };
  const restore = async (): Promise<void> => {
    if (!selected || busy || lock.current) return;
    lock.current = true;
    setWorking(true);
    const backup = selected;
    let approved = false;
    try {
      approved = await confirm({
        title: t('backupWorkspaceRestoreTitle', { db: group?.label ?? database }),
        message: t('backupWorkspaceRestoreHint', { name: backupDisplayName(backup) }),
        confirmLabel: t('backupRestoreAction'),
        tone: 'danger',
      });
    } finally {
      lock.current = false;
      setWorking(false);
    }
    if (!approved || !mounted.current) return;
    await run('restoreDatabase', database, async () => {
      await RemoteModelDBClient.restoreBackup({
        ...connection,
        database,
        backupFile: backup.fileName,
      });
      await onRestored(database);
    });
  };

  // Escape the canvas stacking context while retaining the designer and confirmation providers.
  return createPortal(
    <div
      ref={closeButton}
      className="designer-backup-root"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onClose();
        if (event.key === 'Tab') {
          const controls = [
            ...(closeButton.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled):not([hidden])',
            ) ?? []),
          ];
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <AppDrawer
        open
        title={t('backupManage')}
        closeLabel={t('backupWorkspaceClose')}
        labelledById="backup-workspace-title"
        className="designer-backup-workspace"
        bodyClassName="designer-backup-body"
        width="100vw"
        withScrim={false}
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        <nav className="designer-backup-groups" aria-label={t('backupWorkspaceGroups')}>
          <h3>{t('backupWorkspaceGroups')}</h3>
          <AppSelectList
            label={t('backupWorkspaceGroups')}
            value={database}
            onChange={changeGroup}
            emptyLabel={t('backupEmpty')}
            items={groups.map((item) => ({
              value: item.code,
              label: item.label,
              disabled: busy,
              description: item.code === activeDatabase ? t('backupWorkspaceCurrent') : undefined,
              meta: String(item.backups.length),
            }))}
          />
        </nav>
        <main className="designer-backup-main" aria-busy={busy || loading}>
          <header className="designer-backup-heading">
            <div>
              <h3>{group?.label ?? database}</h3>
              <span>{t('backupWorkspaceCount', { count: group?.backups.length ?? 0 })}</span>
            </div>
            <div className="designer-backup-actions">
              <button
                type="button"
                className="designer-btn"
                disabled={busy || loading}
                title={t('backupWorkspaceRefresh')}
                onClick={() => void refresh()}
              >
                <IconRestore />
                {t('backupWorkspaceRefresh')}
              </button>
              <button
                type="button"
                className="designer-btn"
                disabled={busy || loading}
                onClick={() => fileInput.current?.click()}
              >
                <IconUpload />
                {t('backupImport')}
              </button>
              <input
                ref={fileInput}
                hidden
                type="file"
                accept=".modeldb-backup.json,.json,application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  void run('importBackup', file.name, async () => {
                    const imported = await RemoteModelDBClient.importBackup({
                      ...connection,
                      fileName: file.name,
                      file,
                    });
                    setBackups((items) => [imported, ...items]);
                    setMetadataImported(imported.database === FIXED_MODEL_DESIGNER_DATABASE);
                    if (imported.database === FIXED_MODEL_DESIGNER_DATABASE) return;
                    changeGroup(imported.database);
                    setSelectedFile(imported.fileName);
                  });
                }}
              />
            </div>
          </header>
          {error ? (
            <div className="designer-backup-error" role="alert">
              {error}
            </div>
          ) : null}
          {registryWarning ? (
            <div className="designer-backup-warning" role="status">
              {t('backupWorkspaceRegistryWarning')}
            </div>
          ) : null}
          {serverWarning ? (
            <div className="designer-backup-warning" role="status">
              {t('backupWorkspaceServerUpgrade')}
            </div>
          ) : null}
          {metadataImported ? (
            <div className="designer-backup-warning" role="status">
              {t('backupWorkspaceMetadataImported')}
            </div>
          ) : null}
          <form
            className="designer-backup-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (!validName || !database || loading) return;
              void run('backupDatabase', database, async () => {
                const created = await RemoteModelDBClient.createBackup({
                  ...connection,
                  database,
                  name: name.trim(),
                  reason: 'manual',
                });
                setServerWarning(created.name !== name.trim());
                setBackups((items) => [created, ...items]);
                setSelectedFile(created.fileName);
                setSearch('');
                setName(defaultBackupName(database));
              });
            }}
          >
            <label htmlFor="backup-workspace-name">{t('backupWorkspaceName')}</label>
            <div className="designer-backup-create-fields">
              <input
                id="backup-workspace-name"
                className="designer-input"
                value={name}
                maxLength={120}
                required
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
              <button
                type="button"
                className="designer-btn designer-backup-icon"
                disabled={busy}
                title={t('backupWorkspaceDefaultName')}
                aria-label={t('backupWorkspaceDefaultName')}
                onClick={() => setName(defaultBackupName(database))}
              >
                <IconRestore />
              </button>
              <button
                type="submit"
                className="designer-btn designer-btn-primary"
                disabled={busy || loading || !validName || !database}
              >
                <IconDocument />
                {t('backupWorkspaceCreate')}
              </button>
            </div>
          </form>
          <div className="designer-backup-list-toolbar">
            <input
              type="search"
              className="designer-input"
              aria-label={t('backupWorkspaceSearch')}
              placeholder={t('backupWorkspaceSearch')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <span>
              {t('backupWorkspaceTimezone', {
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              })}
            </span>
          </div>
          <section className="designer-backup-list" aria-label={t('backupWorkspaceList')}>
            <div className="designer-backup-columns" aria-hidden="true">
              <span>{t('backupWorkspaceName')}</span>
              <span>{t('backupWorkspaceCreatedAt')}</span>
              <span>{t('backupWorkspaceSize')}</span>
            </div>
            <AppSelectList
              label={t('backupWorkspaceList')}
              value={selected?.fileName ?? null}
              onChange={setSelectedFile}
              emptyLabel={loading ? t('backupWorkspaceLoading') : t('backupWorkspaceNoResults')}
              items={visibleBackups.map((item) => ({
                value: item.fileName,
                disabled: busy,
                label: (
                  <span className="designer-backup-row">
                    <span title={backupDisplayName(item)}>{backupDisplayName(item)}</span>
                    <time dateTime={item.createdAt}>{formatBackupTime(item.createdAt)}</time>
                    <span>{formatBackupBytes(item.bytes)}</span>
                  </span>
                ),
              }))}
            />
          </section>
          <footer className="designer-backup-details">
            <div>
              <span>{t('backupWorkspaceFile')}</span>
              <code>{selected?.fileName ?? t('backupWorkspaceSelect')}</code>
            </div>
            <div className="designer-backup-actions">
              <button
                type="button"
                className="designer-btn"
                disabled={!selected || busy || loading}
                onClick={() => {
                  if (!selected) return;
                  const backup = selected;
                  void run('exportBackup', backupDisplayName(backup), async () => {
                    const blob = await RemoteModelDBClient.downloadBackup({
                      ...connection,
                      backupFile: backup.fileName,
                    });
                    const url = URL.createObjectURL(blob);
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = `${backupDisplayName(backup).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.modeldb-backup.json`;
                    document.body.appendChild(anchor);
                    anchor.click();
                    anchor.remove();
                    window.setTimeout(() => URL.revokeObjectURL(url), 0);
                  });
                }}
              >
                <IconExport />
                {t('backupExport')}
              </button>
              <button
                type="button"
                className="designer-btn designer-backup-danger"
                disabled={!selected || busy || loading}
                onClick={() => void restore()}
              >
                <IconRestore />
                {t('backupRestoreAction')}
              </button>
            </div>
          </footer>
        </main>
      </AppDrawer>
    </div>,
    document.body,
  );
}
