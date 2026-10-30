import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  ConnectionSecurityError,
  manageRegisteredIdentity,
  type RegisteredIdentityCommand,
  type RegisteredApplicationInfo,
  type RegisteredCredentialInfo,
  type RegisteredUserInfo,
  type SecurityCenterSession,
} from '@mode-db/sdk';
import type { SecurityGrant, SecurityAction } from '@mode-db/shared';
import { useDesigner } from '../context/designer-context.js';

type Tab = 'applications' | 'users' | 'credentials' | 'sessions';
type Entry =
  | RegisteredApplicationInfo
  | RegisteredCredentialInfo
  | RegisteredUserInfo
  | SecurityCenterSession;
const actions: SecurityAction[] = [
  'model.read',
  'model.write',
  'schema.manage',
  'database.manage',
  'callable.query',
  'callable.operation',
  'callable.binding',
  'transfer.import',
  'transfer.export',
  'backup.manage',
];
const tabs: Tab[] = ['applications', 'users', 'credentials', 'sessions'];
const commandFor = {
  applications: 'registration.list',
  users: 'registration.users.list',
  credentials: 'registration.credentials.list',
  sessions: 'registration.sessions.list',
} as const;
const emptyGrant = (): SecurityGrant => ({ database: '', resource: '', actions: [] });

/** Review snapshots are discarded on conflict; mutation requests are never retried automatically. */
export function RegisteredIdentityPanel({
  instanceId,
  refreshKey = 0,
}: {
  instanceId: string;
  refreshKey?: number;
}): ReactElement {
  const { i18n } = useDesigner(),
    t = (key: string) => i18n.t('ui', 'identityAdmin_' + key);
  const [tab, setTab] = useState<Tab>('applications'),
    [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{
    revision: number;
    total: number;
    nextOffset: number | null;
    entries: Entry[];
  }>();
  const [applications, setApplications] = useState<RegisteredApplicationInfo[]>([]);
  const [selected, setSelected] = useState<Entry>(),
    [operation, setOperation] = useState<string>();
  const [grants, setGrants] = useState<SecurityGrant[]>([]),
    [name, setName] = useState(''),
    [principal, setPrincipal] = useState(''),
    [replacement, setReplacement] = useState('');
  const [review, setReview] = useState<RegisteredIdentityCommand>(),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState<string>(),
    [success, setSuccess] = useState(false),
    [reload, setReload] = useState(0),
    [stale, setStale] = useState(false);
  const locked = useRef(false),
    generation = useRef(0),
    reviewRef = useRef<HTMLElement>(null);
  // This component is mounted only on the hosted management page. Always anchor to its origin.
  const endpoint = { host: window.location.origin, port: Number(window.location.port) || 80 };
  const clear = () => {
    setSelected(undefined);
    setOperation(undefined);
    setReview(undefined);
    setConfirmed(false);
  };
  useEffect(() => {
    const current = ++generation.current;
    clear();
    setBusy(true);
    setIssue(undefined);
    setPage(undefined);
    setStale(false);
    setSuccess(false);
    void (async () => {
      try {
        // Lists audit their reads. Fetch candidate metadata first, then use the active page's CAS.
        if (tab === 'credentials') {
          const candidates = await manageRegisteredIdentity(endpoint, {
            action: 'registration.list',
            instanceId,
            offset: 0,
            limit: 100,
          });
          if (current !== generation.current) return;
          setApplications(
            candidates.applications.filter((a) => a.state === 'pending' && a.proofVerified),
          );
        }
        const result = await manageRegisteredIdentity(endpoint, {
          action: commandFor[tab],
          instanceId,
          offset,
          limit: 10,
        });
        if (current !== generation.current) return;
        const entries =
          'applications' in result
            ? result.applications
            : 'users' in result
              ? result.users
              : 'credentials' in result
                ? result.credentials
                : result.sessions;
        setPage({ ...result, entries });
      } catch (error) {
        if (current === generation.current)
          setIssue(
            error instanceof ConnectionSecurityError && error.code === 'SECURITY_POLICY_CONFLICT'
              ? 'conflict'
              : 'failed',
          );
      } finally {
        if (current === generation.current) setBusy(false);
      }
    })();
    return () => {
      generation.current++;
    };
    // The endpoint is fixed to this origin and is deliberately not a saved connection preference.
  }, [tab, offset, reload, instanceId, refreshKey]);
  useEffect(() => {
    if (review) reviewRef.current?.focus();
  }, [review]);
  const date = (v: string) => new Date(v).toLocaleString(i18n.locale);
  const pick = (entry: Entry, action: string) => {
    setSelected(entry);
    setOperation(action);
    setReview(undefined);
    setConfirmed(false);
    setIssue(undefined);
    setSuccess(false);
    setGrants('grants' in entry ? structuredClone(entry.grants ?? []) : []);
    setName('');
    setPrincipal('');
    setReplacement('');
  };
  const preview = () => {
    if (!selected || !page || !operation) return;
    const base = {
      action: operation,
      instanceId,
      id: selected.id,
      revision: page.revision,
      confirm: true as const,
    };
    if (operation === 'registration.approve' && !name.trim() && !principal.trim()) {
      setIssue('invalid');
      return;
    }
    if (grants.some((g) => !g.database.trim() || !g.resource.trim() || !g.actions.length)) {
      setIssue('invalid');
      return;
    }
    if (operation === 'registration.credential.replace' && !replacement) {
      setIssue('invalid');
      return;
    }
    const next = {
      ...base,
      ...(operation === 'registration.approve'
        ? principal.trim()
          ? { principalId: principal.trim() }
          : { name: name.trim() }
        : {}),
      ...([
        'registration.approve',
        'registration.credential.restrict',
        'registration.credential.replace',
      ].includes(operation)
        ? { grants: structuredClone(grants) }
        : {}),
      ...(operation === 'registration.credential.replace' ? { applicationId: replacement } : {}),
    } as RegisteredIdentityCommand;
    setReview(next);
    setConfirmed(false);
    setIssue(undefined);
  };
  const submit = async () => {
    if (!review || !confirmed || locked.current || stale) return;
    locked.current = true;
    setBusy(true);
    setIssue(undefined);
    const current = generation.current;
    try {
      await manageRegisteredIdentity(endpoint, review);
      if (current !== generation.current) return;
      clear();
      setSuccess(true);
      setStale(true);
    } catch (error) {
      if (current !== generation.current) return;
      clear();
      setStale(true);
      setIssue(
        error instanceof ConnectionSecurityError && error.code === 'SECURITY_POLICY_CONFLICT'
          ? 'conflict'
          : 'failed',
      );
    } finally {
      locked.current = false;
      if (current === generation.current) setBusy(false);
    }
  };
  const button = (entry: Entry, action: string, label: string, disabled = false) => (
    <button
      type="button"
      className="designer-btn"
      data-admin-action={action}
      disabled={busy || stale || disabled}
      onClick={() => pick(entry, action)}
    >
      {t(label)}
    </button>
  );
  const metadata = (entry: Entry) => (
    <dl className="identity-admin-metadata">
      <dt>{t('id')}</dt>
      <dd>
        <code>{entry.id}</code>
      </dd>
      {'displayName' in entry ? (
        <>
          <dt>{t('name')}</dt>
          <dd>{entry.displayName}</dd>
        </>
      ) : null}
      {'principalId' in entry ? (
        <>
          <dt>{t('principal')}</dt>
          <dd>
            <code>{entry.principalId}</code>
          </dd>
        </>
      ) : null}
      {'userId' in entry ? (
        <>
          <dt>{t('user')}</dt>
          <dd>
            <code>{entry.userId}</code>
          </dd>
        </>
      ) : null}
      {'serverOrigin' in entry ? (
        <>
          <dt>Origin / RP ID</dt>
          <dd>
            {entry.serverOrigin}
            <br />
            {entry.rpId}
          </dd>
          <dt>{t('proof')}</dt>
          <dd>{t(entry.proofVerified ? 'yes' : 'no')}</dd>
          <dt>{t('expires')}</dt>
          <dd>{date(entry.expiresAtUtc)}</dd>
        </>
      ) : null}
      {'publicKeyFingerprint' in entry ? (
        <>
          <dt>{t('fingerprint')}</dt>
          <dd>
            <code>{entry.publicKeyFingerprint ?? '—'}</code>
          </dd>
          <dt>{t('authenticator')}</dt>
          <dd>
            {entry.algorithm} / {entry.deviceType ?? '—'} / {t('backedUp')}:{' '}
            {t(entry.backedUp ? 'yes' : 'no')}
          </dd>
        </>
      ) : null}
      {'credentialCount' in entry ? (
        <>
          <dt>{t('count')}</dt>
          <dd>{entry.credentialCount.toLocaleString(i18n.locale)}</dd>
        </>
      ) : null}
      {'origin' in entry ? (
        <>
          <dt>Origin</dt>
          <dd>{entry.origin}</dd>
        </>
      ) : null}
      {'parent' in entry ? (
        <>
          <dt>{t('parent')}</dt>
          <dd>{entry.parent?.kind ?? '—'}</dd>
          <dt>{t('credential')}</dt>
          <dd>
            <code>{entry.credentialId}</code>
          </dd>
        </>
      ) : null}
      <dt>{t('created')}</dt>
      <dd>{date('createdAtUtc' in entry ? entry.createdAtUtc : entry.createdAt)}</dd>
      {'expiresAt' in entry ? (
        <>
          <dt>{t('expires')}</dt>
          <dd>{date(entry.expiresAt)}</dd>
        </>
      ) : null}
      {'grants' in entry ? (
        <>
          <dt>{t('grants')}</dt>
          <dd>
            <pre>{JSON.stringify(entry.grants, null, 2)}</pre>
          </dd>
        </>
      ) : null}
    </dl>
  );
  const scopeEditor = () => (
    <fieldset className="identity-admin-scopes">
      <legend>{t('grants')}</legend>
      <p>{t('grantHint')}</p>
      {grants.map((grant, index) => {
        const update = (next: SecurityGrant) => {
          setGrants(grants.map((g, i) => (i === index ? next : g)));
          setReview(undefined);
        };
        return (
          <div className="identity-admin-scope" key={index}>
            <label>
              {t('database')}
              <input
                value={grant.database}
                maxLength={96}
                onChange={(e) => update({ ...grant, database: e.target.value })}
              />
            </label>
            <label>
              {t('resource')}
              <input
                value={grant.resource}
                maxLength={240}
                onChange={(e) => update({ ...grant, resource: e.target.value })}
              />
            </label>
            <label>
              {t('release')}
              <input
                value={grant.releaseDigest ?? ''}
                maxLength={64}
                onChange={(e) => {
                  const next = { ...grant };
                  if (e.target.value) next.releaseDigest = e.target.value;
                  else delete next.releaseDigest;
                  update(next);
                }}
              />
            </label>
            <div className="identity-admin-actions">
              {actions.map((action) => (
                <label key={action}>
                  <input
                    type="checkbox"
                    checked={grant.actions.includes(action)}
                    onChange={(e) =>
                      update({
                        ...grant,
                        actions: e.target.checked
                          ? [...grant.actions, action]
                          : grant.actions.filter((a) => a !== action),
                      })
                    }
                  />
                  {action}
                </label>
              ))}
            </div>
            <button
              type="button"
              className="designer-btn"
              onClick={() => setGrants(grants.filter((_, i) => i !== index))}
            >
              {t('remove')}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="designer-btn"
        onClick={() => setGrants([...grants, emptyGrant()])}
      >
        {t('addGrant')}
      </button>
    </fieldset>
  );
  return (
    <section className="identity-admin" aria-busy={busy}>
      <p className="security-center-note">{t('boundary')}</p>
      <nav className="identity-admin-tabs" aria-label={t('title')}>
        {tabs.map((value) => (
          <button
            type="button"
            className="designer-btn"
            key={value}
            data-admin-tab={value}
            aria-pressed={value === tab}
            disabled={busy}
            onClick={() => {
              clear();
              setOffset(0);
              setTab(value);
            }}
          >
            {t(value)}
          </button>
        ))}
      </nav>
      <div className="identity-admin-toolbar">
        <span>
          {t('total')}: {page?.total.toLocaleString(i18n.locale) ?? '—'}
        </span>
        <button
          type="button"
          className="designer-btn"
          data-admin-reload
          disabled={busy}
          onClick={() => setReload((v) => v + 1)}
        >
          {t('reload')}
        </button>
      </div>
      {issue ? (
        <p role="alert" className="identity-admin-alert" data-admin-issue={issue}>
          {t(issue)}
        </p>
      ) : null}
      {success ? (
        <p role="status" data-admin-success>
          {t('success')}
        </p>
      ) : null}
      {busy ? <p role="status">{t('loading')}</p> : null}
      {!busy && page && !page.entries.length ? (
        <p className="security-center-empty">{t('empty')}</p>
      ) : null}
      <div className="identity-admin-list">
        {page?.entries.map((entry) => (
          <article className="identity-admin-card" key={entry.id} data-admin-entry={entry.id}>
            <header>
              <strong>{'displayName' in entry ? entry.displayName : entry.id}</strong>
              <span className="security-center-badge">
                {t(
                  'state_' +
                    ('state' in entry
                      ? entry.state
                      : 'enabled' in entry
                        ? entry.enabled
                          ? 'active'
                          : 'disabled'
                        : entry.active
                          ? 'active'
                          : 'revoked'),
                )}
              </span>
            </header>
            <details>
              <summary>{t('details')}</summary>
              {metadata(entry)}
            </details>
            <div className="identity-admin-buttons">
              {tab === 'applications' && 'proofVerified' in entry && entry.state === 'pending' ? (
                <>
                  {button(entry, 'registration.approve', 'approve', !entry.proofVerified)}
                  {button(entry, 'registration.reject', 'reject')}
                </>
              ) : null}
              {tab === 'users' && 'enabled' in entry
                ? button(
                    entry,
                    entry.enabled ? 'registration.user.disable' : 'registration.user.enable',
                    entry.enabled ? 'disableUser' : 'enableUser',
                  )
                : null}
              {tab === 'credentials' &&
              'grants' in entry &&
              'userEnabled' in entry &&
              entry.state !== 'revoked' ? (
                <>
                  {button(
                    entry,
                    entry.state === 'active'
                      ? 'registration.credential.disable'
                      : 'registration.credential.enable',
                    entry.state === 'active' ? 'disable' : 'enable',
                  )}
                  {button(entry, 'registration.credential.restrict', 'restrict')}
                  {button(entry, 'registration.credential.replace', 'replace')}
                  {button(entry, 'registration.credential.revoke', 'revoke')}
                </>
              ) : null}
              {tab === 'sessions' && 'active' in entry && entry.active
                ? button(entry, 'registration.session.revoke', 'revokeSession')
                : null}
            </div>
          </article>
        ))}
      </div>
      {page ? (
        <div className="identity-admin-buttons">
          <button
            type="button"
            className="designer-btn"
            data-admin-previous
            disabled={busy || offset === 0}
            onClick={() => {
              clear();
              setOffset(Math.max(0, offset - 10));
            }}
          >
            {t('previous')}
          </button>
          <span>
            {(offset + 1).toLocaleString(i18n.locale)}–
            {(offset + page.entries.length).toLocaleString(i18n.locale)}
          </span>
          <button
            type="button"
            className="designer-btn"
            data-admin-next
            disabled={busy || page.nextOffset === null}
            onClick={() => {
              clear();
              setOffset(page.nextOffset!);
            }}
          >
            {t('next')}
          </button>
        </div>
      ) : null}
      {selected && operation && !stale ? (
        <section className="identity-admin-editor" aria-label={t('edit')}>
          <fieldset disabled={busy || !!review}>
            <h2>{t('edit')}</h2>
            <code>{operation}</code>
            {metadata(selected)}
            {operation === 'registration.approve' ? (
              <>
                <p>{t('principalHint')}</p>
                <label>
                  {t('newName')}
                  <input
                    data-admin-name
                    maxLength={80}
                    value={name}
                    disabled={!!principal}
                    onChange={(e) => {
                      setName(e.target.value);
                      setReview(undefined);
                    }}
                  />
                </label>
                <label>
                  {t('existingPrincipal')}
                  <input
                    maxLength={96}
                    value={principal}
                    disabled={!!name}
                    onChange={(e) => {
                      setPrincipal(e.target.value);
                      setReview(undefined);
                    }}
                  />
                </label>
              </>
            ) : null}
            {operation === 'registration.credential.replace' ? (
              <label>
                {t('replacement')}
                <select
                  value={replacement}
                  onChange={(e) => {
                    setReplacement(e.target.value);
                    setReview(undefined);
                  }}
                >
                  <option value="">{t('choose')}</option>
                  {applications.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName} · {a.id}
                    </option>
                  ))}
                </select>
                <p>{t('replacementHint')}</p>
                {applications.find((a) => a.id === replacement)
                  ? metadata(applications.find((a) => a.id === replacement)!)
                  : null}
              </label>
            ) : null}
            {[
              'registration.approve',
              'registration.credential.restrict',
              'registration.credential.replace',
            ].includes(operation)
              ? scopeEditor()
              : null}
            <div className="identity-admin-buttons">
              <button
                type="button"
                className="designer-btn"
                data-admin-preview
                disabled={busy}
                onClick={preview}
              >
                {t('preview')}
              </button>
              <button type="button" className="designer-btn" onClick={clear}>
                {t('cancel')}
              </button>
            </div>
          </fieldset>
        </section>
      ) : null}
      {review ? (
        <section
          ref={reviewRef}
          tabIndex={-1}
          className="identity-admin-review"
          aria-label={t('review')}
          data-admin-review
        >
          <h2>{t('review')}</h2>
          <p>{t('reviewHint')}</p>
          <pre>{JSON.stringify(review, null, 2)}</pre>
          <label>
            <input
              data-admin-confirm
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t('confirm')}
          </label>
          <div className="identity-admin-buttons">
            <button
              type="button"
              className="designer-btn designer-btn-primary"
              data-admin-submit
              disabled={!confirmed || busy || stale}
              onClick={() => void submit()}
            >
              {t('submit')}
            </button>
            <button
              type="button"
              className="designer-btn"
              disabled={busy}
              onClick={() => {
                setReview(undefined);
                setConfirmed(false);
              }}
            >
              {t('back')}
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
