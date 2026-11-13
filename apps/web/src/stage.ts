import { type Insets, NO_INSETS, type SolarLabelKey, type SolarView } from '@siteline/engine';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';

/** The 3D views the rest of the interface needs to reach: the opening flies the solar system's camera. */
interface StageState {
  solar: SolarView | null;
  setSolar: (solar: SolarView | null) => void;
  /** False while the floating panel has nothing to show, so the 3D view takes the whole width. */
  panelShown: boolean;
  setPanelShown: (shown: boolean) => void;
  /** On a phone: the world the dial has picked in the solar system, and whether the sheet is up. */
  dialWorld: SolarLabelKey;
  setDialWorld: (world: SolarLabelKey) => void;
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
}

export const useStage = create<StageState>((set) => ({
  solar: null,
  setSolar: (solar) => set({ solar }),
  panelShown: true,
  setPanelShown: (panelShown) => set({ panelShown }),
  dialWorld: 'moon',
  setDialWorld: (dialWorld) => set({ dialWorld }),
  sheetOpen: false,
  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
}));

/** True on a screen wide enough for the floating panel and the callouts in the scene (Tailwind's `lg`). */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}

/** The floating panel and its margin on a wide screen, as `App` lays them out (410 px plus 12 px). */
export const PANEL_PX = 422;
const WIDE = '(min-width: 64rem)';

/**
 * How much of a 3D view's canvas the panel covers. On a wide screen the canvas runs on under the panel, so the scene
 * shows through its glass, and the view centres its world in the part the panel leaves free.
 */
export function useStageInsets(): Insets {
  const shown = useStage((s) => s.panelShown);
  const wide = useWide() && shown;
  const rtl = document.documentElement.dir === 'rtl';
  return useMemo(
    () => (wide ? (rtl ? { left: PANEL_PX, right: 0 } : { left: 0, right: PANEL_PX }) : NO_INSETS),
    [wide, rtl],
  );
}
