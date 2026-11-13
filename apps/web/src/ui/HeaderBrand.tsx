import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import emblemUrl from '../assets/emblem.webp';
import { findLander } from '../landers';
import { useApp } from '../store';

/** The header's tagline names the world in view; a lander's close-up names the lander's world. */
function Tagline() {
  const { t } = useTranslation();
  const key = useApp((s) => {
    if (s.view !== 'site') return s.view;
    const body = findLander(s.missionId ?? '')?.body;
    return body && `site${body}`;
  });
  return (
    <AnimatePresence mode="wait" initial={false}>
      {key && (
        <motion.p
          key={key}
          className="text-xs text-quiet max-lg:hidden"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        >
          {t(`app.tagline.${key}`)}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

/**
 * The name, with the SiteLine Lunar Emblem beside it: the coin from the opening, turning now and then, and a light that
 * crosses the name once as the app opens.
 */
export function HeaderBrand() {
  return (
    <div className="brand flex items-center gap-2.5">
      <img src={emblemUrl} alt="" className="brand-coin" draggable={false} />
      <div className="flex flex-wrap items-baseline gap-x-2.5">
        <h1 className="text-[21px]">
          <span className="brand-word">SiteLine</span>
        </h1>
        <Tagline />
      </div>
    </div>
  );
}
