import type { ReactElement } from 'react';
import { useDataPage } from '../context/data-page-context.js';

/** Global mode toolbar — view / edit / delete + batch commit controls. */
export function DataPageToolbar(): ReactElement {
  const page = useDataPage();

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderBottom: '1px solid rgba(15, 23, 42, 0.08)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
      }}
    >
      {page.allowedModes.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={page.mode === m}
          disabled={page.isRefreshing}
          onClick={() => page.setMode(m)}
          style={{
            padding: '4px 10px',
            borderRadius: 4,
            border: '1px solid rgba(15, 23, 42, 0.12)',
            background: page.mode === m ? '#6366f1' : '#fff',
            color: page.mode === m ? '#fff' : '#334155',
            cursor: 'pointer',
          }}
        >
          {m}
        </button>
      ))}
      <span style={{ flex: 1 }} />
      {page.isDirty ? (
        <>
          <button type="button" onClick={() => page.discard()}>
            Discard
          </button>
          <button
            type="button"
            onClick={() => {
              void page.commit().catch(() => {
                /* error surfaced via lastError */
              });
            }}
          >
            Commit ({page.binding.pendingCount})
          </button>
        </>
      ) : null}
      <button type="button" disabled={page.isRefreshing} onClick={() => void page.refresh()}>
        {page.isRefreshing ? 'Loading…' : 'Refresh'}
      </button>
      {page.lastError ? (
        <span
          style={{ color: '#dc2626', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {page.lastError}
        </span>
      ) : null}
    </header>
  );
}
