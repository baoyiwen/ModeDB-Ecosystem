import { type ReactElement } from 'react';
import { useI18n } from '../i18n/I18nContext.js';
import type { MessageKey } from '../i18n/messages.js';
import { navigateToPlayground } from '../hooks/use-hash-route.js';
import { QUERY_MANUAL_SECTIONS } from '../query/query-manual-sections.js';

const COMPUTE_OP_KEYS: readonly { op: string; key: MessageKey }[] = [
  { op: 'sum', key: 'manual.compute.sum' },
  { op: 'avg', key: 'manual.compute.avg' },
  { op: 'min', key: 'manual.compute.min' },
  { op: 'max', key: 'manual.compute.max' },
  { op: 'count', key: 'manual.compute.count' },
  { op: 'variance', key: 'manual.compute.variance' },
  { op: 'stdDev', key: 'manual.compute.stdDev' },
];

export function QueryManualPage(): ReactElement {
  const { t } = useI18n();

  return (
    <div className="query-manual-page">
      <header className="query-manual-header">
        <div className="query-manual-header-inner">
          <button type="button" className="query-manual-back" onClick={navigateToPlayground}>
            {t('manual.back')}
          </button>
          <h1>{t('manual.title')}</h1>
          <p className="hint">{t('manual.subtitle')}</p>
        </div>
      </header>

      <div className="query-manual-layout">
        <nav className="query-manual-toc" aria-label={t('manual.toc')}>
          <h2>{t('manual.toc')}</h2>
          <ol>
            {QUERY_MANUAL_SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{t(section.titleKey)}</a>
              </li>
            ))}
            <li>
              <a href="#filter-ops">{t('manual.sFilterOps.title')}</a>
            </li>
            <li>
              <a href="#hop-compare">{t('manual.sHopCompare.title')}</a>
            </li>
            <li>
              <a href="#compute-ops">{t('manual.sComputeOps.title')}</a>
            </li>
          </ol>
        </nav>

        <main className="query-manual-body">
          {QUERY_MANUAL_SECTIONS.map((section) => (
            <section key={section.id} id={section.id} className="query-manual-section">
              <h2>{t(section.titleKey)}</h2>
              {section.paragraphKeys.map((key) => (
                <p key={key}>{t(key)}</p>
              ))}
              {section.examples?.map((example) => (
                <figure key={example.captionKey} className="query-manual-example">
                  <figcaption>{t(example.captionKey)}</figcaption>
                  <pre>
                    <code>{example.code}</code>
                  </pre>
                </figure>
              ))}
            </section>
          ))}

          <section id="filter-ops" className="query-manual-section query-manual-section--table">
            <h2>{t('manual.sFilterOps.title')}</h2>
            <p>{t('manual.sFilterOps.p1')}</p>
            <table className="query-manual-table">
              <thead>
                <tr>
                  <th>{t('manual.table.op')}</th>
                  <th>{t('manual.table.meaning')}</th>
                  <th>{t('manual.table.valueShape')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>eq</code>
                  </td>
                  <td>{t('manual.op.eq')}</td>
                  <td>{t('manual.opVal.scalar')}</td>
                </tr>
                <tr>
                  <td>
                    <code>neq</code>
                  </td>
                  <td>{t('manual.op.neq')}</td>
                  <td>{t('manual.opVal.scalar')}</td>
                </tr>
                <tr>
                  <td>
                    <code>gt</code> / <code>gte</code>
                  </td>
                  <td>{t('manual.op.gt')}</td>
                  <td>{t('manual.opVal.number')}</td>
                </tr>
                <tr>
                  <td>
                    <code>lt</code> / <code>lte</code>
                  </td>
                  <td>{t('manual.op.lt')}</td>
                  <td>{t('manual.opVal.number')}</td>
                </tr>
                <tr>
                  <td>
                    <code>like</code>
                  </td>
                  <td>{t('manual.op.like')}</td>
                  <td>{t('manual.opVal.string')}</td>
                </tr>
                <tr>
                  <td>
                    <code>in</code>
                  </td>
                  <td>{t('manual.op.in')}</td>
                  <td>{t('manual.opVal.array')}</td>
                </tr>
                <tr>
                  <td>
                    <code>between</code>
                  </td>
                  <td>{t('manual.op.between')}</td>
                  <td>{t('manual.opVal.tuple')}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section id="hop-compare" className="query-manual-section query-manual-section--table">
            <h2>{t('manual.sHopCompare.title')}</h2>
            <p>{t('manual.sHopCompare.p1')}</p>
            <table className="query-manual-table">
              <thead>
                <tr>
                  <th>{t('manual.table.hop')}</th>
                  <th>{t('manual.table.subject')}</th>
                  <th>{t('manual.table.typicalUse')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>relate</code>
                  </td>
                  <td>{t('manual.hop.relateSubject')}</td>
                  <td>{t('manual.hop.relateUse')}</td>
                </tr>
                <tr>
                  <td>
                    <code>group</code>
                  </td>
                  <td>{t('manual.hop.groupSubject')}</td>
                  <td>{t('manual.hop.groupUse')}</td>
                </tr>
                <tr>
                  <td>
                    <code>children</code>
                  </td>
                  <td>{t('manual.hop.childrenSubject')}</td>
                  <td>{t('manual.hop.childrenUse')}</td>
                </tr>
                <tr>
                  <td>
                    <code>relateRecursive</code>
                  </td>
                  <td>{t('manual.hop.recursiveSubject')}</td>
                  <td>{t('manual.hop.recursiveUse')}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section id="compute-ops" className="query-manual-section query-manual-section--table">
            <h2>{t('manual.sComputeOps.title')}</h2>
            <p>{t('manual.sComputeOps.p1')}</p>
            <table className="query-manual-table">
              <thead>
                <tr>
                  <th>{t('manual.table.op')}</th>
                  <th>{t('manual.table.meaning')}</th>
                </tr>
              </thead>
              <tbody>
                {COMPUTE_OP_KEYS.map(({ op, key }) => (
                  <tr key={op}>
                    <td>
                      <code>{op}</code>
                    </td>
                    <td>{t(key)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <footer className="query-manual-footer">
            <p>{t('manual.footer')}</p>
            <button type="button" className="query-manual-back" onClick={navigateToPlayground}>
              {t('manual.backToPlayground')}
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}
