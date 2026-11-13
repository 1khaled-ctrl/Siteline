import gsap from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import layout from '../assets/emblem.json';
import emblemUrl from '../assets/emblem.webp';
import landerUrl from '../assets/emblem-lander.webp';
import starUrl from '../assets/emblem-star.webp';
import {
  allSettled,
  type BootTask,
  COIN_PX,
  firstPending,
  INTRO_MODE,
  markIntroSeen,
  RING_PX,
  track,
  useBoot,
} from '../boot';
import { measureFrames, perf } from '../perf';
import { useStage } from '../stage';
import { useApp } from '../store';

/** The emblem turns at least this long, so a quick load still gets its moment. */
const MIN_MS = 1700;
/** After this, a quiet line says what is still loading. */
const SLOW_MS = 4500;
/** After this the app opens anyway, and each view shows its own progress. */
const GIVE_UP_MS = 25_000;
/** Seconds per turn of the coin. */
const TURN_S = 3.4;
/** Points on the gold ring as it becomes the Earth's orbit. */
const RING_POINTS = 160;
/** The emblem ring's own gold, so the drawn ring takes over from it without a seam. */
const GOLD = '#feaf0a';
const ORDER: BootTask[] = ['emblem', 'fonts', 'positions', 'orbits', 'imagery', 'view'];

type Point = { x: number; y: number };
const lerp = (a: Point, b: Point, k: number): Point => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
const pathOf = (pts: Point[]) => `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}Z`;

/** Light on the turning coin: its face darkens toward edge-on, and a band of light slides across it. */
function lightCoin(coin: HTMLElement | null, band: HTMLElement | null): void {
  if (!coin || !band) return;
  const a = ((Number(gsap.getProperty(coin, 'rotationY')) % 360) + 360) % 360;
  const face = Math.abs(Math.cos((a * Math.PI) / 180));
  const shade = coin.querySelector<HTMLElement>('.intro-shade');
  if (shade) shade.style.opacity = (0.5 * (1 - face)).toFixed(3);
  band.style.transform = `translateX(${(((a + 90) % 180) / 180) * -66.7}%)`;
}

/** Where the emblem's parts sit on the page while the coin faces front, its middle at `centre`. */
function partsAt(centre: Point) {
  const left = centre.x - COIN_PX / 2;
  const top = centre.y - COIN_PX / 2;
  const box = (b: { x: number; y: number; w: number; h: number }) => ({
    x: left + b.x * COIN_PX,
    y: top + b.y * COIN_PX,
    w: b.w * COIN_PX,
    h: b.h * COIN_PX,
  });
  return {
    ring: { x: left + layout.ring.cx * COIN_PX, y: top + layout.ring.cy * COIN_PX },
    ringWidth: (layout.ring.outer - layout.ring.inner) * COIN_PX,
    lander: box(layout.lander),
    star: box(layout.star),
  };
}

/** The ring as `RING_POINTS` points, starting at −180° and going clockwise on screen, like `projectOrbit`. */
const circle = (c: Point, r: number): Point[] =>
  Array.from({ length: RING_POINTS }, (_, i) => {
    const a = ((i / RING_POINTS) * 2 - 1) * Math.PI;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });

/**
 * The opening. The emblem turns like a coin in the light for as long as the real data takes to arrive (the dots are the
 * loads it waits for), then it opens: the coin rushes past, its gold ring becomes the Earth's orbit as the camera pulls
 * back from straight over the Sun, the shooting star streaks off and the lander flies down to the Moon. Plays once per
 * tab; a fade for anyone who asked for less motion.
 */
export function Intro() {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<'loading' | 'leaving' | 'gone'>(INTRO_MODE === 'none' ? 'gone' : 'loading');
  const [slow, setSlow] = useState(false);
  const tasks = useBoot((s) => s.tasks);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const coin = useRef<HTMLDivElement>(null);
  const sheen = useRef<HTMLSpanElement>(null);
  const ring = useRef<SVGPathElement>(null);
  const lander = useRef<HTMLImageElement>(null);
  const star = useRef<HTMLImageElement>(null);
  const pulse = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLDivElement>(null);
  const started = useRef(performance.now());
  const leaving = useRef(false);
  const spin = useRef<gsap.core.Tween | null>(null);
  const finale = useRef<gsap.core.Timeline | null>(null);
  const ticking = useRef<(() => void) | null>(null);
  const cinematic = INTRO_MODE === 'cinematic';

  // The loads the opening itself makes, and the coin's entrance and turn.
  useEffect(() => {
    if (INTRO_MODE === 'none') return;
    track('fonts', document.fonts.ready);
    const img = new Image();
    img.src = emblemUrl;
    track('emblem', img.decode());
    const slowTimer = setTimeout(() => setSlow(true), SLOW_MS);
    if (!cinematic || !coin.current || !wrap.current) return () => clearTimeout(slowTimer);
    gsap.set(wrap.current, { xPercent: -50, yPercent: -50 });
    gsap.fromTo(
      coin.current,
      { opacity: 0, scale: 0.86, rotationY: -70 },
      { opacity: 1, scale: 1, rotationY: 0, duration: 1.1, ease: 'power3.out' },
    );
    // The pace of this device, read while the coin turns: a slow one gets a lighter flight.
    void measureFrames(1500);
    const light = () => lightCoin(coin.current, sheen.current);
    spin.current = gsap.to(coin.current, {
      rotationY: '+=360',
      duration: TURN_S,
      ease: 'none',
      repeat: -1,
      delay: 1.1,
      onUpdate: light,
    });
    return () => {
      clearTimeout(slowTimer);
      spin.current?.kill();
      finale.current?.kill();
      if (ticking.current) gsap.ticker.remove(ticking.current);
    };
  }, [cinematic]);

  // Sit the coin over the Sun as soon as the solar system is on the stage, so the ring lands on the Earth's orbit.
  useEffect(() => {
    if (!cinematic) return;
    const place = (solar: ReturnType<typeof useStage.getState>['solar']) => {
      if (!solar || !wrap.current || leaving.current) return;
      const sun = solar.projectBody('sun');
      const quick = performance.now() - started.current < 400;
      gsap.to(wrap.current, {
        x: sun.x - window.innerWidth / 2,
        y: sun.y - window.innerHeight / 2,
        duration: quick ? 0 : 0.9,
        ease: 'power2.inOut',
      });
    };
    place(useStage.getState().solar);
    return useStage.subscribe((s, before) => {
      if (s.solar !== before.solar) place(s.solar);
    });
  }, [cinematic]);

  // Open once everything counted has settled and the coin has had its time, or when it has waited too long.
  useEffect(() => {
    if (phase !== 'loading') return;
    const elapsed = performance.now() - started.current;
    const settled = allSettled(tasks) && tasks.view !== undefined;
    const wait = settled ? Math.max(0, MIN_MS - elapsed) : Math.max(0, GIVE_UP_MS - elapsed);
    const timer = setTimeout(() => leave(!settled || Object.values(tasks).includes('failed')), wait);
    return () => clearTimeout(timer);
  });

  function finish() {
    if (ticking.current) gsap.ticker.remove(ticking.current);
    ticking.current = null;
    useStage.getState().solar?.endIntro();
    markIntroSeen();
    useBoot.getState().open();
    setPhase('gone');
  }

  /** Hands the screen to the app; `plain` skips the flight, as when something failed or the wait ran out. */
  function leave(plain: boolean) {
    if (leaving.current) return;
    leaving.current = true;
    setPhase('leaving');
    const solar = useStage.getState().solar;
    const toSolar = cinematic && !plain && useApp.getState().view === 'solar' && solar !== null;
    if (!cinematic || !coin.current) {
      gsap.to(root.current, { opacity: 0, duration: 0.45, ease: 'power1.out', onComplete: finish });
      return;
    }
    // Let the coin finish its turn and come to rest facing you, then open.
    spin.current?.kill();
    const now = Number(gsap.getProperty(coin.current, 'rotationY'));
    let rest = Math.ceil(now / 360) * 360;
    if (rest - now < 50) rest += 360;
    gsap.to(coin.current, {
      rotationY: rest,
      duration: 0.4 + ((rest - now) / 360) * 0.9,
      ease: 'power3.out',
      onUpdate: () => lightCoin(coin.current, sheen.current),
      onComplete: () => (toSolar ? flyIn() : rushPast()),
    });
  }

  function centre(): Point {
    const x = Number(gsap.getProperty(wrap.current, 'x')) || 0;
    const y = Number(gsap.getProperty(wrap.current, 'y')) || 0;
    return { x: window.innerWidth / 2 + x, y: window.innerHeight / 2 + y };
  }

  /** Lifts the lander, star and ring off the coin, exactly where they are drawn on it. */
  function detach() {
    const parts = partsAt(centre());
    for (const [el, b] of [
      [lander.current, parts.lander],
      [star.current, parts.star],
    ] as const) {
      if (el) gsap.set(el, { x: b.x, y: b.y, width: b.w, height: b.h, opacity: 1, transformOrigin: '50% 50%' });
    }
    ring.current?.setAttribute('d', pathOf(circle(parts.ring, RING_PX)));
    ring.current?.setAttribute('stroke-width', parts.ringWidth.toFixed(1));
    gsap.set(ring.current, { opacity: 1 });
    gsap.set(root.current, { pointerEvents: 'none' });
    return parts;
  }

  /** The flight into the solar system: the coin rushes past, the ring becomes the orbit, the lander goes to the Moon. */
  function flyIn() {
    const parts = detach();
    const start = { x: parts.lander.x + parts.lander.w / 2, y: parts.lander.y + parts.lander.h / 2 };
    const from = circle(parts.ring, RING_PX);
    const k = { cam: 0, ring: 0, fly: 0 };
    ticking.current = () => {
      const solar = useStage.getState().solar;
      if (!solar) return;
      solar.setIntroProgress(k.cam);
      const orbit = solar.projectOrbit('earth', RING_POINTS);
      if (orbit.length === RING_POINTS)
        ring.current?.setAttribute('d', pathOf(from.map((p, i) => lerp(p, orbit[i], k.ring))));
      ring.current?.setAttribute('stroke-width', (parts.ringWidth + (1.5 - parts.ringWidth) * k.ring).toFixed(2));
      // The lander arcs up and over to wherever the Moon is on screen this frame.
      const moon = solar.projectBody('moon');
      const end = { x: moon.x, y: moon.y };
      const lift = {
        x: (start.x + end.x) / 2,
        y: Math.min(start.y, end.y) - 0.45 * Math.hypot(end.x - start.x, end.y - start.y),
      };
      const a = lerp(start, lift, k.fly);
      const b = lerp(lift, end, k.fly);
      const at = lerp(a, b, k.fly);
      gsap.set(lander.current, {
        x: at.x - parts.lander.w / 2,
        y: at.y - parts.lander.h / 2,
        scale: 1 - 0.95 * k.fly,
        rotation: -14 * Math.sin(Math.PI * k.fly),
      });
      if (pulse.current) gsap.set(pulse.current, { x: end.x, y: end.y });
    };
    gsap.ticker.add(ticking.current);
    finale.current = gsap
      .timeline({ onComplete: finish })
      .to(
        coin.current,
        { scale: 2.2, opacity: 0, filter: perf.low ? 'none' : 'blur(8px)', duration: 0.8, ease: 'power1.in' },
        0.1,
      )
      .to(field.current, { opacity: 0, duration: 1.5, ease: 'power1.inOut' }, 0.2)
      .to(status.current, { opacity: 0, duration: 0.4 }, 0)
      .to(k, { ring: 1, duration: 0.8, ease: 'power2.inOut' }, 0.15)
      .to(k, { cam: 1, duration: 2.7, ease: 'power3.inOut' }, 0.1)
      .to(star.current, { x: '+=220', y: '-=110', scaleX: 1.6, opacity: 0, duration: 0.9, ease: 'power2.in' }, 0.2)
      .to(k, { fly: 1, duration: 2.1, ease: 'power2.inOut' }, 0.35)
      .to(lander.current, { opacity: 0, duration: 0.25 }, 2.3)
      .fromTo(
        pulse.current,
        { opacity: 1, scale: 0.2 },
        { opacity: 0, scale: 2.4, duration: 0.9, ease: 'power2.out' },
        2.3,
      )
      .to(ring.current, { opacity: 0, duration: 0.9, ease: 'power1.in' }, 2.0);
  }

  /** The opening for any other first view: the coin rushes past and the lander lifts away. */
  function rushPast() {
    const parts = detach();
    const r = { v: RING_PX };
    finale.current = gsap
      .timeline({ onComplete: finish })
      .to(
        coin.current,
        { scale: 2.6, opacity: 0, filter: perf.low ? 'none' : 'blur(8px)', duration: 1, ease: 'power2.in' },
        0.05,
      )
      .to(field.current, { opacity: 0, duration: 1.2, ease: 'power1.inOut' }, 0.2)
      .to(status.current, { opacity: 0, duration: 0.3 }, 0)
      .to(
        r,
        {
          v: Math.hypot(window.innerWidth, window.innerHeight),
          duration: 1.2,
          ease: 'power2.in',
          onUpdate: () => ring.current?.setAttribute('d', pathOf(circle(parts.ring, r.v))),
        },
        0.05,
      )
      .to(ring.current, { opacity: 0, duration: 0.8 }, 0.45)
      .to(star.current, { x: '+=220', y: '-=110', opacity: 0, duration: 0.8, ease: 'power2.in' }, 0.1)
      .to(lander.current, { y: '-=260', scale: 0.4, opacity: 0, duration: 1.1, ease: 'power2.in' }, 0.15);
  }

  // Esc skips; so does the button, which appears once the coin has turned a little.
  useEffect(() => {
    if (phase === 'gone') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && skip();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function skip() {
    spin.current?.kill();
    finale.current?.kill();
    leaving.current = true;
    gsap.to(root.current, { opacity: 0, duration: 0.25, onComplete: finish });
  }

  if (phase === 'gone') return null;
  const shown = ORDER.filter((task) => tasks[task] !== undefined);
  const pending = firstPending(tasks);
  const pendingText =
    pending === 'view' ? t(`intro.view.${useApp.getState().view}`) : pending ? t(`intro.task.${pending}`) : '';

  return (
    // The parts move to places on the page worked out from the 3D view, so the stage never mirrors.
    <div ref={root} className="intro fixed inset-0 z-50 overflow-hidden" data-testid="intro" dir="ltr">
      <div ref={field} className="intro-field absolute inset-0" />
      <div ref={wrap} className="absolute start-1/2 top-1/2" style={{ perspective: '1100px' }}>
        <div
          ref={coin}
          className="intro-coin relative"
          style={{ width: COIN_PX, height: COIN_PX, opacity: cinematic ? 0 : 1 }}
          aria-hidden="true"
        >
          {cinematic &&
            Array.from({ length: 6 }, (_, i) => (
              // The coin's milled edge: stacked rims that show as a gold band when it turns side-on.
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed stack of identical rims.
              <span key={i} className="intro-rim" style={{ transform: `translateZ(${(i - 2.5) * 1.4}px)` }} />
            ))}
          <img src={emblemUrl} alt="" className="intro-face" draggable={false} />
          {cinematic && <img src={emblemUrl} alt="" className="intro-face intro-back" draggable={false} />}
          {/* Shade and a band of light over the face, moved by opacity and transform alone. */}
          <div className="intro-light">
            <span className="intro-shade" />
            <span ref={sheen} className="intro-band" />
          </div>
        </div>
      </div>
      <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
        <path ref={ring} fill="none" stroke={GOLD} strokeLinejoin="round" opacity="0" />
      </svg>
      <img ref={star} src={starUrl} alt="" aria-hidden="true" className="intro-part" draggable={false} />
      <img ref={lander} src={landerUrl} alt="" aria-hidden="true" className="intro-part" draggable={false} />
      <div ref={pulse} className="intro-pulse" aria-hidden="true" />
      <div
        ref={status}
        className="absolute inset-x-0 bottom-[12vh] flex flex-col items-center gap-3 px-4 text-center"
        role="status"
        dir={i18n.dir()}
      >
        <span className="sr-only">{t('intro.loading')}</span>
        <ol className="flex gap-2" aria-label={t('intro.progress')}>
          {shown.map((task) => (
            <li
              key={task}
              className={`intro-dot ${tasks[task] === 'done' ? 'is-done' : tasks[task] === 'failed' ? 'is-failed' : ''}`}
            >
              <span className="sr-only">
                {t(task === 'view' ? `intro.view.${useApp.getState().view}` : `intro.task.${task}`)}:{' '}
                {t(`intro.state.${tasks[task]}`)}
              </span>
            </li>
          ))}
        </ol>
        <p
          className={`min-h-5 text-sm text-quiet transition-opacity duration-700 ${slow && pending ? 'opacity-100' : 'opacity-0'}`}
        >
          {slow && pending ? t('intro.slow', { what: pendingText }) : ''}
        </p>
      </div>
      {phase === 'loading' && (
        <button
          type="button"
          onClick={skip}
          className="intro-skip absolute inset-e-5 bottom-5 min-h-11 rounded-pill px-4 text-sm text-quiet hover:text-ink"
        >
          {t('intro.skip')}
        </button>
      )}
    </div>
  );
}
