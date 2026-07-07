import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  ModelDB,
  RemoteModelDBClient,
  type ManagementBackupInfo,
  type ManagementCatalogResponse,
} from '@mode-db/sdk';
import { AppConfirmProvider, useAppConfirm } from '@mode-db/data-ui';
import { ConnectionPanel } from './components/ConnectionPanel.js';
import { DataWorkspace } from './components/DataWorkspace.js';
import { StudioToasts } from './components/StudioToasts.js';
import {
  clearActiveSession,
  getRestorableSession,
  persistActiveSession,
  touchActiveSession,
} from './config/connection-prefs.js';
import { openLibrarySession } from './config/open-library-session.js';
import { useStudio, useStudioLocale } from './context/studio-context.js';

type BootPhase = 'restoring' | 'ready';

/**
 * Data Studio — component library playground with live Engine connection.
 */
export function App(): ReactElement {
  return (
    <AppConfirmProvider defaultEyebrow="Data Studio">
      <StudioApp />
    </AppConfirmProvider>
  );
}

function StudioApp(): ReactElement {
  const clientRef = useRef<RemoteModelDBClient | null>(null);
  const [boot, setBoot] = useState<BootPhase>('restoring');
  const [client, setClient] = useState<RemoteModelDBClient | null>(null);
  const [session, setSession] = useState<{
    library: string;
    catalog: ManagementCatalogResponse;
  } | null>(null);
  const { i18n, notify } = useStudio();
  const confirm = useAppConfirm();
  useStudioLocale();
  const i18nRef = useRef(i18n);
  const notifyRef = useRef(notify);
  i18nRef.current = i18n;
  notifyRef.current = notify;

  useEffect(() => {
    let cancelled = false;

    const restore = async (): Promise<void> => {
      const stored = getRestorableSession();
      if (!stored) {
        if (!cancelled) {
          setBoot('ready');
        }
        return;
      }

      try {
        const opened = await openLibrarySession(stored);
        if (cancelled) {
          try {
            opened.client.close();
          } catch {
            /* ignore */
          }
          return;
        }
        clientRef.current = opened.client;
        setClient(opened.client);
        setSession({ library: opened.library, catalog: opened.catalog });
        persistActiveSession();
      } catch (e) {
        clearActiveSession();
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          notifyRef.current.warning(i18nRef.current.t('sessionExpired'), msg);
        }
      } finally {
        if (!cancelled) {
          setBoot('ready');
        }
      }
    };

    void restore();

    return () => {
      cancelled = true;
      try {
        clientRef.current?.close();
      } catch {
        /* ignore */
      }
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }
    const bump = (): void => {
      touchActiveSession();
    };
    window.addEventListener('click', bump);
    window.addEventListener('keydown', bump);
    return () => {
      window.removeEventListener('click', bump);
      window.removeEventListener('keydown', bump);
    };
  }, [session]);

  const handleConnected = useCallback(
    (nextClient: RemoteModelDBClient, library: string, catalog: ManagementCatalogResponse) => {
      try {
        clientRef.current?.close();
      } catch {
        /* ignore */
      }
      clientRef.current = nextClient;
      setClient(nextClient);
      setSession({ library, catalog });
      persistActiveSession();
    },
    [],
  );

  const handleDisconnect = useCallback(() => {
    try {
      clientRef.current?.close();
    } catch {
      /* ignore */
    }
    clientRef.current = null;
    setClient(null);
    setSession(null);
    clearActiveSession();
  }, []);

  const handleCatalogRefresh = useCallback(async (): Promise<ManagementCatalogResponse> => {
    if (!session) {
      throw new Error('No active library session.');
    }
    const stored = getRestorableSession();
    if (!stored) {
      throw new Error('No stored connection for catalog refresh.');
    }
    const db = new ModelDB({
      host: stored.host.trim(),
      port: stored.port,
      token: stored.token.trim(),
    });
    const [catalog, databases] = await Promise.all([
      db.getDatabaseCatalog(session.library),
      RemoteModelDBClient.listDatabases({
        host: stored.host.trim(),
        port: stored.port,
        token: stored.token.trim(),
      }),
    ]);
    const databaseInfo = databases.find((info) => info.name === session.library);
    const nextCatalog = {
      ...catalog,
      displayName: catalog.displayName ?? databaseInfo?.displayName,
    };
    setSession((prev) => (prev ? { ...prev, catalog: nextCatalog } : prev));
    persistActiveSession();
    return nextCatalog;
  }, [session]);

  const reopenCurrentSession = useCallback(async (): Promise<void> => {
    const stored = getRestorableSession();
    if (!stored) {
      throw new Error('No stored connection for management operation.');
    }
    try {
      clientRef.current?.close();
    } catch {
      /* ignore */
    }
    const opened = await openLibrarySession(stored);
    clientRef.current = opened.client;
    setClient(opened.client);
    setSession({ library: opened.library, catalog: opened.catalog });
    persistActiveSession();
  }, []);

  const requireManagementSession = useCallback(() => {
    if (!session) {
      throw new Error('No active library session.');
    }
    const stored = getRestorableSession();
    if (!stored) {
      throw new Error('No stored connection for management operation.');
    }
    return { stored, library: session.library };
  }, [session]);

  const formatBackup = useCallback((backup: ManagementBackupInfo): string => {
    return `${backup.fileName} (${new Date(backup.createdAt).toLocaleString()})`;
  }, []);

  const handleCreateBackup = useCallback(async (): Promise<void> => {
    try {
      const { stored, library } = requireManagementSession();
      const backup = await RemoteModelDBClient.createBackup({
        host: stored.host.trim(),
        port: stored.port,
        token: stored.token.trim(),
        database: library,
        reason: 'manual',
      });
      notify.success(i18n.t('backupCreateSuccess'), backup.fileName);
    } catch (e) {
      notify.error(i18n.t('backupOperationFailed'), e instanceof Error ? e.message : String(e));
    }
  }, [i18n, notify, requireManagementSession]);

  const handleRestoreBackup = useCallback(async (): Promise<void> => {
    try {
      const { stored, library } = requireManagementSession();
      const backups = await RemoteModelDBClient.listBackups({
        host: stored.host.trim(),
        port: stored.port,
        token: stored.token.trim(),
        database: library,
      });
      if (backups.length === 0) {
        notify.warning(i18n.t('backupRestore'), i18n.t('backupEmpty'));
        return;
      }
      const backupFile = globalThis
        .prompt(
          `${i18n.t('backupRestorePrompt')}\n${backups.map(formatBackup).join('\n')}`,
          backups[0]?.fileName ?? '',
        )
        ?.trim();
      if (!backupFile) {
        return;
      }
      if (
        !(await confirm({
          title: i18n.t('backupRestoreConfirm', { file: backupFile }),
          tone: 'danger',
        }))
      ) {
        return;
      }
      const result = await RemoteModelDBClient.restoreBackup({
        host: stored.host.trim(),
        port: stored.port,
        token: stored.token.trim(),
        database: library,
        backupFile,
      });
      await reopenCurrentSession();
      notify.success(i18n.t('backupRestoreSuccess'), result.restored.fileName);
    } catch (e) {
      notify.error(i18n.t('backupOperationFailed'), e instanceof Error ? e.message : String(e));
    }
  }, [confirm, formatBackup, i18n, notify, reopenCurrentSession, requireManagementSession]);

  const handleClearDatabase = useCallback(
    async (forceReset = false): Promise<void> => {
      try {
        const { stored, library } = requireManagementSession();
        const confirmKey = forceReset ? 'backupForceResetConfirm' : 'backupClearConfirm';
        if (
          !(await confirm({
            title: i18n.t(confirmKey, { db: library }),
            tone: 'danger',
          }))
        ) {
          return;
        }
        const result = await RemoteModelDBClient.clearDatabaseData({
          host: stored.host.trim(),
          port: stored.port,
          token: stored.token.trim(),
          database: library,
          forceReset,
        });
        await reopenCurrentSession();
        notify.success(
          i18n.t(forceReset ? 'backupForceResetSuccess' : 'backupClearSuccess'),
          {
            clearAllData: String(result.deletedCount ?? 0),
            forceReset: library,
          }[result.mode] ?? library,
        );
      } catch (e) {
        notify.error(i18n.t('backupOperationFailed'), e instanceof Error ? e.message : String(e));
      }
    },
    [confirm, i18n, notify, reopenCurrentSession, requireManagementSession],
  );

  if (boot === 'restoring') {
    return (
      <>
        <StudioToasts />
        <div className="studio-connect-wrap">
          <p className="studio-restore-hint">{i18n.t('restoringSession')}</p>
        </div>
      </>
    );
  }

  return (
    <>
      <StudioToasts />
      {!session || !client ? (
        <ConnectionPanel onConnected={handleConnected} />
      ) : (
        <DataWorkspace
          client={client}
          library={session.library}
          catalog={session.catalog}
          onCatalogRefresh={handleCatalogRefresh}
          onCreateBackup={handleCreateBackup}
          onRestoreBackup={handleRestoreBackup}
          onClearDatabase={() => handleClearDatabase(false)}
          onForceResetDatabase={() => handleClearDatabase(true)}
          onDisconnect={handleDisconnect}
        />
      )}
    </>
  );
}
