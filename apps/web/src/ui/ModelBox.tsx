import { type LanderBody, ModelView } from '@siteline/engine';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

function CreditLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted">
      {children}
    </a>
  );
}

interface Props {
  url: string;
  body: LanderBody;
  /** Where the Sun is at the lander; undefined until the physics worker has answered. */
  sun: { heightDeg: number; azimuthDeg: number } | undefined;
  /**
   * A model that stands at no site, such as a spacecraft on the Moon's card: a fixed light and a plain caption, never
   * "lit by the Sun as it is there now".
   */
  neutral?: boolean;
  /** The model's credit line, linked to its NASA page, shown under it. */
  credit?: { text: string; href: string };
  /** Called once if the file cannot be loaded, so the model can leave its list instead of showing an error. */
  onFail?: () => void;
}

/** A NASA 3D model on a turntable, lit as the Sun lights the lander's site, or with a fixed light (`neutral`). */
export function ModelBox({ url, body, sun, neutral, credit, onFail }: Props) {
  const { t } = useTranslation();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState<ModelView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // The latest callback, without reloading the model when the parent passes a new one.
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    if (!host) return;
    const created = new ModelView(host);
    setView(created);
    return () => {
      created.dispose();
      setView(null);
    };
  }, [host]);

  useEffect(() => {
    if (!view) return;
    let live = true;
    setState('loading');
    view.show(url).then(
      () => live && setState('ready'),
      () => {
        if (!live) return;
        setState('failed');
        onFailRef.current?.();
      },
    );
    return () => {
      live = false;
    };
  }, [view, url]);

  const heightDeg = neutral ? 45 : (sun?.heightDeg ?? 45);
  const azimuthDeg = neutral ? 180 : (sun?.azimuthDeg ?? 180);
  useEffect(() => view?.setLight({ heightDeg, azimuthDeg }, body), [view, heightDeg, azimuthDeg, body]);

  const night = !neutral && sun !== undefined && sun.heightDeg < 0;
  return (
    <figure className="mt-3 overflow-hidden rounded-lg border border-line bg-panel-sunk">
      <div ref={setHost} className="h-56 w-full" data-testid="model-box" />
      <figcaption className="px-3 py-2 text-xs text-quiet">
        {state === 'loading'
          ? t('landers.modelLoading')
          : state === 'failed'
            ? t('landers.modelFailed')
            : neutral
              ? t('nasaModels.caption')
              : night
                ? t('landers.modelNight')
                : t('landers.modelDay')}
        {credit && (
          <>
            {' · '}
            <Trans
              i18nKey="nasaModels.credit"
              values={{ credit: credit.text }}
              components={{
                link: <CreditLink href={credit.href} />,
              }}
            />
          </>
        )}
      </figcaption>
    </figure>
  );
}
