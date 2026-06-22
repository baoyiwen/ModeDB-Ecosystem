import { useEffect, useState } from 'react';

export type PlaygroundRoute = 'playground' | 'query-manual';

function parseHashRoute(): PlaygroundRoute {
  const raw = window.location.hash.replace(/^#/, '').replace(/^\//, '');
  if (raw === 'query-manual') {
    return 'query-manual';
  }
  return 'playground';
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

export function navigateToQueryManual(): void {
  window.location.hash = '#/query-manual';
}

export function navigateToPlayground(): void {
  window.location.hash = '';
}
