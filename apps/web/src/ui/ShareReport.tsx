import type { StayQuery } from '@siteline/contracts';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { confidenceOf } from '../confidence';
import { formatNumber, formatUtc } from '../format';
import type { StayResponse } from '../physics.worker';
import { useApp } from '../store';
import { CHECK_KEYS, type Check, type CheckKey, cardFileName, shareLink, type Verdict } from '../verdict';
import { smallButton } from './Controls';
import { type CardData, renderCard } from './reportCard';

interface Props extends StayResponse {
  query: StayQuery;
  checks: Record<CheckKey, Check>;
  verdict: Verdict;
  /** The words the report uses for the terrain warning, so the card says the same. */
  note: string;
}

const pageLink = () =>
  shareLink(`${window.location.origin}${window.location.pathname}`, {
    ...useApp.getState(),
  });

/**
 * Share one site check three ways: a link that opens the same check, a picture of it for a slide or a post, and a
 * printable page (or PDF) of the same picture on white.
 */
export function ShareReport({ query, result, terrain, longTerm, checks, verdict, note }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string>();
  const [printUrl, setPrintUrl] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const slipDays = useApp((s) => s.slipDays);

  useEffect(() => {
    if (!open) return;
    // Into the menu on opening; back to the Share button when Escape shuts it.
    box.current?.querySelector<HTMLButtonElement>('[data-share-item]')?.focus();
    const away = (e: PointerEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      box.current?.querySelector<HTMLButtonElement>('button')?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  useEffect(() => {
    if (!printUrl) return;
    const done = () => setPrintUrl(undefined);
    window.addEventListener('afterprint', done);
    return () => window.removeEventListener('afterprint', done);
  }, [printUrl]);

  const tell = (message: string) => {
    setOpen(false);
    setSaid(message);
    setTimeout(() => setSaid(undefined), 2500);
  };

  const card = (): CardData => {
    const { latDeg, lonDeg } = query.site;
    const pct = (v: number) => (Number.isFinite(v) ? `${formatNumber(v, 0)}%` : '—');
    const stats = [
      { label: t('report.sunMin'), value: pct(result.sunFractionMin * 100) },
      { label: t('report.earthPct'), value: pct(result.earthVisiblePct) },
    ];
    if (terrain) stats.push({ label: t('report.groundHeight'), value: `${formatNumber(terrain.groundHeightM, 0)} m` });
    if (longTerm)
      stats.push(
        { label: t('report.longTermSun'), value: pct(longTerm.sunPct) },
        { label: t('report.longTermEarth'), value: pct(longTerm.earthPct) },
        { label: t('report.shadowed'), value: longTerm.shadowed ? t('report.yes') : t('report.no') },
      );
    const slopeWords = terrain ? t('report.needsFinerTerrain') : t('report.noTerrain');
    return {
      kicker: t('share.kicker'),
      verdict: t(`report.verdict.${verdict}`),
      tone: verdict,
      place: t('share.place', {
        lat: formatNumber(Math.abs(latDeg), 4),
        northSouth: latDeg < 0 ? t('landers.south') : t('landers.north'),
        lon: formatNumber(Math.abs(lonDeg), 4),
        eastWest: lonDeg < 0 ? t('landers.west') : t('landers.east'),
      }),
      when: [
        t('share.when', { date: formatUtc(query.landingUtc), days: formatNumber(query.stayDays) }),
        slipDays ? t('share.slip', { n: formatNumber(slipDays, 0).replace('-', '−') }) : '',
      ]
        .filter(Boolean)
        .join(' · '),
      checks: CHECK_KEYS.map((k) => {
        // The same confidence word as the report's badge, so a shared picture never reads a first pass as final.
        const sure = confidenceOf(k, { terrainM: terrain?.resolutionM, longTermM: longTerm?.resolutionM });
        const unmeasuredSlope = checks[k] === 'unknown' && k === 'slope';
        return {
          label: t(`report.${k}`),
          value: unmeasuredSlope ? slopeWords : `${t(`report.${checks[k]}`)} · ${t(`confidence.short.${sure}`)}`,
          tone: checks[k],
        };
      }),
      stats,
      note,
      sources: `${t('report.sources')}: ${[...result.sources, ...(longTerm ? [longTerm.id] : [])].join(', ')}`,
      link: pageLink(),
      footer: t('share.footer'),
    };
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pageLink());
      tell(t('share.copied'));
    } catch {
      window.prompt(t('share.copyByHand'), pageLink());
    }
  };

  const download = async () => {
    const canvas = await renderCard(card());
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = cardFileName(query.site.latDeg, query.site.lonDeg, query.landingUtc);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      tell(t('share.saved'));
    }, 'image/png');
  };

  const print = async () => {
    setOpen(false);
    setPrintUrl((await renderCard(card(), 'light')).toDataURL('image/png'));
  };

  const item = 'flex min-h-9 w-full items-center rounded px-2.5 text-start text-sm hover:bg-panel-raised';
  return (
    <div ref={box} className="relative">
      <button type="button" className={smallButton} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t('share.button')}
      </button>
      {open && (
        <div className="absolute inset-s-0 top-10 z-20 flex w-60 flex-col rounded-lg border border-line bg-panel p-1.5 shadow-xl max-sm:fixed max-sm:inset-x-3 max-sm:top-auto max-sm:bottom-3 max-sm:w-auto">
          <button type="button" data-share-item className={item} onClick={() => void copy()}>
            {t('share.copy')}
          </button>
          <button type="button" className={item} onClick={() => void download()}>
            {t('share.image')}
          </button>
          <button type="button" className={item} onClick={() => void print()}>
            {t('share.print')}
          </button>
          <p className="px-2.5 pt-1 pb-0.5 text-xs text-quiet">{t('share.note')}</p>
        </div>
      )}
      <p role="status" className="absolute inset-s-0 top-10 text-xs whitespace-nowrap text-pass">
        {said}
      </p>
      {printUrl &&
        createPortal(
          <div id="print-card">
            <img src={printUrl} alt={t('share.printAlt')} onLoad={() => window.print()} />
          </div>,
          document.body,
        )}
    </div>
  );
}
