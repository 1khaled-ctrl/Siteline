import type { NasaModel } from '@siteline/data-client';
import { type ReactNode, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { cardModels, modelFileUrl, sourcedStatus, statusKey, useModelsThere } from '../nasaModels';
import { ModelBox } from './ModelBox';

const chip = 'rounded-pill border border-line px-1.5 py-px text-[11px] text-quiet whitespace-nowrap';

function Ext({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-ink">
      {children}
    </a>
  );
}

/**
 * NASA 3D models of spacecraft and hardware, one row each: the name and status as the manifest gives them, the NASA page
 * behind a status other than "being checked", the manifest's note, the credit line linked to the model's NASA page, and
 * a button that opens the model on a turntable under its row, one at a time.
 */
export function NasaModelRows({ models, onFail }: { models: readonly NasaModel[]; onFail?: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="mt-2 flex flex-col gap-2">
      {models.map((m) => (
        <li
          key={m.id}
          className="rounded-lg border border-line bg-panel-raised px-2.5 py-2 text-sm"
          data-testid={`nasa-model-${m.id}`}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <span className="font-semibold">{m.name}</span>
            <span className={chip} data-testid="nasa-model-status">
              {t(statusKey(m.status))}
            </span>
          </div>
          {sourcedStatus(m) && m.statusNote && m.statusSource && (
            <p className="mt-1 text-quiet">
              <Trans
                i18nKey="nasaModels.statusSaid"
                values={{ note: m.statusNote }}
                components={{ link: <Ext href={m.statusSource} /> }}
              />
            </p>
          )}
          {m.note && <p className="mt-1 text-quiet">{m.note}</p>}
          <p className="mt-1 text-xs text-quiet">
            <Trans
              i18nKey="nasaModels.credit"
              values={{ credit: m.credit }}
              components={{ link: <Ext href={m.sourceUrl} /> }}
            />
          </p>
          {m.bytes !== null && (
            <button
              type="button"
              className="mt-2 min-h-9 rounded-md border border-line px-2.5 text-xs hover:border-line-hover"
              aria-expanded={open === m.id}
              onClick={() => setOpen(open === m.id ? null : m.id)}
            >
              {open === m.id ? t('nasaModels.hide') : t('nasaModels.view', { size: formatNumber(m.bytes / 1e6, 1) })}
            </button>
          )}
          {open === m.id && (
            <ModelBox
              url={modelFileUrl(m)}
              body="Moon"
              sun={undefined}
              neutral
              credit={{ text: m.credit, href: m.sourceUrl }}
              onFail={() => {
                setOpen(null);
                onFail?.(m.id);
              }}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/** The models section of the Moon's card, with only the models whose files the bucket holds; nothing when none does. */
export function MoonModels() {
  const { t } = useTranslation();
  const { there, drop } = useModelsThere(cardModels());
  if (there.length === 0) return null;
  return <MoonModelsSection models={there} onFail={drop} title={t('nasaModels.heading')} />;
}

/** The section itself, for a list already checked. */
export function MoonModelsSection({
  models,
  onFail,
  title,
}: {
  models: readonly NasaModel[];
  onFail?: (id: string) => void;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="mt-3" data-testid="nasa-models" aria-label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-quiet">{t('nasaModels.intro')}</p>
      <NasaModelRows models={models} onFail={onFail} />
    </section>
  );
}
