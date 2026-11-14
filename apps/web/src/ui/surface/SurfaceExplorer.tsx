import { DEFAULT_STAY } from '@siteline/contracts';
import {
  EDGE_MARGIN_M,
  FAST_M_PER_S,
  type SurfaceLabelKey,
  type SurfaceLabels,
  type SurfaceMode,
  SurfaceView,
} from '@siteline/engine/surface';
import { EYE_HEIGHT_M, type MoveBlock } from '@siteline/physics';
import * as Comlink from 'comlink';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber, formatUtc } from '../../format';
import { gridReachLatDeg, type LandingTarget, latestOnly, TERRAIN_EXTENT } from '../../land';
import { HOUR_MS, physics, URLS } from '../../physics';
import type { EyeView, SurfaceProgress, SurfaceQuality, SurfaceScene, SurfaceSky } from '../../physics.worker';
import { sound } from '../../sound';
import { FIRST_UTC_MS, LAST_UTC_MS, useApp } from '../../store';
import { pressedGold } from '../Controls';
import { SoundToggle } from '../SoundToggle';
import { Spinner } from '../ViewStatus';

type Phase =
  | { kind: 'loading'; progress?: SurfaceProgress; lighting?: boolean }
  | { kind: 'ready' }
  | { kind: 'outside' }
  | { kind: 'nodata' }
  | { kind: 'cancelled' }
  | { kind: 'error'; reason: string }
  | { kind: 'lost' };

/** The stages the loading panel lists, in order. */
const STAGES = ['opening', 'near', 'middle', 'wide', 'horizon', 'building', 'light'] as const;
type Stage = (typeof STAGES)[number];

/** "Most of the ground around you is in shadow": under a fifth of the Sun, on average, within 150 m. */
const DARK_RADIUS_M = 150;
const DARK_SHARE = 0.2;

/** How far the clock can be moved from touchdown: three days before to thirty after, in hours. */
const OFFSET_MIN_H = -72;
const OFFSET_MAX_H = 720;

const button =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-line bg-panel-raised/90 px-3 text-sm hover:border-line-hover disabled:opacity-50';
const chip = `inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line bg-panel-raised/90 px-3 text-sm hover:border-line-hover ${pressedGold}`;

/** A modest machine (few cores, or a phone) draws the terrain at half the density. */
function qualityFor(): SurfaceQuality {
  const cores = navigator.hardwareConcurrency ?? 8;
  return cores <= 4 || window.matchMedia('(pointer: coarse)').matches ? 'low' : 'high';
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function offsetLabel(offsetMs: number): { sign: string; d: number; h: number } {
  const totalH = Math.round(Math.abs(offsetMs) / HOUR_MS);
  return { sign: offsetMs < 0 ? '−' : '+', d: Math.floor(totalH / 24), h: totalH % 24 };
}

/**
 * The surface view: lands on the chosen point, then lets you walk the terrain around it at eye height under the Sun
 * and the Earth of the moment. The map underneath stays as it was; Return to map closes this and nothing else.
 */
export default function SurfaceExplorer({ target }: { target: LandingTarget }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<SurfaceView | null>(null);
  const labelEls = useRef<Partial<Record<SurfaceLabelKey, HTMLSpanElement | null>>>({});
  const labelsOnRef = useRef(true);
  const quality = useMemo(qualityFor, []);
  const coarsePointer = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const narrow = useMemo(() => window.matchMedia('(max-width: 40rem)').matches, []);
  const loads = useMemo(latestOnly, []);
  const skies = useMemo(latestOnly, []);
  const eyes = useMemo(latestOnly, []);

  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [scene, setScene] = useState<SurfaceScene>();
  const [mode, setMode] = useState<SurfaceMode>('idle');
  const [locked, setLocked] = useState(false);
  const [blocked, setBlocked] = useState<MoveBlock | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [sky, setSky] = useState<Omit<SurfaceSky, 'sunlit'>>();
  const [eye, setEye] = useState<EyeView>();
  const [shadowsBusy, setShadowsBusy] = useState(false);
  const [labelsOn, setLabelsOn] = useState(true);
  const [markerOn, setMarkerOn] = useState(true);
  const [inspectOn, setInspectOn] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  /** True when most of the walkable ground around the eye is in shadow at this moment. */
  const [darkHere, setDarkHere] = useState(false);
  // On a narrow screen the view's options fold away behind one button, to keep the horizon in view.
  const [toolsOpen, setToolsOpen] = useState(!narrow);

  const exploreUtcMs = target.touchdownUtcMs + offsetMs;
  const exploreRef = useRef(exploreUtcMs);
  exploreRef.current = exploreUtcMs;
  const offsetMsRef = useRef(offsetMs);
  offsetMsRef.current = offsetMs;
  /** The load in flight, for Cancel; and the moment whose full light is on screen, so it is not asked for twice. */
  const loadIdRef = useRef(0);
  const litUtcRef = useRef<number | null>(null);

  const close = useCallback(() => useApp.getState().setLanding(null), []);

  // While the surface view is open the map's time-lapse holds still, and focus comes back to where it was on the way out.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const { playing, setPlay } = useApp.getState();
    if (playing) setPlay({ playing: false });
    dialogRef.current?.focus();
    return () => {
      if (playing) useApp.getState().setPlay({ playing: true });
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // Load the terrain around the point; a retry asks again, and closing or a newer load cancels this one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is what asks again.
  useEffect(() => {
    const id = loads.start();
    loadIdRef.current = id;
    setPhase({ kind: 'loading' });
    setScene(undefined);
    const onProgress = Comlink.proxy((progress: SurfaceProgress) => {
      if (loads.isCurrent(id)) setPhase({ kind: 'loading', progress });
    });
    physics
      .surface({ id, latDeg: target.latDeg, lonDeg: target.lonDeg, quality }, URLS, onProgress)
      .then((outcome) => {
        if (!loads.isCurrent(id)) return;
        if (outcome.status === 'ready') setScene(outcome.scene);
        else setPhase({ kind: outcome.status });
      })
      .catch((e: unknown) => {
        if (loads.isCurrent(id)) setPhase({ kind: 'error', reason: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      loads.cancel();
      void physics.surfaceCancel(id);
    };
  }, [attempt, target.latDeg, target.lonDeg, quality, loads]);

  const cancelLoad = () => {
    loads.cancel();
    void physics.surfaceCancel(loadIdRef.current);
    setPhase({ kind: 'cancelled' });
  };

  /** The Sun, the Earth, the shadows and the eye's readings for a moment; `quick` first, then in full. */
  const requestSky = useCallback(
    async (tUtcMs: number, quick: boolean): Promise<boolean> => {
      const view = viewRef.current;
      if (!view || !scene) return false;
      const id = skies.start();
      setShadowsBusy(true);
      const { east, north } = view.position();
      const answer = await physics.surfaceSky(scene.key, tUtcMs, URLS.data, { east, north }, quick);
      if (!skies.isCurrent(id) || viewRef.current !== view) return false;
      if (!answer) throw new Error('the surface was no longer kept');
      view.setLighting({
        sunDir: answer.sun.dir,
        sunRadiusDeg: answer.sun.radiusDeg,
        earthDir: answer.earth.dir,
        earthRadiusDeg: answer.earth.radiusDeg,
        sunlit: answer.sunlit,
      });
      const { sunlit: _, ...shown } = answer;
      setSky(shown);
      setDarkHere(view.sunlitAround(east, north, DARK_RADIUS_M) < DARK_SHARE);
      if (answer.eye) setEye(answer.eye);
      if (!quick) {
        setShadowsBusy(false);
        litUtcRef.current = tUtcMs;
      }
      return true;
    },
    [scene, skies],
  );

  // The surface itself, once its terrain is in: lit for touchdown, then the descent.
  useEffect(() => {
    const container = containerRef.current;
    if (!scene || !container) return;
    let view: SurfaceView;
    try {
      view = new SurfaceView(container, scene.levels, {
        reducedMotion: reducedMotion(),
        eyeHeightM: EYE_HEIGHT_M,
        onMode: (m) => {
          setMode(m);
          if (m === 'explore') sound.chime();
        },
        onBlocked: setBlocked,
        onPointerLock: setLocked,
        onSettled: (east, north) => {
          setDarkHere((viewRef.current?.sunlitAround(east, north, DARK_RADIUS_M) ?? 1) < DARK_SHARE);
          const id = eyes.start();
          physics.surfaceEye(scene.key, exploreRef.current, URLS.data, east, north).then(
            (answer) => eyes.isCurrent(id) && answer?.eye && setEye(answer.eye),
            () => {},
          );
        },
        onLabels: (labels: SurfaceLabels) => {
          for (const [key, at] of Object.entries(labels) as [SurfaceLabelKey, SurfaceLabels[SurfaceLabelKey]][]) {
            const el = labelEls.current[key];
            if (!el) continue;
            el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
            el.style.visibility = at.shown && labelsOnRef.current ? 'visible' : 'hidden';
          }
        },
        onLost: () => setPhase({ kind: 'lost' }),
      });
    } catch (e) {
      setPhase({ kind: 'error', reason: e instanceof Error ? e.message : String(e) });
      return;
    }
    viewRef.current = view;
    litUtcRef.current = null;
    // For checking in development, as the sound has `__sitelineSound`. Not in the built app.
    if (import.meta.env.DEV) (window as Window & { __sitelineSurface?: SurfaceView }).__sitelineSurface = view;
    setPhase({ kind: 'loading', lighting: true });
    requestSky(target.touchdownUtcMs + offsetMsRef.current, false).then(
      (applied) => {
        if (!applied || viewRef.current !== view) return;
        setPhase({ kind: 'ready' });
        view.startDescent();
      },
      (e: unknown) => setPhase({ kind: 'error', reason: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      skies.cancel();
      eyes.cancel();
      viewRef.current = null;
      view.dispose();
    };
    // The time is read from a ref: moving the clock must not rebuild the surface.
  }, [scene, requestSky, target.touchdownUtcMs, eyes, skies]);

  // Moving the clock: a quick pass for the light at once, then the shadows in full.
  useEffect(() => {
    if (phase.kind !== 'ready' || exploreUtcMs === litUtcRef.current) return;
    const timer = setTimeout(() => {
      requestSky(exploreUtcMs, true)
        .then((ok) => (ok ? requestSky(exploreUtcMs, false) : false))
        .catch(() => setShadowsBusy(false));
    }, 120);
    return () => clearTimeout(timer);
  }, [exploreUtcMs, phase.kind, requestSky]);

  useEffect(() => {
    labelsOnRef.current = labelsOn;
    for (const el of Object.values(labelEls.current)) if (el && !labelsOn) el.style.visibility = 'hidden';
  }, [labelsOn]);
  useEffect(() => viewRef.current?.setTouchdownMarker(markerOn), [markerOn]);
  useEffect(() => viewRef.current?.setInspectionLight(inspectOn), [inspectOn]);

  const shiftClock = (hours: number) =>
    setOffsetMs((ms) => Math.min(OFFSET_MAX_H, Math.max(OFFSET_MIN_H, Math.round(ms / HOUR_MS) + hours)) * HOUR_MS);

  const place = `${formatNumber(Math.abs(target.latDeg), 4)}° ${target.latDeg < 0 ? t('landers.south') : t('landers.north')}, ${formatNumber(Math.abs(target.lonDeg), 4)}° ${target.lonDeg < 0 ? t('landers.west') : t('landers.east')}`;
  const reach = formatNumber(Math.abs(gridReachLatDeg(TERRAIN_EXTENT.coarse.halfM)), 0);
  const near = scene?.levels.find((l) => l.name === 'near');
  const fromTouchdownM = eye ? Math.hypot(eye.east, eye.north) : 0;
  const walkKm = near ? formatNumber((near.halfM - EDGE_MARGIN_M) / 1000, 1) : '';
  const off = offsetLabel(offsetMs);
  // The share of the Earth's face in sunlight as seen from here: (1 − cos θ) / 2, θ the Sun–Earth angle in this sky.
  const earthLitPct = sky
    ? 50 *
      (1 - (sky.sun.dir[0] * sky.earth.dir[0] + sky.sun.dir[1] * sky.earth.dir[1] + sky.sun.dir[2] * sky.earth.dir[2]))
    : undefined;
  const bodyLine = (b: EyeView['sun'] | undefined) => {
    if (!b) return '';
    const elev = formatNumber(b.elevDeg, 1);
    if (b.fraction > 0) return t('land.discInView', { pct: formatNumber(b.fraction * 100, 0), elev });
    return b.elevDeg > 0 ? t('land.behindTerrain', { elev }) : t('land.belowHorizon', { elev });
  };

  /** Each loading stage as done, under way (the rings load side by side) or still to come. */
  const stageState = (s: Stage): 'done' | 'now' | 'later' => {
    if (phase.kind !== 'loading') return 'later';
    if (phase.lighting) return s === 'light' ? 'now' : 'done';
    const p = phase.progress;
    if (s === 'light') return 'later';
    if (p?.finished.includes(s)) return 'done';
    const now = p?.now ?? 'opening';
    if (s === 'opening') return now === 'opening' ? 'now' : 'done';
    if (s === 'building') return now === 'building' ? 'now' : 'later';
    return now === 'reading' ? 'now' : now === 'building' ? 'done' : 'later';
  };

  const walkPad = (forward: number, right: number, label: string, glyph: string) => (
    <button
      type="button"
      aria-label={label}
      className="grid size-12 place-items-center rounded-md border border-line bg-panel-raised/90 text-lg select-none active:border-sun"
      onPointerDown={(e) => {
        viewRef.current?.setTouchMove(forward, right);
        // Held while the finger stays down, even if it slides off the button.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // No capture (an unusual pointer): letting go on the button still stops the walk.
        }
      }}
      onPointerUp={() => viewRef.current?.setTouchMove(0, 0)}
      onPointerCancel={() => viewRef.current?.setTouchMove(0, 0)}
      onLostPointerCapture={() => viewRef.current?.setTouchMove(0, 0)}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );

  const labelSpan = (key: SurfaceLabelKey, children: ReactNode, className = '') => (
    <span
      key={key}
      ref={(el) => {
        labelEls.current[key] = el;
      }}
      className={`pointer-events-none absolute start-0 top-0 whitespace-nowrap ${className}`}
      style={{ visibility: 'hidden' }}
    >
      <span className="block -translate-x-1/2 -translate-y-full pb-1">{children}</span>
    </span>
  );

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="surface-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 overflow-clip bg-black text-ink outline-none"
      data-testid="surface-view"
    >
      <div ref={containerRef} className="absolute inset-0" data-testid="surface-canvas" />

      {/* Labels that follow the sky and the ground: placed on every frame by the view, outside React. */}
      <div dir="ltr" className="pointer-events-none absolute inset-0 overflow-hidden text-xs" aria-hidden="true">
        {labelSpan(
          'sun',
          <span className="rounded bg-black/55 px-1.5 py-0.5 text-sun-ink">
            {t('land.sun')}
            {eye ? ` · ${bodyLine(eye.sun)}` : ''}
          </span>,
        )}
        {labelSpan(
          'earth',
          <span className="rounded bg-black/55 px-1.5 py-0.5 text-accent">
            {t('land.earth')}
            {eye ? ` · ${bodyLine(eye.earth)}` : ''}
          </span>,
        )}
        {labelSpan(
          'touchdown',
          <span className="rounded bg-black/55 px-1.5 py-0.5 text-sun">{t('land.touchdown')}</span>,
        )}
        {(['north', 'east', 'south', 'west'] as const).map((k) =>
          labelSpan(k, <span className="font-display text-sm text-quiet">{t(`land.compass.${k}`)}</span>),
        )}
      </div>

      {/* Top: where this is and what the eye sees from it, and the way back. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
        <div className="flex max-w-[min(30rem,calc(100%-9.5rem))] flex-col gap-2">
          <div className="glass pointer-events-auto px-3.5 py-2.5">
            <h2 id="surface-title" className="font-display text-lg leading-tight">
              {target.name ?? t('land.title')}
            </h2>
            <p className="font-mono text-sm" dir="ltr">
              {place}
            </p>
            <p className="mt-0.5 text-xs text-quiet max-sm:hidden">{t('land.subtitle')}</p>
          </div>
          {phase.kind === 'ready' && mode === 'explore' && (
            <div className="glass pointer-events-auto px-3 py-2 text-xs" data-testid="surface-readings">
              <p className="text-quiet">
                {t('land.eyeTitle', { eye: formatNumber(EYE_HEIGHT_M, 1) })} ·{' '}
                {fromTouchdownM < 1
                  ? t('land.atTouchdown')
                  : t('land.fromTouchdown', { m: formatNumber(fromTouchdownM, 0) })}
              </p>
              {eye ? (
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
                  <dt className="text-sun-ink">{t('land.sun')}</dt>
                  <dd data-text>{bodyLine(eye.sun)}</dd>
                  <dt className="text-accent">{t('land.earth')}</dt>
                  <dd data-text>
                    {bodyLine(eye.earth)}
                    {earthLitPct !== undefined && ` · ${t('land.earthLit', { pct: formatNumber(earthLitPct, 0) })}`}
                  </dd>
                </dl>
              ) : (
                <p className="mt-1">{t('land.readingsPending')}</p>
              )}
            </div>
          )}
        </div>
        <div className="pointer-events-auto flex items-center gap-1.5">
          <button type="button" className={`${button} border-sun/60`} onClick={close} data-testid="surface-return">
            <span aria-hidden="true">←</span> {t('land.return')}
          </button>
          <SoundToggle />
        </div>
      </div>

      {darkHere && !inspectOn && phase.kind === 'ready' && mode === 'explore' && (
        <p
          role="status"
          className="pointer-events-auto absolute inset-x-3 top-1/2 mx-auto flex w-fit max-w-md -translate-y-1/2 flex-wrap items-center justify-center gap-2 rounded-md border border-line bg-black/70 px-3 py-2 text-center text-sm text-quiet"
          data-testid="surface-dark"
        >
          {t('land.darkHere')}
          <button type="button" className={`${button} text-ink`} onClick={() => setInspectOn(true)}>
            {t('land.inspect')}
          </button>
        </p>
      )}

      {inspectOn && (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 mx-auto w-fit -translate-y-1/2 rounded-md border border-accent/60 bg-black/70 px-3 py-1.5 text-sm text-accent">
          {t('land.inspectOn')}
        </p>
      )}

      {blocked && (
        <p
          role="status"
          className="pointer-events-none absolute inset-x-3 top-1/3 mx-auto w-fit max-w-md rounded-md border border-warn/60 bg-black/75 px-3 py-2 text-center text-sm text-warn"
        >
          {blocked === 'edge' ? t('land.edge', { km: walkKm }) : t('land.nodataBlock')}
        </p>
      )}

      {/* The descent: what it is, and the way past it. */}
      {phase.kind === 'ready' && mode === 'descent' && (
        <div className="glass pointer-events-auto absolute inset-x-3 bottom-4 mx-auto flex max-w-xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-display text-base text-sun-ink">{t('land.descending')}</p>
            <p className="text-xs text-quiet">{t('land.descentNote')}</p>
          </div>
          <button
            type="button"
            className={`${button} border-sun/60`}
            onClick={() => viewRef.current?.skipDescent()}
            data-testid="surface-skip"
          >
            {t('land.skip')}
          </button>
        </div>
      )}

      {/* Bottom: the clock, the walk, and what this view assumes. */}
      {phase.kind === 'ready' && mode === 'explore' && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 p-3">
          {infoOpen && scene && (
            <section
              className="glass pointer-events-auto max-h-[45dvh] max-w-2xl overflow-y-auto px-4 py-3 text-xs leading-relaxed"
              aria-label={t('land.about')}
              data-testid="surface-info"
            >
              <p>{t('land.info.what')}</p>
              {target.source.kind === 'passing' && (
                <p className="mt-2 text-sun-ink">
                  {t('land.passing', {
                    sun: formatNumber(target.source.sunFractionMin * 100, 0),
                    earth: formatNumber(target.source.earthVisiblePct, 0),
                    slope: formatNumber(target.source.slope100mDeg, 1),
                    observer: formatNumber(DEFAULT_STAY.observerHeightM, 0),
                  })}
                </p>
              )}
              <h3 className="mt-2 font-display text-sm">{t('land.info.rings')}</h3>
              <ul className="list-disc ps-4">
                {scene.levels.map((l) => (
                  <li key={l.name}>
                    {t('land.info.ringLine', {
                      ring: t(`land.info.ring.${l.name}`),
                      id: l.datasetId,
                      data: formatNumber(l.sourcePixM, 0),
                      mesh: formatNumber(l.spacingM, 0),
                      reach: formatNumber(l.halfM / 1000, 0),
                    })}
                    {l.filledPct >= 0.05 && `; ${t('land.info.filled', { pct: formatNumber(l.filledPct, 1) })}`}
                    {l.missingPct >= 0.05 && `; ${t('land.info.missing', { pct: formatNumber(l.missingPct, 1) })}`}
                  </li>
                ))}
              </ul>
              <p className="mt-2">{t('land.info.scale')}</p>
              <p className="mt-1">
                {t('land.info.eye', {
                  eye: formatNumber(EYE_HEIGHT_M, 1),
                  observer: formatNumber(DEFAULT_STAY.observerHeightM, 0),
                })}
              </p>
              <p className="mt-1">
                {t('land.info.shadows', { shadow: formatNumber(sky?.shadowM ?? near?.spacingM ?? 0, 0) })}
              </p>
              <p className="mt-1">{t('land.info.material')}</p>
              <p className="mt-1">{t('land.info.detail')}</p>
              <p className="mt-1">{t('land.info.earthLook')}</p>
              <p className="mt-1">{t('land.info.slope')}</p>
              <p className="mt-1">{t('land.info.descent')}</p>
            </section>
          )}

          <div className="glass pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
            <div className="min-w-0 text-xs">
              <p className="text-quiet">
                {t('land.touchdown')}: <span dir="ltr">{formatUtc(new Date(target.touchdownUtcMs).toISOString())}</span>
              </p>
              <p data-testid="surface-time">
                {t('land.showing')}: <span dir="ltr">{formatUtc(new Date(exploreUtcMs).toISOString())}</span>
                {offsetMs !== 0 && (
                  <span className="ms-1 font-mono text-sun-ink" dir="ltr">
                    ({t('land.offset', off)})
                  </span>
                )}
              </p>
              {sky?.clamped && (
                <p className="text-warn">
                  {t('land.clamped', {
                    from: new Date(FIRST_UTC_MS).getUTCFullYear(),
                    to: new Date(LAST_UTC_MS).getUTCFullYear(),
                  })}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5" dir="ltr">
              <button type="button" className={button} onClick={() => shiftClock(-24)} aria-label={t('land.minusDay')}>
                −1 d
              </button>
              <button type="button" className={button} onClick={() => shiftClock(-1)} aria-label={t('land.minusHour')}>
                −1 h
              </button>
              <input
                type="range"
                min={OFFSET_MIN_H}
                max={OFFSET_MAX_H}
                step={1}
                value={Math.round(offsetMs / HOUR_MS)}
                onChange={(e) => setOffsetMs(Number(e.target.value) * HOUR_MS)}
                aria-label={t('land.timeSlider')}
                className="h-11 w-40 accent-sun max-sm:w-28"
                data-testid="surface-slider"
              />
              <button type="button" className={button} onClick={() => shiftClock(1)} aria-label={t('land.plusHour')}>
                +1 h
              </button>
              <button type="button" className={button} onClick={() => shiftClock(24)} aria-label={t('land.plusDay')}>
                +1 d
              </button>
              <button
                type="button"
                className={`${button} border-sun/60`}
                disabled={offsetMs === 0}
                onClick={() => setOffsetMs(0)}
                data-testid="surface-touchdown-time"
              >
                {t('land.backToTouchdown')}
              </button>
            </div>
            {shadowsBusy && (
              <p role="status" className="flex items-center gap-1.5 text-xs text-quiet">
                <Spinner className="size-3.5" />
                {t('land.shadowsBusy')}
              </p>
            )}
          </div>

          <div className="pointer-events-auto flex flex-wrap items-end justify-between gap-2">
            <div className="flex flex-wrap items-end gap-1.5">
              {narrow && (
                <button
                  type="button"
                  className={chip}
                  aria-expanded={toolsOpen}
                  aria-pressed={toolsOpen}
                  onClick={() => setToolsOpen((v) => !v)}
                >
                  {t('land.options')}
                </button>
              )}
              {toolsOpen && (
                <div className="glass flex flex-wrap items-center gap-1.5 px-2 py-1.5">
                  <button
                    type="button"
                    className={button}
                    onClick={() => viewRef.current?.resetPosition()}
                    data-testid="surface-reset"
                  >
                    {t('land.reset')}
                  </button>
                  <button type="button" className={button} onClick={() => viewRef.current?.startDescent()}>
                    {t('land.replay')}
                  </button>
                  <button type="button" className={chip} aria-pressed={labelsOn} onClick={() => setLabelsOn((v) => !v)}>
                    {t('land.labels')}
                  </button>
                  <button type="button" className={chip} aria-pressed={markerOn} onClick={() => setMarkerOn((v) => !v)}>
                    {t('land.marker')}
                  </button>
                  <button
                    type="button"
                    className={chip}
                    aria-pressed={inspectOn}
                    onClick={() => setInspectOn((v) => !v)}
                    data-testid="surface-inspect"
                  >
                    {t('land.inspect')}
                  </button>
                  <button
                    type="button"
                    className={chip}
                    aria-pressed={infoOpen}
                    aria-expanded={infoOpen}
                    onClick={() => setInfoOpen((v) => !v)}
                    data-testid="surface-about"
                  >
                    {t('land.about')}
                  </button>
                </div>
              )}
            </div>

            {coarsePointer ? (
              <fieldset className="glass m-0 grid min-w-0 grid-cols-3 gap-1 p-1.5">
                <legend className="sr-only">{t('land.touchHint')}</legend>
                <span />
                {walkPad(1, 0, t('land.walk.forward'), '▲')}
                <span />
                {walkPad(0, -1, t('land.walk.left'), '◀')}
                {walkPad(-1, 0, t('land.walk.back'), '▼')}
                {walkPad(0, 1, t('land.walk.right'), '▶')}
              </fieldset>
            ) : (
              <div className="glass flex max-w-md flex-wrap items-center gap-2 px-3 py-2 text-xs text-quiet">
                <p className="min-w-0 flex-1 max-sm:hidden" data-testid="surface-help">
                  {locked ? t('land.lockedHint') : t('land.lookHint', { fast: formatNumber(FAST_M_PER_S, 0) })}
                </p>
                {!locked && (
                  <button
                    type="button"
                    className={`${button} text-ink`}
                    onClick={() => viewRef.current?.requestPointerLook()}
                    data-testid="surface-look"
                  >
                    {t('land.lookMouse')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Loading, and the ways it can end without a surface. */}
      {phase.kind !== 'ready' && (
        <div className="absolute inset-0 grid place-items-center bg-black/80 p-4">
          <div className="glass w-full max-w-md px-5 py-4" role={phase.kind === 'loading' ? 'status' : 'alert'}>
            {phase.kind === 'loading' && (
              <>
                <h3 className="font-display text-lg">{t('land.loadingTitle')}</h3>
                <p className="font-mono text-sm" dir="ltr">
                  {place}
                </p>
                <ol className="mt-3 space-y-1 text-sm" data-testid="surface-stages">
                  {STAGES.map((s) => {
                    const state = stageState(s);
                    return (
                      <li key={s} className={`flex items-center gap-2 ${state === 'later' ? 'text-quiet' : ''}`}>
                        <span className="grid size-4 place-items-center" aria-hidden="true">
                          {state === 'done' ? (
                            <span className="text-pass">✓</span>
                          ) : state === 'now' ? (
                            <Spinner />
                          ) : (
                            '·'
                          )}
                        </span>
                        {t(`land.stage.${s}`)}
                        <span className="sr-only">{state === 'done' ? ' ✓' : ''}</span>
                      </li>
                    );
                  })}
                </ol>
                <p className="mt-3 text-xs text-quiet">{t('land.loadingNote')}</p>
                <div className="mt-3 flex justify-end">
                  <button type="button" className={button} onClick={cancelLoad} data-testid="surface-cancel">
                    {t('land.cancel')}
                  </button>
                </div>
              </>
            )}
            {phase.kind !== 'loading' && (
              <>
                <h3 className="font-display text-lg">
                  {phase.kind === 'error' || phase.kind === 'lost' ? t('land.failed') : t('land.title')}
                </h3>
                <p className="mt-2 text-sm">
                  {phase.kind === 'outside' && t('land.outside', { lat: reach })}
                  {phase.kind === 'nodata' && t('land.noData')}
                  {phase.kind === 'cancelled' && t('land.cancelled')}
                  {phase.kind === 'lost' && t('land.lost')}
                  {phase.kind === 'error' && phase.reason}
                </p>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  {(phase.kind === 'error' || phase.kind === 'cancelled' || phase.kind === 'lost') && (
                    <button
                      type="button"
                      className={button}
                      onClick={() => setAttempt((a) => a + 1)}
                      data-testid="surface-retry"
                    >
                      {t('land.retry')}
                    </button>
                  )}
                  <button type="button" className={`${button} border-sun/60`} onClick={close}>
                    {t('land.return')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
