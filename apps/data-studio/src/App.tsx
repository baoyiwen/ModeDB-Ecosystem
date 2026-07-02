import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { ManagementCatalogResponse, RemoteModelDBClient } from '@mode-db/sdk';
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
  const clientRef = useRef<RemoteModelDBClient | null>(null);
  const [boot, setBoot] = useState<BootPhase>('restoring');
  const [client, setClient] = useState<RemoteModelDBClient | null>(null);
  const [session, setSession] = useState<{
    library: string;
    catalog: ManagementCatalogResponse;
  } | null>(null);
  const { i18n, notify } = useStudio();
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
          onDisconnect={handleDisconnect}
        />
      )}
    </>
  );
}
