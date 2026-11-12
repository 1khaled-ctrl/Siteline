import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type LoadState = 'loading' | 'ready' | 'failed';
export type StatusView = 'solar' | 'earth' | 'mars' | 'globe' | 'pole' | 'site';

export interface Load {
  state: LoadState;
  /** Why it failed, for the small print. */
  reason?: string;
  ready: () => void;
  fail: (e: unknown) => void;
  /** Back to loading, for a view that loads something new without remounting. */
  restart: () => void;
}

/** Starts the open 3D view over from scratch: the frame remounts it, so every load runs again. */
export const RetryView = createContext<() => void>(() => {});

/** A failure in words; when every one of several tries failed, the first one's words. */
export function reasonOf(e: unknown): string {
  if (e instanceof AggregateError && e.errors.length) return reasonOf(e.errors[0]);
  return e instanceof Error ? e.message : String(e);
}

/** One view's load: loading until `ready` or `fail`. */
export function useLoad(): Load {
  const [status, setStatus] = useState<{ state: LoadState; reason?: string }>({ state: 'loading' });
  const ready = useCallback(() => setStatus({ state: 'ready' }), []);
  const fail = useCallback((e: unknown) => setStatus({ state: 'failed', reason: reasonOf(e) }), []);
  const restart = useCallback(() => setStatus({ state: 'loading' }), []);
  return { ...status, ready, fail, restart };
}

/** For a 3D view's frame: hidden until its imagery is on, then faded in, so an untextured globe never shows. */
export const revealWhen = (load: Load) =>
  `transition-opacity duration-500 ${load.state === 'ready' ? 'opacity-100' : 'opacity-0'}`;

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full border-2 border-accent/25 border-t-accent motion-safe:animate-spin ${className}`}
    />
  );
}

/**
 * What a 3D view shows while its data is on the way, and if it never arrives: a spinner with what is loading, or a
 * card saying what failed with a button to try again. Nothing once the view is ready.
 */
export function ViewStatus({ view, load }: { view: StatusView; load: Load }) {
  const { t } = useTranslation();
  const retry = useContext(RetryView);
  if (load.state === 'ready') return null;
  if (load.state === 'loading')
    return (
      <div className="pointer-events-none absolute inset-0 z-1 grid place-items-center">
        <p
          role="status"
          className="status-in flex items-center gap-2.5 rounded-full border border-line bg-panel/90 px-4 py-2 text-sm text-quiet shadow-lg"
        >
          <Spinner />
          {t(`status.loading.${view}`)}
        </p>
      </div>
    );
  return (
    <div className="absolute inset-0 z-1 grid place-items-center p-4">
      <div role="alert" className="max-w-sm rounded-xl border border-fail/50 bg-panel/95 p-4 text-center shadow-lg">
        <p className="font-semibold text-ink">{t(`status.failed.${view}`)}</p>
        <p className="mt-1 text-sm text-quiet">{t('status.help')}</p>
        {load.reason && (
          <p className="mt-2 font-mono text-xs wrap-break-word text-quiet" dir="ltr">
            {t('status.reason', { message: load.reason })}
          </p>
        )}
        <button
          type="button"
          onClick={retry}
          className="mt-3 min-h-9 rounded-md border border-sun/60 bg-sun/15 px-4 text-sm text-sun-ink hover:border-sun"
        >
          {t('status.retry')}
        </button>
      </div>
    </div>
  );
}

/** True while the browser says it has no network. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
