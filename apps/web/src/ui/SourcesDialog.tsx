import { DEFAULT_STAY } from '@siteline/contracts';
import { ARTEMIS_ZONE_LAT_DEG, MAX_LANDING_SLOPE_DEG } from '@siteline/physics';
import { type MouseEvent, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CREDITS, FONTS_NOTE, LIBRARIES_NOTE, type Span, spans } from '../credits';
import { formatNumber } from '../format';
import { useApp } from '../store';
import { Checks } from './Checks';

/** Each step of the site check, and the datasets (CREDITS.md ids) it reads. */
const METHODS: { key: string; ids: string[] }[] = [
  { key: 'positions', ids: ['spice-de440s', 'spice-moon-pa', 'spice-moon-fk', 'spice-naif0012'] },
  { key: 'horizon', ids: ['lola-ldem-75s-240m'] },
  { key: 'sun', ids: [] },
  { key: 'earth', ids: [] },
  { key: 'slope', ids: ['lola-ldem-75s-240m'] },
  { key: 'zone', ids: [] },
  { key: 'longTerm', ids: ['landfall-polar-maps'] },
  { key: 'planets', ids: ['spice-de440s'] },
  { key: 'facts', ids: ['body-facts', 'spice-gm-de440'] },
];

const link = 'underline decoration-dotted underline-offset-2 hover:text-ink';

function Markdown({ text }: { text: string }) {
  return (
    <>
      {spans(text).map((s: Span, i) =>
        'code' in s ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the runs of one fixed string never reorder.
          <code key={i} className="rounded bg-panel-sunk px-1 font-mono text-[12px]">
            {s.code}
          </code>
        ) : 'url' in s ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above.
          <a key={i} href={s.url} target="_blank" rel="noreferrer" className={`${link} wrap-anywhere`}>
            {s.label}
          </a>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

/** A dataset id that jumps to its row in the list below. */
function IdChip({ id }: { id: string }) {
  return (
    <a
      href={`#src-${id}`}
      className="rounded-pill border border-line bg-panel-raised px-2 py-0.5 font-mono text-[11.5px] text-quiet hover:border-line-hover hover:text-ink"
    >
      {id}
    </a>
  );
}

/**
 * Everything a reviewer needs in one place: how each check works, how we tested it, and every dataset with its licence
 * and link, read straight from CREDITS.md so the two never disagree.
 */
export function SourcesDialog() {
  const open = useApp((s) => s.sources);
  const setSources = useApp((s) => s.setSources);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    if (typeof open === 'string') {
      const row = document.getElementById(`src-${open}`);
      row?.scrollIntoView({ block: 'center' });
      row?.focus({ preventScroll: true });
    }
  }, [open]);

  // A click on the dimmed backdrop lands on the dialog itself; one inside lands on its content.
  const backdrop = (e: MouseEvent) => e.target === ref.current && setSources(false);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes a modal dialog; the click is for the mouse.
    <dialog
      ref={ref}
      aria-labelledby="sources-title"
      onClose={() => setSources(false)}
      onClick={backdrop}
      className="m-auto max-h-[90dvh] w-[min(880px,calc(100%-24px))] overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink backdrop:bg-black/65"
    >
      {open && <SourcesBody />}
    </dialog>
  );
}

/** The dialog's content, built only while it is open. */
function SourcesBody() {
  const { t } = useTranslation();
  const open = useApp((s) => s.sources);
  const setSources = useApp((s) => s.setSources);
  const values = {
    days: formatNumber(DEFAULT_STAY.stayDays),
    pct: formatNumber(DEFAULT_STAY.minSunFraction * 100, 0),
    rule: t(`sources.earthRule.${DEFAULT_STAY.earthRule}`),
    deg: formatNumber(MAX_LANDING_SLOPE_DEG, 0),
    lat: formatNumber(ARTEMIS_ZONE_LAT_DEG, 0).replace('-', '−'),
  };

  return (
    <div className="flex max-h-[90dvh] flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 id="sources-title" className="text-2xl">
          {t('sources.title')}
        </h2>
        <button
          type="button"
          onClick={() => setSources(false)}
          className="min-h-9 rounded-md border border-line bg-panel-raised px-3 text-sm hover:border-line-hover"
        >
          {t('sources.close')}
        </button>
      </div>
      <div className="flex flex-col gap-6 overflow-y-auto px-5 py-4 text-sm" data-testid="sources">
        <p className="text-quiet">{t('sources.intro')}</p>

        <section>
          <h3 className="mb-2 text-lg">{t('sources.methodsHeading')}</h3>
          <ol className="flex flex-col gap-2">
            {METHODS.map((m) => (
              <li key={m.key} className="rounded-lg border border-line bg-panel-raised px-3 py-2">
                <p>{t(`sources.methods.${m.key}`, values)}</p>
                {m.ids.length > 0 && (
                  <p className="mt-1.5 flex flex-wrap gap-1.5" dir="ltr">
                    {m.ids.map((id) => (
                      <IdChip key={id} id={id} />
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h3 className="mb-2 text-lg">{t('sources.checksHeading')}</h3>
          <Checks open />
        </section>

        <section>
          <h3 className="mb-2 text-lg">{t('sources.data', { n: CREDITS.length })}</h3>
          <ul className="flex flex-col gap-2">
            {CREDITS.map((c) => (
              <li
                key={c.id}
                id={`src-${c.id}`}
                tabIndex={-1}
                className={`scroll-mt-4 rounded-lg border px-3 py-2 outline-none ${open === c.id ? 'border-accent' : 'border-line'}`}
              >
                <p className="font-mono text-[12.5px] text-accent" dir="ltr">
                  {c.id}
                </p>
                <p className="mt-1">
                  <Markdown text={c.what} />
                </p>
                <dl className="mt-1.5 grid gap-x-3 gap-y-0.5 text-xs text-quiet sm:grid-cols-[auto_1fr]">
                  <dt>{t('sources.licence')}</dt>
                  <dd className="font-sans">
                    <Markdown text={c.licence} />
                  </dd>
                  <dt>{t('sources.source')}</dt>
                  <dd className="font-sans">
                    <Markdown text={c.source} />
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        </section>

        <section className="text-xs text-quiet">
          <h3 className="mb-1 text-base text-ink">{t('sources.fonts')}</h3>
          <p>
            <Markdown text={FONTS_NOTE} />
          </p>
          <h3 className="mt-3 mb-1 text-base text-ink">{t('sources.libraries')}</h3>
          <p>
            <Markdown text={LIBRARIES_NOTE} />
          </p>
          <p className="mt-3">{t('sources.more')}</p>
        </section>
      </div>
    </div>
  );
}

/** The header's way in. */
export function SourcesButton() {
  const { t } = useTranslation();
  const setSources = useApp((s) => s.setSources);
  return (
    <button
      type="button"
      onClick={() => setSources(true)}
      className="min-h-8 rounded-md border border-line bg-panel-raised px-2.5 text-[12.5px] hover:border-line-hover"
    >
      <span className="max-sm:hidden">{t('sources.open')}</span>
      <span className="sm:hidden">{t('sources.openShort')}</span>
    </button>
  );
}
