import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  deploymentWizard,
  parseBrowserRegistrationDescriptor,
  type DeploymentDraft,
  type DeploymentPreview,
  type DeploymentWizardStatus,
} from '@mode-db/sdk';
import { useDesigner } from '../context/designer-context.js';
import '../styles/deployment-wizard.css';

const download = (name: string, value: unknown) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
/** Local management preview; the explicit offline CLI performs the one-shot commit. */
export function DeploymentWizardPanel(): ReactElement {
  const { i18n } = useDesigner(),
    t = (key: string) => i18n.t('ui', 'deployment_' + key);
  const [status, setStatus] = useState<DeploymentWizardStatus>(),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState(false);
  const [mode, setMode] = useState<'local' | 'lan'>('local'),
    [port, setPort] = useState('9090');
  const [origin, setOrigin] = useState(''),
    [rp, setRp] = useState(''),
    [pem, setPem] = useState(''),
    [certFile, setCertFile] = useState(''),
    [keyFile, setKeyFile] = useState('');
  const [tls, setTls] = useState<'public-ca' | 'owner-pinned'>('public-ca'),
    [pin, setPin] = useState(''),
    [sources, setSources] = useState(''),
    [enabled, setEnabled] = useState(false),
    [hours, setHours] = useState('24');
  const [review, setReview] = useState<DeploymentPreview>(),
    [imported, setImported] = useState(false),
    [checks, setChecks] = useState<boolean[]>([false, false, false]),
    [expired, setExpired] = useState(false);
  const alive = useRef(true),
    locked = useRef(false),
    reviewRef = useRef<HTMLElement>(null);
  const endpoint = { host: window.location.origin, port: Number(window.location.port) || 80 };
  useEffect(() => {
    alive.current = true;
    deploymentWizard(endpoint, { action: 'deployment.status' })
      .then((v) => {
        if (alive.current) setStatus(v);
      })
      .catch(() => {
        if (alive.current) setIssue(true);
      });
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!review) return;
    reviewRef.current?.focus();
    const timer = setInterval(() => setExpired(Date.now() >= Date.parse(review.expiresAtUtc)), 500);
    return () => clearInterval(timer);
  }, [review]);
  const preview = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setIssue(false);
    setImported(false);
    setChecks([false, false, false]);
    setExpired(false);
    try {
      const draft: DeploymentDraft =
        mode === 'local'
          ? { mode, port: Number(port) }
          : {
              mode,
              port: Number(port),
              serverOrigin: origin,
              rpId: rp,
              certificatePem: pem,
              certificateFile: certFile,
              privateKeyFile: keyFile,
              tlsMode: tls,
              ...(tls === 'owner-pinned' ? { spkiSha256: pin } : {}),
              allowedSources: sources
                .split(/\r?\n/)
                .map((v) => v.trim())
                .filter(Boolean),
              registrationEnabled: enabled,
              windowHours: Number(hours),
            };
      const result = await deploymentWizard(endpoint, { action: 'deployment.preview', draft });
      if (alive.current) setReview(result);
    } catch {
      if (alive.current) {
        setIssue(true);
        setReview(undefined);
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const readFile = async (file: File | undefined, descriptor = false) => {
    if (!file || locked.current) return;
    locked.current = true;
    setBusy(true);
    setIssue(false);
    try {
      if (file.size > 16384) throw Error();
      const text = await file.text();
      if (!alive.current) return;
      if (descriptor) {
        if (!review?.descriptor || expired) throw Error();
        parseBrowserRegistrationDescriptor(text, review.descriptor);
        setImported(true);
      } else {
        if (text.includes('PRIVATE KEY') || !text.startsWith('-----BEGIN CERTIFICATE-----'))
          throw Error();
        setPem(text);
      }
    } catch {
      if (alive.current) {
        setIssue(true);
        setImported(false);
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const canExport = !!review && !expired && !busy && checks.every(Boolean);
  return (
    <section className="deployment-wizard" aria-busy={busy}>
      <header className="security-center-card">
        <h2>{t('title')}</h2>
        <p>{t('intro')}</p>
      </header>
      {issue && (
        <p role="alert" data-deployment-error className="identity-admin-issue">
          {t('error')}
        </p>
      )}
      {!status && !issue && <p role="status">{t('loading')}</p>}
      {status && !status.eligible && (
        <article className="security-center-card" data-deployment-existing>
          <h3>{t('existingTitle')}</h3>
          <p>{t('existing')}</p>
          <ol>
            <li>{t('existingBackup')}</li>
            <li>{t('existingMerge')}</li>
            <li>{t('existingRules')}</li>
          </ol>
        </article>
      )}
      {status?.eligible && !review && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void preview();
          }}
        >
          <fieldset disabled={busy} className="security-center-card deployment-fields">
            <legend>{t('step1')}</legend>
            <label>
              {t('mode')}
              <select
                data-deployment-mode
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value as 'local' | 'lan');
                  setIssue(false);
                }}
              >
                <option value="local">{t('local')}</option>
                <option value="lan">{t('lan')}</option>
              </select>
            </label>
            <label>
              {t('port')}
              <input
                data-deployment-port
                type="number"
                min="1"
                max="65535"
                required
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
            {mode === 'local' ? (
              <p className="deployment-note">{t('localHint')}</p>
            ) : (
              <>
                <p className="deployment-note">{t('lanHint')}</p>
                <label>
                  {t('origin')}
                  <input
                    data-deployment-origin
                    type="url"
                    required
                    value={origin}
                    onChange={(e) => setOrigin(e.target.value)}
                    placeholder="https://modeldb.example.com:9090"
                  />
                </label>
                <label>
                  {t('rp')}
                  <input
                    data-deployment-rp
                    required
                    value={rp}
                    onChange={(e) => setRp(e.target.value)}
                    placeholder="modeldb.example.com"
                  />
                </label>
                <label>
                  {t('certificate')}
                  <input
                    data-deployment-pem
                    type="file"
                    accept=".pem,.crt"
                    onChange={(e) => {
                      void readFile(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
                <p className="deployment-note" role="status">
                  {pem ? t('certificateLoaded') : t('publicOnly')}
                </p>
                <label>
                  {t('certFile')}
                  <input
                    data-deployment-cert
                    required
                    value={certFile}
                    onChange={(e) => setCertFile(e.target.value)}
                  />
                </label>
                <label>
                  {t('keyFile')}
                  <input
                    data-deployment-key
                    required
                    value={keyFile}
                    onChange={(e) => setKeyFile(e.target.value)}
                  />
                </label>
                <label>
                  {t('tls')}
                  <select
                    data-deployment-tls
                    value={tls}
                    onChange={(e) => setTls(e.target.value as typeof tls)}
                  >
                    <option value="public-ca">{t('publicCa')}</option>
                    <option value="owner-pinned">{t('pinned')}</option>
                  </select>
                </label>
                {tls === 'owner-pinned' && (
                  <label>
                    {t('pin')}
                    <input
                      data-deployment-pin
                      required
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                    />
                  </label>
                )}
                <label>
                  {t('sources')}
                  <textarea
                    data-deployment-sources
                    required
                    rows={3}
                    value={sources}
                    onChange={(e) => setSources(e.target.value)}
                    placeholder="192.168.10.0/24"
                  />
                </label>
                <p className="deployment-note">{t('networkHint')}</p>
                <label className="deployment-check">
                  <input
                    data-deployment-enable
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                  {t('enable')}
                </label>
                <label>
                  {t('hours')}
                  <input
                    data-deployment-hours
                    type="number"
                    min="1"
                    max="168"
                    required
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                  />
                </label>
                <p className="deployment-note">{t('windowHint')}</p>
              </>
            )}
            <button
              type="submit"
              className="designer-btn designer-btn-primary"
              data-deployment-preview
            >
              {t('preview')}
            </button>
          </fieldset>
        </form>
      )}
      {review && (
        <section
          className="security-center-card deployment-review"
          tabIndex={-1}
          ref={reviewRef}
          data-deployment-review
        >
          <h3>{t('step2')}</h3>
          <p className="deployment-note">{t('candidate')}</p>
          <dl className="security-center-facts">
            <div>
              <dt>{t('instance')}</dt>
              <dd>
                <code>{review.plan.instanceId}</code>
              </dd>
            </div>
            <div>
              <dt>{t('digest')}</dt>
              <dd>
                <code data-deployment-digest>{review.digest}</code>
              </dd>
            </div>
            <div>
              <dt>{t('expires')}</dt>
              <dd>{new Date(review.expiresAtUtc).toLocaleString(i18n.locale)}</dd>
            </div>
            {review.certificate && (
              <>
                <div>
                  <dt>{t('pin')}</dt>
                  <dd>
                    <code>{review.certificate.spkiSha256}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t('validTo')}</dt>
                  <dd>{new Date(review.certificate.validToUtc).toLocaleString(i18n.locale)}</dd>
                </div>
              </>
            )}
          </dl>
          <details>
            <summary>{t('config')}</summary>
            <pre>{JSON.stringify(review.config, null, 2)}</pre>
          </details>
          {expired && (
            <p role="alert" data-deployment-expired>
              {t('expired')}
            </p>
          )}
          {review.descriptor && (
            <div className="deployment-descriptor">
              <h4>{t('descriptor')}</h4>
              <p>{t('descriptorHint')}</p>
              <label>
                {t('import')}
                <input
                  data-deployment-import
                  type="file"
                  accept="application/json,.json"
                  disabled={busy || expired}
                  onChange={(e) => {
                    void readFile(e.target.files?.[0], true);
                    e.target.value = '';
                  }}
                />
              </label>
              {imported && (
                <p role="status" data-deployment-imported>
                  {t('imported')}
                </p>
              )}
            </div>
          )}
          <fieldset disabled={busy || expired} className="deployment-confirm">
            <legend>{t('step3')}</legend>
            {['confirmNetwork', 'confirmTrust', 'confirmOffline'].map((key, index) => (
              <label key={key} className="deployment-check">
                <input
                  type="checkbox"
                  data-deployment-check={index}
                  checked={checks[index]}
                  onChange={(e) =>
                    setChecks((v) => v.map((value, i) => (i === index ? e.target.checked : value)))
                  }
                />
                {t(key)}
              </label>
            ))}
          </fieldset>
          <div className="security-center-actions">
            <button
              className="designer-btn designer-btn-primary"
              data-deployment-export
              disabled={!canExport}
              onClick={() => {
                if (canExport && Date.now() < Date.parse(review.expiresAtUtc))
                  download('modeldb-deployment-plan.json', review.plan);
              }}
            >
              {t('export')}
            </button>
            {review.descriptor && (
              <button
                className="designer-btn"
                data-deployment-download
                disabled={!canExport}
                onClick={() => {
                  if (canExport && Date.now() < Date.parse(review.expiresAtUtc))
                    download('modeldb-connection.json', review.descriptor);
                }}
              >
                {t('download')}
              </button>
            )}
            <button
              className="designer-btn"
              data-deployment-edit
              disabled={busy}
              onClick={() => {
                setReview(undefined);
                setImported(false);
                setIssue(false);
              }}
            >
              {t('edit')}
            </button>
          </div>
          <p className="deployment-note">{t('finalize')}</p>
        </section>
      )}
    </section>
  );
}
