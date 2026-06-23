import { useEffect, useState } from 'react';

export type PlaygroundRoute = 'playground' | 'query-manual';

function hashPath(): string {
  return window.location.hash.replace(/^#/, '').replace(/^\//, '');
}

function parseHashRoute(): PlaygroundRoute {
  const raw = hashPath();
  if (raw === 'query-manual' || raw.startsWith('query-manual/')) {
    return 'query-manual';
  }
  return 'playground';
}

/** Section slug from `#/query-manual/<section>` (null when only `#/query-manual`). */
export function getManualSectionFromHash(): string | null {
  const raw = hashPath();
  if (!raw.startsWith('query-manual/')) {
    return null;
  }
  const section = raw.slice('query-manual/'.length).trim();
  return section.length > 0 ? decodeURIComponent(section) : null;
}

/** Minimal hash routing for in-app pages (no react-router dependency). */
export function useHashRoute(): PlaygroundRoute {
  const [route, setRoute] = useState<PlaygroundRoute>(() => parseHashRoute());

  useEffect(() => {
    const onHashChange = (): void => {
      setRoute(parseHashRoute());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}

/** Tracks manual section slug in the URL hash (`#/query-manual/<id>`). */
export function useManualSectionHash(): string | null {
  const [sectionId, setSectionId] = useState<string | null>(() => getManualSectionFromHash());

  useEffect(() => {
    const onHashChange = (): void => {
      setSectionId(getManualSectionFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return sectionId;
}

export function navigateToQueryManual(sectionId?: string): void {
  window.location.hash = sectionId
    ? `#/query-manual/${encodeURIComponent(sectionId)}`
    : '#/query-manual';
}

export function navigateToManualSection(sectionId: string): void {
  navigateToQueryManual(sectionId);
}

export function replaceManualSectionHash(sectionId: string): void {
  const next = `#/query-manual/${encodeURIComponent(sectionId)}`;
  if (window.location.hash === next) {
    return;
  }
  window.history.replaceState(null, '', next);
}

export function navigateToPlayground(): void {
  window.location.hash = '';
}
