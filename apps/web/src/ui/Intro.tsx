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
import { setSoundOn, sound, useSound } from '../sound';
import { useStage } from '../stage';
import { useApp } from '../store';
import { Speaker } from './SoundToggle';

/** The emblem turns at least this long, so a quick load still gets its moment. */
const MIN_MS = 1700;
/** After this, a quiet line says what is still loading. */
const SLOW_MS = 4500;
/** After this the app opens anyway, and each view shows its own progress. */
const GIVE_UP_MS = 25_000;
/** Asked to tap and not answered: it opens after this long anyway, quietly. */
const ASK_MS = 10_000;
/** After the tap, how long the reveal waits for the sound (which loads on that tap) so they start together. */
const SOUND_WAIT_MS = 1200;
/** GSAP's power2.inOut, for the browser's own glide. */
const POWER2_IN_OUT = 'cubic-bezier(0.45, 0, 0.55, 1)';
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

/** The opening's field and coin, which index.html draws and starts turning before this code has loaded. */
const splash = typeof document === 'undefined' ? null : document.getElementById('splash');
const inSplash = <T extends Element>(selector: string): T | null => splash?.querySelector<T>(selector) ?? null;

/** How far the coin has turned, in degrees, since it came to face you; index.html names its turn `coin-turn`. */
function turnedDeg(coin: HTMLElement): number {
  const turn = coin.getAnimations().find((a) => a.id === 'coin-turn');
  const timing = turn?.effect?.getComputedTiming();
  if (!timing || timing.progress == null) return 0;
  return ((timing.currentIteration ?? 0) + timing.progress) * 360;
}

/** The fonts' stylesheet loads alongside the first paint (see index.html); the fonts it names are ready after it. */
function fontsReady(): Promise<unknown> {
  const link = document.getElementById('fonts-css') as HTMLLinkElement | null;
  const sheet =
    link && !link.sheet
      ? new Promise((done) => {
          link.addEventListener('load', done, { once: true });
          link.addEventListener('error', done, { once: true });
        })
      : Promise.resolve();
  // A frame after the stylesheet applies, the page has asked for the fonts it shows.
  return sheet.then(() => new Promise((done) => requestAnimationFrame(done))).then(() => document.fonts.ready);
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

/** The share of the counted loads that have settled, 0 to 1: the dots under the emblem, as a number. */
function loadShare(tasks: Partial<Record<BootTask, string>>): number {
  const counted = ORDER.filter((task) => tasks[task] !== undefined);
  return counted.length ? counted.filter((task) => tasks[task] !== 'pending').length / counted.length : 0;
}

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
  const soundOn = useSound((s) => s.on);
  const soundReady = useSound((s) => s.ready);
  const hearing = soundOn && soundReady;
  const progress = loadShare(tasks);
  // Ready and waiting for the one tap that lets it open with sound (browsers allow no sound before a tap).
  const [asking, setAsking] = useState(false);
  const askingNow = useRef(false);
  askingNow.current = asking;
  const tapped = useRef(false);
  const entering = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef(inSplash<HTMLDivElement>('.intro-field'));
  const wrap = useRef(inSplash<HTMLDivElement>('.intro-wrap'));
  const coin = useRef(inSplash<HTMLDivElement>('.intro-coin'));
  const sheen = useRef(inSplash<HTMLSpanElement>('.intro-band'));
  const ring = useRef<SVGPathElement>(null);
  const lander = useRef<HTMLImageElement>(null);
  const star = useRef<HTMLImageElement>(null);
  const pulse = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLDivElement>(null);
  // Times count from the page's start, when the coin first showed.
  const started = useRef(0);
  const leaving = useRef(false);
  const slide = useRef<Animation | null>(null);
  const finale = useRef<gsap.core.Timeline | null>(null);
  const ticking = useRef<(() => void) | null>(null);
  const cinematic = INTRO_MODE === 'cinematic';

  // The loads the opening itself waits for. The coin is already turning: index.html started it.
  useEffect(() => {
    if (INTRO_MODE === 'none') return;
    track('fonts', fontsReady());
    const face = inSplash<HTMLImageElement>('.intro-face') ?? Object.assign(new Image(), { src: emblemUrl });
    track('emblem', face.decode());
    const slowTimer = setTimeout(() => setSlow(true), Math.max(0, SLOW_MS - performance.now()));
    if (cinematic && wrap.current) {
      // GSAP moves the coin from here on, starting from the middle of the page, where index.html put it.
      gsap.set(wrap.current, { xPercent: -50, yPercent: -50, x: 0, y: 0 });
      // The pace of this device, read while the coin turns: a slow one gets a lighter flight.
      void measureFrames(1500);
    }
    return () => {
      clearTimeout(slowTimer);
      slide.current?.cancel();
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
      // Straight there while the coin cannot be seen yet; a glide once it can.
      const quick = !coin.current || Number(getComputedStyle(coin.current).opacity) < 0.02;
      // GSAP keeps where the coin is going; the browser glides it there on the compositor, like the turn.
      const from = getComputedStyle(wrap.current).transform;
      gsap.set(wrap.current, { x: sun.x - window.innerWidth / 2, y: sun.y - window.innerHeight / 2 });
      slide.current?.cancel();
      slide.current = quick
        ? null
        : wrap.current.animate([{ transform: from }, { transform: getComputedStyle(wrap.current).transform }], {
            duration: 900,
            easing: POWER2_IN_OUT,
          });
    };
    place(useStage.getState().solar);
    return useStage.subscribe((s, before) => {
      if (s.solar !== before.solar) place(s.solar);
    });
  }, [cinematic]);

  // Open once everything counted has settled and the coin has had its time, or when it has waited too long. Someone
  // who has tapped already, or has the sound off, goes straight in; anyone else is asked for the tap that opens it with
  // sound.
  useEffect(() => {
    if (phase !== 'loading' || asking) return;
    const elapsed = performance.now() - started.current;
    const settled = allSettled(tasks) && tasks.view !== undefined;
    const failed = Object.values(tasks).includes('failed');
    const wait = settled ? Math.max(0, MIN_MS - elapsed) : Math.max(0, GIVE_UP_MS - elapsed);
    const timer = setTimeout(() => {
      if (!settled || failed || tapped.current || !useSound.getState().on) leave(!settled || failed);
      else setAsking(true);
    }, wait);
    return () => clearTimeout(timer);
  });

  // Asked and not answered: it opens anyway after a while, quietly, so no one is left waiting at a closed door.
  useEffect(() => {
    if (!asking || phase !== 'loading') return;
    const timer = setTimeout(() => leave(false), ASK_MS);
    return () => clearTimeout(timer);
  });

  // Any tap or key press during the opening counts (Escape skips it instead).
  useEffect(() => {
    if (phase !== 'loading') return;
    const onKey = (e: KeyboardEvent) => e.key !== 'Escape' && enter();
    window.addEventListener('click', enter);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', enter);
      window.removeEventListener('keydown', onKey);
    };
  });

  // The glint: each time the turning emblem comes round to face you, the light catches it. Timed from the coin's own
  // animation and played on the audio clock, so a busy page cannot pull it off the picture.
  useEffect(() => {
    if (phase !== 'loading' || !hearing || !cinematic || !coin.current) return;
    const turn = coin.current.getAnimations().find((a) => a.id === 'coin-turn');
    const timing = turn?.effect?.getTiming();
    if (!turn || turn.startTime === null || !timing) return;
    const firstMs = Number(turn.startTime) + Number(timing.delay ?? 0);
    const periodMs = Number(timing.duration);
    let planned = Number.NaN;
    const plan = () => {
      const nowMs = Number(document.timeline.currentTime ?? performance.now());
      const nextMs = firstMs + Math.max(0, Math.ceil((nowMs - firstMs) / periodMs)) * periodMs;
      if (nextMs !== planned && nextMs - nowMs < 700) {
        planned = nextMs;
        sound.intro.glint((nextMs - nowMs) / 1000);
      }
    };
    plan();
    const timer = setInterval(plan, 250);
    return () => clearInterval(timer);
  }, [phase, hearing, cinematic]);

  // The hum under the turning emblem. It starts once a tap or key press has let the page make sound (the button below
  // is there for it), and builds with the same loads as the dots.
  useEffect(() => {
    if (phase === 'loading' && hearing) sound.drone.start(progress);
  }, [phase, hearing, progress]);

  /** The tap: during loading it is noted (the opening goes on when the data is in); when asked, it opens. */
  function enter() {
    tapped.current = true;
    if (!askingNow.current || entering.current) return;
    entering.current = true;
    setAsking(false);
    // The sound loads on this very tap; give it a moment so the reveal and its sounds begin together.
    const go = () => leave(false);
    if (!useSound.getState().on || useSound.getState().ready) return go();
    const timer = setTimeout(go, SOUND_WAIT_MS);
    const stop = useSound.subscribe((st) => {
      if (!st.ready) return;
      clearTimeout(timer);
      stop();
      go();
    });
  }

  function finish() {
    sound.drone.stop();
    if (ticking.current) gsap.ticker.remove(ticking.current);
    ticking.current = null;
    useStage.getState().solar?.endIntro();
    markIntroSeen();
    splash?.remove();
    useBoot.getState().open();
    setPhase('gone');
  }

  /** Hands the screen to the app; `plain` skips the flight, as when something failed or the wait ran out. */
  function leave(plain: boolean) {
    if (leaving.current) return;
    leaving.current = true;
    setPhase('leaving');
    // The hum swells into the reveal and fades out over the flight.
    sound.drone.swell();
    const solar = useStage.getState().solar;
    const toSolar = cinematic && !plain && useApp.getState().view === 'solar' && solar !== null;
    if (!cinematic || !coin.current) {
      sound.intro.reveal('fade');
      gsap.to(layers(), { opacity: 0, duration: 0.45, ease: 'power1.out', onComplete: finish });
      return;
    }
    // GSAP takes the turning coin over from the page's own animation exactly where it is, every part of its turn named
    // so none is read back from the animated matrix, then lets it finish its turn and come to rest facing you.
    const now = turnedDeg(coin.current);
    gsap.set(coin.current, {
      x: 0,
      y: 0,
      z: 0,
      rotationX: 0,
      rotationZ: 0,
      skewX: 0,
      skewY: 0,
      scale: 1,
      opacity: 1,
      rotationY: now,
    });
    lightCoin(coin.current, sheen.current);
    for (const a of coin.current.getAnimations({ subtree: true })) a.cancel();
    let rest = Math.ceil(now / 360) * 360;
    if (rest - now < 50) rest += 360;
    gsap.to(coin.current, {
      rotationY: rest,
      duration: 0.5 + ((rest - now) / 360) * 1.2,
      ease: 'power3.out',
      onUpdate: () => lightCoin(coin.current, sheen.current),
      onComplete: () => (toSolar ? flyIn() : rushPast()),
    });
  }

  /** The opening's two layers: the splash's field and coin, and this overlay with the parts, dots and button. */
  function layers(): HTMLElement[] {
    return [root.current, splash].filter((el): el is HTMLElement => el !== null);
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
    gsap.set(layers(), { pointerEvents: 'none' });
    return parts;
  }

  /** The flight into the solar system: the coin rushes past, the ring becomes the orbit, the lander goes to the Moon. */
  function flyIn() {
    sound.intro.reveal('flight');
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
    sound.intro.reveal('rush');
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
    sound.drone.stop();
    finale.current?.kill();
    leaving.current = true;
    gsap.to(layers(), { opacity: 0, duration: 0.25, onComplete: finish });
  }

  if (phase === 'gone') return null;
  const shown = ORDER.filter((task) => tasks[task] !== undefined);
  const pending = firstPending(tasks);
  const pendingText =
    pending === 'view' ? t(`intro.view.${useApp.getState().view}`) : pending ? t(`intro.task.${pending}`) : '';

  return (
    // The parts move to places on the page worked out from the 3D view, so the stage never mirrors.
    <div ref={root} className="intro fixed inset-0 z-50 overflow-hidden" data-testid="intro" dir="ltr">
      {/* The field and the coin are underneath, in index.html (#splash), so they show from the first paint. */}
      <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
        <path ref={ring} fill="none" stroke={GOLD} strokeLinejoin="round" opacity="0" />
      </svg>
      <img ref={star} src={starUrl} alt="" aria-hidden="true" className="intro-part" draggable={false} />
      <img ref={lander} src={landerUrl} alt="" aria-hidden="true" className="intro-part" draggable={false} />
      <div ref={pulse} className="intro-pulse" aria-hidden="true" />
      {asking && (
        <div className="absolute inset-x-0 bottom-[12vh] flex justify-center px-4" dir={i18n.dir()}>
          <button
            type="button"
            // biome-ignore lint/a11y/noAutofocus: it is the one thing to do on this screen, and Enter presses it.
            autoFocus
            onClick={enter}
            className="intro-enter flex min-h-12 items-center gap-2.5 rounded-pill px-6 text-[15px] text-ink"
          >
            <Speaker on={soundOn} />
            {t('intro.enter')}
          </button>
        </div>
      )}
      <div
        ref={status}
        className={`absolute inset-x-0 bottom-[12vh] flex flex-col items-center gap-3 px-4 text-center ${asking ? 'invisible' : ''}`}
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
          aria-pressed={soundOn}
          onClick={() => setSoundOn(!soundOn)}
          className="intro-skip absolute inset-s-5 bottom-5 flex min-h-11 items-center gap-2 rounded-pill px-4 text-sm text-quiet hover:text-ink"
        >
          <Speaker on={soundOn} />
          {t(soundOn ? 'intro.soundOn' : 'intro.soundOff')}
        </button>
      )}
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
