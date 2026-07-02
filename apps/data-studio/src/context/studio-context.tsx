import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { StudioI18n, type StudioLocale } from '../managers/i18n-manager.js';
import { StudioNotificationManager } from '../managers/notification-manager.js';

export interface StudioContextValue {
  readonly i18n: StudioI18n;
  readonly notify: StudioNotificationManager;
}

const StudioContext = createContext<StudioContextValue | null>(null);

const i18nSingleton = new StudioI18n();
const notifySingleton = new StudioNotificationManager();

/** Root context: i18n + notifications for Data Studio. */
export function StudioProvider(props: { readonly children: ReactNode }): ReactElement {
  const value = useMemo<StudioContextValue>(
    () => ({ i18n: i18nSingleton, notify: notifySingleton }),
    [],
  );
  return <StudioContext.Provider value={value}>{props.children}</StudioContext.Provider>;
}

/** Access studio i18n and notifications. */
export function useStudio(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (!ctx) {
    throw new Error('useStudio must be used within StudioProvider');
  }
  return ctx;
}

/** Re-render when locale changes. */
export function useStudioLocale(): StudioLocale {
  const { i18n } = useStudio();
  return useSyncExternalStore(
    (fn) => i18n.subscribe(fn),
    () => i18n.locale,
    () => i18n.locale,
  );
}

export type { StudioLocale };
