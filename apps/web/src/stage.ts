import type { SolarView } from '@siteline/engine';
import { create } from 'zustand';

/** The 3D views the rest of the interface needs to reach: the opening flies the solar system's camera. */
interface StageState {
  solar: SolarView | null;
  setSolar: (solar: SolarView | null) => void;
}

export const useStage = create<StageState>((set) => ({
  solar: null,
  setSolar: (solar) => set({ solar }),
}));
