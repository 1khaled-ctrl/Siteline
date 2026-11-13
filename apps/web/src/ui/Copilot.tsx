import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Confidence, confidenceOf, type Reading } from '../confidence';
import { type Aspect, type Intent, parseIntent, type SiteSummary, summarize, type Target } from '../copilot';
import { formatNumber, formatUtc } from '../format';
import { findLander, MISSIONS } from '../landers';
import { physics, queryFor, URLS } from '../physics';
import { type MoonView, useApp } from '../store';
import { CHECK_KEYS } from '../verdict';
import { Spinner } from './ViewStatus';

interface Message {
  id: number;
  from: 'you' | 'siteline';
  text: string;
  /** The tool call behind a reply, shown so it is clear what was looked up. */
  call?: string;
  sources?: string[];
}

const NAMES = MISSIONS.map((m) => ({ id: m.id, name: m.name }));
const VIEW_OF: Record<Target, MoonView> = { solar: 'solar', earth: 'earth', mars: 'mars', moon: 'globe', pole: 'pole' };
const EXAMPLES = ['example1', 'example2', 'example3', 'example6', 'example4', 'example5'];
const READINGS: Reading[] = ['zone', 'sun', 'earth', 'height', 'longTerm', 'slope'];
const CONFIDENCE_LEVELS: Confidence[] = ['high', 'firstPass', 'flatHorizon', 'notMeasured'];

const callText = (intent: Intent) =>
  intent.tool === 'help'
    ? ''
    : `${intent.tool}(${Object.entries(intent.input)
        .map(([k, v]) => `${k}: "${v}"`)
        .join(', ')})`;

/**
 * A small chat over the 3D view. It can fly the view, open a mission's card, and answer questions about the selected
 * Moon landing site from the same check the site report runs. It never writes data and calls no outside service.
 */
export function Copilot() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Message[]>([]);
  const next = useRef(1);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message is what scrolls the log down.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  const say = (m: Omit<Message, 'id'>) => setLog((l) => [...l, { ...m, id: next.current++ }]);

  const place = (s: { latDeg: number; lonDeg: number }) =>
    t('share.place', {
      lat: formatNumber(Math.abs(s.latDeg), 2),
      northSouth: s.latDeg < 0 ? t('landers.south') : t('landers.north'),
      lon: formatNumber(Math.abs(s.lonDeg), 2),
      eastWest: s.lonDeg < 0 ? t('landers.west') : t('landers.east'),
    });

  const answer = (aspect: Aspect, s: SiteSummary): string => {
    const pct = (v: number) => formatNumber(v, 0);
    const head = t('copilot.site', { place: place(s), date: formatUtc(s.landingUtc) });
    const failed = CHECK_KEYS.filter((k) => s.checks[k] === 'no').map((k) => t(`copilot.checkNames.${k}`));
    const unknown = CHECK_KEYS.filter((k) => s.checks[k] === 'unknown').map((k) => t(`copilot.checkNames.${k}`));
    const verdict = t(`copilot.verdict.${s.verdict}`, { failed: failed.join(', '), unknown: unknown.join(', ') });
    const problem = s.problem
      ? s.problem.atLanding
        ? t(`compare.atLanding.${s.problem.key}`)
        : `${t(`compare.problem.${s.problem.key}`)}${s.problem.atUtc ? ` ${formatUtc(s.problem.atUtc)}` : ''}`
      : undefined;
    const when = (iso: string | undefined) => (iso ? formatUtc(iso) : t('report.none'));
    // The site report's confidence marks, grouped: which readings are solid and which are a first pass.
    const sure = {
      terrainM: s.terrainKm !== undefined ? s.terrainKm * 1000 : undefined,
      longTermM: s.longTerm?.resolutionM,
    };
    const confidence = CONFIDENCE_LEVELS.map((level) => {
      const names = READINGS.filter((r) => confidenceOf(r, sure) === level).map((r) => t(`copilot.readingNames.${r}`));
      return names.length ? t(`copilot.confidenceLevels.${level}`, { list: names.join(', ') }) : '';
    }).filter(Boolean);
    const lines: Record<Aspect, string[]> = {
      confidence: [head, ...confidence],
      verdict: [head, verdict],
      why: [head, problem ? t('copilot.firstProblem', { problem }) : t('copilot.noProblem'), verdict],
      sun: [head, t('copilot.sun', { pct: pct(s.sunMinPct) }), t('copilot.nextSunset', { at: when(s.next.sunset) })],
      earth: [
        head,
        t('copilot.earth', { pct: pct(s.earthPct) }),
        t('copilot.nextEarthset', { at: when(s.next.earthset) }),
      ],
      slope: [
        head,
        s.checks.slope === 'unknown'
          ? s.terrainKm !== undefined
            ? t('copilot.slopeUnknown', { km: formatNumber(s.terrainKm) })
            : t('copilot.slopeNoTerrain')
          : t(`copilot.slope.${s.checks.slope}`),
      ],
      height: [
        head,
        s.groundHeightM !== undefined
          ? t('copilot.height', { m: formatNumber(s.groundHeightM, 0) })
          : t('copilot.heightNone'),
      ],
      longTerm: [
        head,
        s.longTerm
          ? t('copilot.longTerm', {
              sun: pct(s.longTerm.sunPct),
              earth: pct(s.longTerm.earthPct),
              shadow: s.longTerm.shadowed ? t('copilot.shadowed') : '',
            })
          : t('copilot.longTermNone'),
      ],
      events: [
        head,
        t('copilot.events', {
          sunset: when(s.next.sunset),
          sunrise: when(s.next.sunrise),
          earthset: when(s.next.earthset),
          earthrise: when(s.next.earthrise),
        }),
      ],
      summary: [
        head,
        verdict,
        t('copilot.sun', { pct: pct(s.sunMinPct) }),
        t('copilot.earth', { pct: pct(s.earthPct) }),
        ...(s.longTerm
          ? [t('copilot.longTerm', { sun: pct(s.longTerm.sunPct), earth: pct(s.longTerm.earthPct), shadow: '' })]
          : []),
        ...(problem ? [t('copilot.firstProblem', { problem })] : []),
      ],
    };
    return lines[aspect].join(' ');
  };

  const run = async (message: string) => {
    const intent = parseIntent(message, NAMES);
    const call = callText(intent) || undefined;
    if (intent.tool === 'help') return say({ from: 'siteline', text: t('copilot.help') });
    if (intent.tool === 'fly_to') {
      useApp.getState().set({ view: VIEW_OF[intent.input.target] });
      return say({
        from: 'siteline',
        call,
        text: t('copilot.flying', { place: t(`copilot.places.${intent.input.target}`) }),
      });
    }
    if (intent.tool === 'show_mission') {
      const m = findLander(intent.input.id);
      useApp.getState().selectMission(intent.input.id);
      return say({ from: 'siteline', call, text: t('copilot.mission', { name: m?.name ?? intent.input.id }) });
    }
    // analyze_site: the same check, on the same inputs, that the site report shows.
    const { latDeg, lonDeg, landingUtc, slipDays } = useApp.getState();
    const query = queryFor({ latDeg, lonDeg }, landingUtc, slipDays);
    try {
      const s = summarize(await physics.stay(query, URLS), { latDeg, lonDeg }, query.landingUtc);
      say({ from: 'siteline', call, text: answer(intent.input.aspect, s), sources: s.sources });
    } catch (e) {
      say({
        from: 'siteline',
        call,
        text: t('copilot.failed', { message: e instanceof Error ? e.message : String(e) }),
      });
    }
  };

  const send = async (message: string) => {
    const m = message.trim();
    if (!m || busy) return;
    setText('');
    say({ from: 'you', text: m });
    setBusy(true);
    await run(m);
    setBusy(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed inset-e-4 bottom-4 z-20 min-h-10 rounded-pill border border-accent/60 bg-panel/95 px-4 text-sm text-ink shadow-lg hover:border-accent lg:absolute lg:inset-e-auto lg:inset-s-3 lg:bottom-14"
      >
        <span aria-hidden="true">✦ </span>
        {t('copilot.open')}
      </button>
    );

  return (
    <section
      aria-label={t('copilot.title')}
      className="fixed inset-x-3 bottom-3 z-30 flex h-[min(520px,75dvh)] flex-col gap-2 rounded-xl border border-line bg-panel p-3 shadow-2xl lg:absolute lg:inset-x-auto lg:inset-s-3 lg:bottom-14 lg:h-[min(520px,calc(100%-80px))] lg:w-[420px]"
      data-testid="copilot"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg">
          {t('copilot.title')}{' '}
          <span className="ms-1 rounded-pill border border-line px-2 py-0.5 align-middle font-sans text-[11px] font-normal text-quiet">
            {t('copilot.badge')}
          </span>
        </h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-8 rounded-md border border-line bg-panel-raised px-2.5 text-[12.5px] hover:border-line-hover"
        >
          {t('copilot.close')}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pe-1" aria-live="polite">
        {log.length === 0 && (
          <div className="flex flex-col gap-2 text-sm text-quiet">
            <p>{t('copilot.intro')}</p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => void send(t(`copilot.${k}`))}
                  className="min-h-8 rounded-pill border border-line bg-panel-raised px-3 text-[12.5px] text-ink hover:border-line-hover"
                >
                  {t(`copilot.${k}`)}
                </button>
              ))}
            </div>
          </div>
        )}
        {log.map((m) =>
          m.from === 'you' ? (
            <p key={m.id} className="max-w-[85%] self-end rounded-lg bg-accent/15 px-3 py-1.5 text-sm">
              {m.text}
            </p>
          ) : (
            <div
              key={m.id}
              className="max-w-[92%] self-start rounded-lg border border-line bg-panel-raised px-3 py-2 text-sm"
            >
              {m.call && (
                <p className="mb-1 font-mono text-[11.5px] text-quiet" dir="ltr">
                  ↳ {m.call}
                </p>
              )}
              <p>{m.text}</p>
              {m.sources && m.sources.length > 0 && (
                <p className="mt-1.5 text-xs text-quiet">
                  {t('report.sources')}:{' '}
                  {m.sources.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <button
                        type="button"
                        className="underline decoration-dotted underline-offset-2 hover:text-ink"
                        onClick={() => useApp.getState().setSources(id)}
                      >
                        {id}
                      </button>
                    </span>
                  ))}
                </p>
              )}
            </div>
          ),
        )}
        {busy && (
          <p className="flex items-center gap-2 self-start text-sm text-quiet">
            <Spinner /> {t('copilot.thinking')}
          </p>
        )}
        <div ref={end} />
      </div>

      <form onSubmit={submit} className="flex gap-1.5">
        <label htmlFor="copilot-input" className="sr-only">
          {t('copilot.inputLabel')}
        </label>
        <input
          id="copilot-input"
          ref={input}
          value={text}
          autoComplete="off"
          placeholder={t('copilot.placeholder')}
          onChange={(e) => setText(e.currentTarget.value)}
          className="min-h-9 min-w-0 flex-1 rounded-md border border-line bg-panel-sunk px-2.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="min-h-9 rounded-md border border-sun/60 bg-sun/15 px-3 text-sm text-sun-ink hover:border-sun disabled:opacity-50"
        >
          {t('copilot.send')}
        </button>
      </form>
      <p className="text-[11.5px] text-quiet">{t('copilot.note')}</p>
    </section>
  );
}
