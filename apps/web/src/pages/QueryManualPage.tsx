import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useI18n } from '../i18n/I18nContext.js';
import type { MessageKey } from '../i18n/messages.js';
import {
  getManualSectionFromHash,
  navigateToPlayground,
  replaceManualSectionHash,
} from '../hooks/use-hash-route.js';
import { MANUAL_TOC_ENTRIES, QUERY_MANUAL_SECTIONS } from '../query/query-manual-sections.js';

const COMPUTE_OP_KEYS: readonly { op: string; key: MessageKey }[] = [
  { op: 'sum', key: 'manual.compute.sum' },
  { op: 'avg', key: 'manual.compute.avg' },
  { op: 'min', key: 'manual.compute.min' },
  { op: 'max', key: 'manual.compute.max' },
  { op: 'count', key: 'manual.compute.count' },
  { op: 'variance', key: 'manual.compute.variance' },
  { op: 'stdDev', key: 'manual.compute.stdDev' },
];

const MANUAL_SECTION_IDS = MANUAL_TOC_ENTRIES.map((entry) => entry.id);

/** 章节标题对齐线：距滚动容器顶部的偏移（px） */
const SCROLL_SPY_OFFSET = 20;

function sectionScrollTop(root: HTMLElement, section: HTMLElement): number {
  return section.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
}

function scrollToSection(root: HTMLElement, sectionId: string, behavior: ScrollBehavior): void {
  const target = root.querySelector<HTMLElement>(`#${CSS.escape(sectionId)}`);
  if (!target) {
    return;
  }
  const top = Math.max(0, sectionScrollTop(root, target) - SCROLL_SPY_OFFSET);
  root.scrollTo({ top, behavior });
}

/** 根据滚动位置判定当前章节（最后一段在触底时保持高亮）。 */
function resolveActiveSectionId(root: HTMLElement): string {
  const ids = MANUAL_SECTION_IDS;
  if (ids.length === 0) {
    return 'overview';
  }

  const maxScroll = root.scrollHeight - root.clientHeight;
  if (maxScroll > 0 && root.scrollTop >= maxScroll - 2) {
    return ids[ids.length - 1]!;
  }

  const marker = root.scrollTop + SCROLL_SPY_OFFSET;
  let active = ids[0]!;
  for (const id of ids) {
    const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!el) {
      continue;
    }
    if (sectionScrollTop(root, el) <= marker) {
      active = id;
    } else {
      break;
    }
  }
  return active;
}

export function QueryManualPage(): ReactElement {
  const { t } = useI18n();
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);
  const pendingSectionRef = useRef<string | null>(null);
  const scrollFallbackRef = useRef<number>(0);
  const [activeSectionId, setActiveSectionId] = useState<string>(
    () => MANUAL_SECTION_IDS[0] ?? 'overview',
  );

  const finishProgrammaticScroll = useCallback((root: HTMLElement): void => {
    const target = pendingSectionRef.current;
    pendingSectionRef.current = null;
    programmaticScrollRef.current = false;
    window.clearTimeout(scrollFallbackRef.current);
    if (!target) {
      return;
    }
    scrollToSection(root, target, 'instant');
    setActiveSectionId(target);
  }, []);

  const jumpToSection = useCallback(
    (sectionId: string, updateHash: boolean): void => {
      const root = scrollRootRef.current;
      if (!root) {
        return;
      }
      window.clearTimeout(scrollFallbackRef.current);
      pendingSectionRef.current = sectionId;
      programmaticScrollRef.current = true;
      setActiveSectionId(sectionId);
      scrollToSection(root, sectionId, 'smooth');
      if (updateHash) {
        replaceManualSectionHash(sectionId);
      }
      scrollFallbackRef.current = window.setTimeout(() => {
        if (programmaticScrollRef.current && scrollRootRef.current) {
          finishProgrammaticScroll(scrollRootRef.current);
        }
      }, 900);
    },
    [finishProgrammaticScroll],
  );

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) {
      return;
    }

    const initial = getManualSectionFromHash();
    if (initial) {
      requestAnimationFrame(() => {
        scrollToSection(root, initial, 'instant');
        setActiveSectionId(initial);
      });
    }

    let rafId = 0;
    const syncActiveFromScroll = (): void => {
      if (programmaticScrollRef.current) {
        return;
      }
      const next = resolveActiveSectionId(root);
      setActiveSectionId((prev) => (prev === next ? prev : next));
    };

    const onScroll = (): void => {
      if (programmaticScrollRef.current || rafId !== 0) {
        return;
      }
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        syncActiveFromScroll();
      });
    };

    const onScrollEnd = (): void => {
      if (programmaticScrollRef.current) {
        finishProgrammaticScroll(root);
      }
    };

    root.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('scrollend', onScrollEnd);
    onScroll();

    const onHashChange = (): void => {
      const section = getManualSectionFromHash();
      if (!section) {
        return;
      }
      pendingSectionRef.current = null;
      programmaticScrollRef.current = false;
      scrollToSection(root, section, 'instant');
      setActiveSectionId(section);
    };
    window.addEventListener('hashchange', onHashChange);

    return () => {
      root.removeEventListener('scroll', onScroll);
      root.removeEventListener('scrollend', onScrollEnd);
      window.removeEventListener('hashchange', onHashChange);
      window.clearTimeout(scrollFallbackRef.current);
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [finishProgrammaticScroll]);

  return (
    <div className="query-manual-page" ref={scrollRootRef}>
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
            {MANUAL_TOC_ENTRIES.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={
                    activeSectionId === entry.id
                      ? 'query-manual-toc__link query-manual-toc__link--active'
                      : 'query-manual-toc__link'
                  }
                  aria-current={activeSectionId === entry.id ? 'location' : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => jumpToSection(entry.id, true)}
                >
                  {t(entry.titleKey)}
                </button>
              </li>
            ))}
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
