import { useEffect, useRef, useState } from 'react';
import './browser-identity-panel.css';

/** Structural adapter: this presentation layer does not import SDK/server implementations. */
export interface IdentityPanelContext {
  readonly binding: { readonly instanceId: string };
  readonly loginEnabled: boolean;
  readonly registrationEnabled: boolean;
}
export interface IdentityPanelStatus {
  readonly state: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly registrationId: string;
  readonly expiresAtUtc: string;
}
export interface IdentityPanelRegistration {
  readonly initialStatus: IdentityPanelStatus;
  status(): Promise<IdentityPanelStatus>;
}
export interface IdentityPanelClient {
  load(): Promise<IdentityPanelContext>;
  descriptor(): Promise<unknown>;
  importDescriptor(text: string): Promise<unknown>;
  register(displayName: string): Promise<IdentityPanelRegistration>;
  login(): Promise<unknown>;
  session(): Promise<unknown>;
  logout(): Promise<unknown>;
  dispose(): void;
}
export interface BrowserIdentityPanelProps {
  createClient: () => IdentityPanelClient;
  issueFor: (error: unknown) => string;
  translate: (key: string) => string;
  locale: string;
  onContinue: () => void;
  connecting: boolean;
}
/** Public same-origin identity UI; approval and authorization always stay server-side. */
export function BrowserIdentityPanel({
  createClient,
  issueFor,
  translate: t,
  locale,
  onContinue,
  connecting,
}: BrowserIdentityPanelProps) {
  const supported =
    location.protocol === 'https:' &&
    typeof PublicKeyCredential !== 'undefined' &&
    !!navigator.credentials;
  const [context, setContext] = useState<IdentityPanelContext>();
  const [descriptor, setDescriptor] = useState<boolean>(false);
  const [status, setStatus] = useState<IdentityPanelStatus>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState('');
  const [session, setSession] = useState(false);
  const [retry, setRetry] = useState(0);
  const [registration, setRegistration] = useState<IdentityPanelRegistration>();
  const controller = useRef<AbortController | undefined>(undefined);
  const client = useRef<IdentityPanelClient | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setIssue('');
    setContext(undefined);
    const identity = createClient();
    client.current = identity;
    if (supported)
      void identity
        .load()
        .then(async (value) => {
          if (abort.signal.aborted) return;
          setContext(value);
          try {
            await identity.session();
            if (!abort.signal.aborted) setSession(true);
          } catch {
            /* No cookie is the normal initial state. */
          }
        })
        .catch((error) => {
          if (!abort.signal.aborted) setIssue(issueFor(error));
        })
        .finally(() => {
          if (!abort.signal.aborted) setBusy(false);
        });
    else setBusy(false);
    return () => {
      abort.abort();
      identity.dispose();
    };
  }, [retry, supported, createClient, issueFor]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setIssue('');
    try {
      await action();
    } catch (error) {
      if (!controller.current?.signal.aborted) setIssue(issueFor(error));
    } finally {
      if (!controller.current?.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    if (!registration || status?.state !== 'pending' || issue) return;
    let active = true;
    const timer = setTimeout(() => {
      void registration
        .status()
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch((error) => {
          if (active) setIssue(issueFor(error));
        });
    }, 5100);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [registration, status, issue]);
  const liveDescriptor = async () => {
    if (!context) throw Error('No context');
    return client.current!.descriptor();
  };
  const register = () =>
    run(async () => {
      if (!context) return;
      const result = await client.current!.register(name.trim());
      if (controller.current?.signal.aborted) return;
      setRegistration(result);
      setStatus(result.initialStatus);
    });
  const login = () =>
    run(async () => {
      if (!context) return;
      await client.current!.login();
      if (!controller.current?.signal.aborted) {
        setSession(true);
        setRegistration(undefined);
      }
    });
  const download = () =>
    run(async () => {
      const value = await liveDescriptor();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'modeldb-connection.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  return (
    <section
      className="designer-identity mdb-identity"
      lang={locale}
      aria-labelledby="identity-title"
      aria-busy={busy || connecting}
    >
      <div className="designer-identity-heading">
        <span className="designer-identity-symbol" aria-hidden="true">
          ◇
        </span>
        <div>
          <h2 id="identity-title">{t('title')}</h2>
          <p>{t('subtitle')}</p>
        </div>
      </div>
      <dl className="designer-identity-server">
        <dt>{t('server')}</dt>
        <dd>{location.origin}</dd>
        {context && (
          <>
            <dt>{t('instance')}</dt>
            <dd>{context.binding.instanceId}</dd>
          </>
        )}
      </dl>
      {!supported ? (
        <p role="status" className="designer-identity-notice">
          {t('unsupported')}
        </p>
      ) : (
        <>
          {issue && (
            <div
              role="alert"
              className="designer-identity-notice designer-identity-error"
              data-identity-issue={issue}
            >
              {t(issue)}
            </div>
          )}
          {!context && !busy && (
            <button className="designer-btn" type="button" onClick={() => setRetry((n) => n + 1)}>
              {t('retry')}
            </button>
          )}
          {busy && <p role="status">{t('working')}</p>}
          {context && (
            <>
              <div className="designer-identity-actions">
                {session ? (
                  <>
                    <p role="status" data-identity-session="ready">
                      {t('session')}
                    </p>
                    <button
                      className="designer-btn designer-btn-primary"
                      type="button"
                      disabled={busy || connecting}
                      onClick={() =>
                        void run(async () => {
                          try {
                            await client.current!.session();
                          } catch (error) {
                            setSession(false);
                            throw error;
                          }
                          onContinue();
                        })
                      }
                    >
                      {t('continue')}
                    </button>
                    <button
                      className="designer-btn"
                      type="button"
                      disabled={busy || connecting}
                      onClick={() =>
                        void run(async () => {
                          try {
                            await client.current!.logout();
                          } catch (error) {
                            if ((error as { status?: number }).status !== 401) throw error;
                          }
                          setSession(false);
                        })
                      }
                    >
                      {t('logout')}
                    </button>
                  </>
                ) : (
                  <button
                    className="designer-btn designer-btn-primary"
                    type="button"
                    data-identity-login
                    disabled={busy || !context.loginEnabled}
                    onClick={() => void login()}
                  >
                    {t('login')}
                  </button>
                )}
              </div>
              {!context.loginEnabled && (
                <p className="designer-identity-notice">{t('loginClosed')}</p>
              )}
              {status && (
                <div
                  className={'designer-identity-status is-' + status.state}
                  role="status"
                  data-identity-state={status.state}
                >
                  <strong>{t(status.state + 'Title')}</strong>
                  <p>{t(status.state)}</p>
                  <dl>
                    <dt>{t('application')}</dt>
                    <dd>{status.registrationId}</dd>
                    <dt>{t('expires')}</dt>
                    <dd>
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(status.expiresAtUtc))}
                    </dd>
                  </dl>
                  {status.state === 'pending' && <small>{t('polling')}</small>}
                  {issue && status.state === 'pending' && (
                    <button
                      type="button"
                      className="designer-btn"
                      disabled={busy}
                      onClick={() => setIssue('')}
                    >
                      {t('retry')}
                    </button>
                  )}
                  {status.state !== 'pending' && (
                    <button
                      type="button"
                      className="designer-btn"
                      onClick={() => {
                        setStatus(undefined);
                        setRegistration(undefined);
                        setIssue('');
                      }}
                    >
                      {t('dismiss')}
                    </button>
                  )}
                </div>
              )}
              {!session && status?.state !== 'pending' && (
                <details
                  className="designer-identity-details"
                  open={status?.state === 'rejected' || status?.state === 'expired'}
                >
                  <summary>{t('registerTitle')}</summary>
                  <p>{t('registerHint')}</p>
                  {context.registrationEnabled ? (
                    <>
                      <label className="designer-connection-field">
                        <span>{t('name')}</span>
                        <input
                          className="designer-input"
                          data-identity-name
                          maxLength={80}
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          disabled={busy}
                          autoComplete="nickname"
                        />
                      </label>
                      <button
                        className="designer-btn"
                        type="button"
                        data-identity-register
                        disabled={busy || !name.trim()}
                        onClick={() => void register()}
                      >
                        {t('register')}
                      </button>
                      <div className="designer-identity-file">
                        <button
                          className="designer-btn"
                          type="button"
                          disabled={busy}
                          onClick={() => void download()}
                        >
                          {t('download')}
                        </button>
                        <label className="designer-connection-field">
                          <span>{t('import')}</span>
                          <input
                            type="file"
                            accept="application/json,.json"
                            disabled={busy}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              if (!file) return;
                              void run(async () => {
                                setDescriptor(false);
                                if (file.size > 16384)
                                  throw { code: 'SECURITY_REGISTRATION_SCHEMA_INVALID' };
                                await client.current!.importDescriptor(await file.text());
                                if (!controller.current?.signal.aborted) setDescriptor(true);
                              });
                            }}
                          />
                        </label>
                      </div>
                      {descriptor && (
                        <p role="status" data-identity-imported>
                          {t('imported')}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="designer-identity-notice">{t('closed')}</p>
                  )}
                </details>
              )}
            </>
          )}
        </>
      )}
      <details className="designer-identity-details">
        <summary>{t('helpTitle')}</summary>
        <p>{t('help')}</p>
        <h3>{t('replaceTitle')}</h3>
        <p>{t('replace')}</p>
        <h3>{t('recoverTitle')}</h3>
        <p>{t('recover')}</p>
        <p>{t('transient')}</p>
      </details>
      <p className="designer-identity-footnote">{t('trust')}</p>
    </section>
  );
}
