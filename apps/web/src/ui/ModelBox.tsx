import { type LanderBody, ModelView } from '@siteline/engine';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  url: string;
  body: LanderBody;
  /** Where the Sun is at the lander; undefined until the physics worker has answered. */
  sun: { heightDeg: number; azimuthDeg: number } | undefined;
}

/** A NASA 3D model on a turntable, lit as the Sun lights the lander's site. */
export function ModelBox({ url, body, sun }: Props) {
  const { t } = useTranslation();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState<ModelView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

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
      () => live && setState('failed'),
    );
    return () => {
      live = false;
    };
  }, [view, url]);

  const heightDeg = sun?.heightDeg ?? 45;
  const azimuthDeg = sun?.azimuthDeg ?? 180;
  useEffect(() => view?.setLight({ heightDeg, azimuthDeg }, body), [view, heightDeg, azimuthDeg, body]);

  const night = sun !== undefined && sun.heightDeg < 0;
  return (
    <figure className="mt-3 overflow-hidden rounded-lg border border-line bg-panel-sunk">
      <div ref={setHost} className="h-56 w-full" data-testid="model-box" />
      <figcaption className="px-3 py-2 text-xs text-quiet">
        {state === 'loading'
          ? t('landers.modelLoading')
          : state === 'failed'
            ? t('landers.modelFailed')
            : night
              ? t('landers.modelNight')
              : t('landers.modelDay')}
      </figcaption>
    </figure>
  );
}
