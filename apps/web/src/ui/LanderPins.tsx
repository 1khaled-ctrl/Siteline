import { type Mission, missionPlace, type PinHost, pinStyleOf, type Tracks } from '@siteline/engine';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MISSIONS, statusKey } from '../landers';
import { useApp } from '../store';

interface Props {
  /** The 3D view the pins sit on; nothing is drawn until it exists. */
  host: PinHost | null;
  missions: readonly Mission[];
  tracks: Tracks | undefined;
  /** The date shown, in UTC milliseconds: a lander that lands after it is drawn as not yet landed. */
  atUtcMs: number;
}

/** Statuses whose names are always worth showing, even when the globe is far away. */
const ALWAYS_NAMED = new Set(['active', 'crew', 'next', 'onway']);
const LABEL_HEIGHT_PX = 18;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * One button per lander, laid over a 3D view. The view calls back after every draw and the buttons are moved there
 * directly, so a turning globe does not re-render React. Names are shown for the open lander and the ones that matter
 * most, then for others while there is room.
 */
export function LanderPins({ host, missions, tracks, atUtcMs }: Props) {
  const { t } = useTranslation();
  const selectedId = useApp((s) => s.missionId);
  const select = useApp((s) => s.selectMission);
  const layer = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const places = useMemo(
    () => new Map(missions.map((m) => [m.id, missionPlace(MISSIONS, m, tracks, atUtcMs)] as const)),
    [missions, tracks, atUtcMs],
  );
  // Names are placed in this order: the open lander, then the important ones, then the rest by date.
  const order = useMemo(
    () =>
      [...missions].sort(
        (a, b) =>
          Number(b.id === selectedId) - Number(a.id === selectedId) ||
          Number(ALWAYS_NAMED.has(b.status)) - Number(ALWAYS_NAMED.has(a.status)) ||
          a.tUtcMs - b.tUtcMs,
      ),
    [missions, selectedId],
  );

  const place = useCallback(() => {
    if (!host || !layer.current) return;
    const { clientWidth: w, clientHeight: h } = layer.current;
    const taken: Box[] = [];
    const close = host.isClose();
    for (const m of order) {
      const button = buttons.current.get(m.id);
      if (!button) continue;
      const at = places.get(m.id);
      const pt = at && host.project(at.latDeg, at.lonDeg);
      if (!pt || pt.xPx < -40 || pt.xPx > w + 40 || pt.yPx < -40 || pt.yPx > h + 40) {
        button.style.display = 'none';
        continue;
      }
      button.style.display = '';
      button.style.transform = `translate(${pt.xPx.toFixed(1)}px,${pt.yPx.toFixed(1)}px) translate(-50%,-50%)`;
      const label = button.lastElementChild as HTMLElement;
      let named = false;
      if (m.id === selectedId || ALWAYS_NAMED.has(m.status) || close) {
        const width = m.name.length * 6.6 + 14;
        const box = {
          left: pt.xPx - width / 2,
          right: pt.xPx + width / 2,
          top: pt.yPx - 16 - LABEL_HEIGHT_PX,
          bottom: pt.yPx - 16,
        };
        named = m.id === selectedId || !taken.some((q) => overlaps(box, q));
        if (named) taken.push(box);
      }
      label.style.display = named ? '' : 'none';
    }
  }, [host, order, places, selectedId]);

  useEffect(() => {
    if (!host) return;
    host.setFrameListener(place);
    place();
    return () => host.setFrameListener(undefined);
  }, [host, place]);

  return (
    <div ref={layer} className="lander-pins" data-testid="lander-pins">
      {missions.map((m) => {
        const style = pinStyleOf(m, atUtcMs);
        const selected = m.id === selectedId;
        return (
          <button
            key={m.id}
            ref={(el) => {
              if (el) buttons.current.set(m.id, el);
              else buttons.current.delete(m.id);
            }}
            type="button"
            className="lander-pin"
            data-style={style}
            data-testid={`pin-${m.id}`}
            aria-pressed={selected}
            aria-label={`${m.name}: ${t(`landers.status.${statusKey(m, atUtcMs)}`)}`}
            style={{ display: 'none' }}
            onClick={() => select(selected ? null : m.id)}
          >
            <span className="lander-dot" aria-hidden="true" />
            <span className="lander-label" aria-hidden="true">
              {m.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
