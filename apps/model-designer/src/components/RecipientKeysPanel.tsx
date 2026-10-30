import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  ConnectionSecurityError,
  manageRecipientKey,
  manageRegisteredIdentity,
} from '@mode-db/sdk';
import type {
  RecipientChallenge,
  RecipientKeyCommand,
  RecipientKeyPage,
  RecipientProof,
  RegisteredUserInfo,
} from '@mode-db/shared';
import { useDesigner } from '../context/designer-context.js';
import './recipient-keys.css';

type Draft<T = RecipientKeyCommand> = T extends { revision: number }
  ? Omit<T, 'instanceId' | 'revision' | 'confirm'>
  : never;

export function RecipientKeysPanel({ instanceId }: { instanceId: string }): ReactElement {
  const { i18n } = useDesigner(),
    t = (key: string) => i18n.t('ui', 'recipientKeys_' + key);
  const endpoint = { host: window.location.hostname, port: Number(window.location.port || 80) };
  const [page, setPage] = useState<RecipientKeyPage>(),
    [users, setUsers] = useState<RegisteredUserInfo[]>([]),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState<string>(),
    [success, setSuccess] = useState(false),
    [offset, setOffset] = useState(0),
    [userId, setUserId] = useState(''),
    [pem, setPem] = useState(''),
    [response, setResponse] = useState<RecipientProof>(),
    [challenge, setChallenge] = useState<RecipientChallenge>(),
    [review, setReview] = useState<RecipientKeyCommand>(),
    [confirmed, setConfirmed] = useState(false);
  const lock = useRef(false),
    alive = useRef(true),
    fileInput = useRef<HTMLInputElement>(null),
    reviewRef = useRef<HTMLElement>(null);
  const classify = (error: unknown) =>
    error instanceof ConnectionSecurityError && error.code === 'SECURITY_POLICY_CONFLICT'
      ? 'conflict'
      : 'failed';
  const load = async (position = offset) => {
    if (lock.current) {
      return;
    }
    lock.current = true;
    setBusy(true);
    setIssue(undefined);
    setReview(undefined);
    setConfirmed(false);
    try {
      const list = await manageRegisteredIdentity(endpoint, {
        action: 'registration.users.list',
        instanceId,
        limit: 100,
      });
      const next = await manageRecipientKey(endpoint, {
        action: 'registration.recipient.list',
        instanceId,
        offset: position,
        limit: 10,
      });
      if (alive.current) {
        setUsers(list.users);
        setPage(next);
        setOffset(position);
      }
    } catch (error) {
      if (alive.current) {
        setIssue(classify(error));
        setPage(undefined);
      }
    } finally {
      lock.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    void load(0);
    return () => {
      alive.current = false;
    };
  }, [instanceId]);
  useEffect(() => {
    if (review) {
      reviewRef.current?.focus();
    }
  }, [review]);
  const mutation = (command: Draft) => {
    if (!page || busy) {
      return;
    }
    setReview({
      ...command,
      instanceId,
      revision: page.revision,
      confirm: true,
    } as RecipientKeyCommand);
    setConfirmed(false);
    setIssue(undefined);
    setSuccess(false);
  };
  const submit = async () => {
    if (!review || !confirmed || lock.current) {
      return;
    }
    lock.current = true;
    setBusy(true);
    setIssue(undefined);
    setSuccess(false);
    try {
      const result = await manageRecipientKey(endpoint, review);
      if (alive.current) {
        if ('challenge' in result) {
          setChallenge(result.challenge);
        }
        setPage((old) => (old ? { ...old, revision: result.revision } : old));
        setSuccess(true);
        setReview(undefined);
        setResponse(undefined);
        setConfirmed(false);
        setPem('');
      }
    } catch (error) {
      if (alive.current) {
        setIssue(classify(error));
        setReview(undefined);
        setPage(undefined);
      }
    } finally {
      lock.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  };
  const importFile = async (file: File | undefined, kind: 'public' | 'proof') => {
    setReview(undefined);
    setConfirmed(false);
    setIssue(undefined);
    if (kind === 'public') {
      setPem('');
    }
    try {
      if (!file || file.size > (kind === 'public' ? 2048 : 1024)) {
        throw Error();
      }
      const text = await file.text();
      if (!alive.current) {
        return;
      }
      if (kind === 'public') {
        if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(text)) {
          throw Error();
        }
        setPem(text);
      } else {
        const p = JSON.parse(text) as RecipientProof;
        if (
          !p ||
          Object.keys(p).sort().join(',') !== 'challengeId,format,instanceId,proof' ||
          p.format !== 'modeldb.recipient-proof.v1' ||
          p.instanceId !== instanceId ||
          !/^[a-f0-9]{64}$/.test(p.proof) ||
          !challenge ||
          p.challengeId !== challenge.challengeId
        ) {
          throw Error();
        }
        setResponse(p);
      }
    } catch {
      if (alive.current) {
        setIssue('invalid');
        setResponse(undefined);
      }
    }
  };
  const download = () => {
    if (!challenge) {
      return;
    }
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(challenge, null, 2) + '\n'], { type: 'application/json' }),
      ),
      link = document.createElement('a');
    link.href = url;
    link.download = 'recipient-challenge.json';
    link.click();
    URL.revokeObjectURL(url);
  };
  const verb = (action: string) => t(action.split('.').at(-1)!);
  const reviewKey =
    review?.action === 'registration.recipient.complete'
      ? challenge
      : review?.action === 'registration.recipient.retire'
        ? page?.keys.find((k) => k.id === review.id)
        : undefined;
  return (
    <section className="recipient-keys" aria-busy={busy}>
      <header>
        <div>
          <h2>{t('title')}</h2>
          <p>{t('intro')}</p>
        </div>
        <button
          type="button"
          className="designer-btn"
          data-recipient-reload
          disabled={busy}
          onClick={() => void load()}
        >
          {t('reload')}
        </button>
      </header>
      <p className="recipient-keys-note">{t('boundary')}</p>
      {busy ? <p role="status">{t('loading')}</p> : null}
      {issue ? (
        <p role="alert" data-recipient-issue={issue}>
          {t(issue)}
        </p>
      ) : null}
      {success ? (
        <p role="status" data-recipient-success>
          {t('success')}
        </p>
      ) : null}
      {page && !page.initialized ? (
        <div className="recipient-keys-card">
          <h3>{t('setup')}</h3>
          <p>{t('setupHint')}</p>
          <button
            type="button"
            className="designer-btn"
            data-recipient-initialize
            disabled={busy}
            onClick={() => mutation({ action: 'registration.recipient.initialize' })}
          >
            {t('initialize')}
          </button>
        </div>
      ) : null}
      {page?.initialized ? (
        <>
          <form
            className="recipient-keys-card"
            onSubmit={(e) => {
              e.preventDefault();
              if (userId && pem) {
                mutation({ action: 'registration.recipient.begin', userId, publicKey: pem });
              }
            }}
          >
            <h3>{t('begin')}</h3>
            <p>{t('beginHint')}</p>
            <label>
              {t('user')}
              <select
                data-recipient-user
                value={userId}
                required
                disabled={busy}
                onChange={(e) => {
                  setUserId(e.target.value);
                  setReview(undefined);
                  setChallenge(undefined);
                  setResponse(undefined);
                }}
              >
                <option value="">{t('choose')}</option>
                {users
                  .filter((u) => u.enabled)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName} · {u.id}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {t('publicKey')}
              <input
                data-recipient-public
                ref={fileInput}
                type="file"
                accept=".pem"
                disabled={busy}
                onChange={(e) => {
                  void importFile(e.target.files?.[0], 'public');
                  e.target.value = '';
                }}
              />
            </label>
            {pem ? <p data-recipient-public-ready>{t('publicReady')}</p> : null}
            <button
              type="submit"
              className="designer-btn"
              data-recipient-begin
              disabled={busy || !userId || !pem}
            >
              {t('begin')}
            </button>
          </form>
          {challenge ? (
            <div className="recipient-keys-card">
              <h3>{t('challenge')}</h3>
              <dl>
                <dt>{t('user')}</dt>
                <dd>
                  <code>{challenge.userId}</code>
                </dd>
                <dt>{t('fingerprint')}</dt>
                <dd>
                  <code>{challenge.fingerprint}</code>
                </dd>
                <dt>{t('version')}</dt>
                <dd>{challenge.keyVersion.toLocaleString(i18n.locale)}</dd>
                <dt>{t('expires')}</dt>
                <dd>{new Date(challenge.expiresAtUtc).toLocaleString(i18n.locale)}</dd>
              </dl>
              <button
                type="button"
                className="designer-btn"
                data-recipient-download
                onClick={download}
              >
                {t('download')}
              </button>
              <p>{t('offline')}</p>
            </div>
          ) : null}
          <div className="recipient-keys-card">
            <h3>{t('complete')}</h3>
            <label>
              {t('proofFile')}
              <input
                data-recipient-proof
                type="file"
                accept=".json"
                disabled={busy}
                onChange={(e) => {
                  void importFile(e.target.files?.[0], 'proof');
                  e.target.value = '';
                }}
              />
            </label>
            {response ? <p>{t('proofReady')}</p> : null}
            <button
              type="button"
              className="designer-btn"
              data-recipient-complete
              disabled={busy || !response}
              onClick={() => {
                if (response) {
                  mutation({ action: 'registration.recipient.complete', response });
                }
              }}
            >
              {t('complete')}
            </button>
          </div>
          <div className="recipient-keys-list">
            <h3>{t('history')}</h3>
            {!page.keys.length ? (
              <p>{t('empty')}</p>
            ) : (
              page.keys.map((k) => (
                <article className="recipient-keys-card" data-recipient-key={k.id} key={k.id}>
                  <h4>
                    {t('version')} {k.keyVersion.toLocaleString(i18n.locale)} · {t(k.state)}
                  </h4>
                  <dl>
                    <dt>{t('user')}</dt>
                    <dd>
                      <code>{k.userId}</code>
                    </dd>
                    <dt>{t('fingerprint')}</dt>
                    <dd>
                      <code>{k.fingerprint}</code>
                    </dd>
                    <dt>{t('created')}</dt>
                    <dd>{new Date(k.createdAtUtc).toLocaleString(i18n.locale)}</dd>
                  </dl>
                  {k.state === 'active' ? (
                    <button
                      type="button"
                      className="designer-btn"
                      data-recipient-retire
                      disabled={busy}
                      onClick={() =>
                        mutation({ action: 'registration.recipient.retire', id: k.id })
                      }
                    >
                      {t('retire')}
                    </button>
                  ) : null}
                </article>
              ))
            )}
          </div>
          <nav aria-label={t('pages')}>
            <button
              type="button"
              className="designer-btn"
              disabled={busy || offset === 0}
              onClick={() => void load(Math.max(0, offset - 10))}
            >
              {t('previous')}
            </button>
            <span>
              {page.total.toLocaleString(i18n.locale)} {t('records')}
            </span>
            <button
              type="button"
              className="designer-btn"
              disabled={busy || page.nextOffset === null}
              onClick={() => void load(page.nextOffset!)}
            >
              {t('next')}
            </button>
          </nav>
        </>
      ) : null}
      {review ? (
        <section
          className="recipient-keys-card recipient-keys-review"
          tabIndex={-1}
          ref={reviewRef}
          data-recipient-review
        >
          <h3>
            {t('review')} · {verb(review.action)}
          </h3>
          <p>{t('reviewHint')}</p>
          {'userId' in review ? (
            <p>
              <code>{review.userId}</code>
            </p>
          ) : null}
          {reviewKey ? (
            <dl>
              <dt>{t('user')}</dt>
              <dd>
                <code>{reviewKey.userId}</code>
              </dd>
              <dt>{t('fingerprint')}</dt>
              <dd>
                <code>{reviewKey.fingerprint}</code>
              </dd>
              <dt>{t('version')}</dt>
              <dd>{reviewKey.keyVersion.toLocaleString(i18n.locale)}</dd>
            </dl>
          ) : null}
          <label>
            <input
              type="checkbox"
              data-recipient-confirm
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t('confirm')}
          </label>
          <div>
            <button
              type="button"
              className="designer-btn"
              disabled={busy}
              onClick={() => setReview(undefined)}
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              className="designer-btn"
              data-recipient-submit
              disabled={busy || !confirmed}
              onClick={() => void submit()}
            >
              {t('submit')}
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
