import type { SolarView } from '@siteline/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { backToSystem, closerLook, useStage } from './stage';

/** A stand-in for the 3D view: each dive and pull back stays open until the test settles it. */
function fakeSolar() {
  const dives: { body: string; settle: (arrived: boolean) => void }[] = [];
  const backs: ((landed: boolean) => void)[] = [];
  const view = {
    closeUp: (body: string) => new Promise<boolean>((settle) => dives.push({ body, settle })),
    pullBack: () => new Promise<boolean>((settle) => backs.push(settle)),
  };
  useStage.setState({ solar: view as unknown as SolarView });
  return { dives, backs };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useStage.setState({
    solar: null,
    solarPicked: null,
    solarCloseUp: null,
    solarLeaving: false,
    dialWorld: 'moon',
    sheetOpen: false,
  });
});

describe('closerLook', () => {
  it('opens the facts card, the sheet and the way back as the dive starts', () => {
    const { dives } = fakeSolar();
    void closerLook('jupiter');
    expect(dives.map((d) => d.body)).toEqual(['jupiter']);
    expect(useStage.getState()).toMatchObject({
      solarPicked: 'jupiter',
      solarCloseUp: 'jupiter',
      dialWorld: 'jupiter',
      sheetOpen: true,
    });
  });

  it('keeps a card that was already open instead of closing it', () => {
    fakeSolar();
    useStage.setState({ solarPicked: 'saturn' });
    void closerLook('saturn');
    expect(useStage.getState().solarPicked).toBe('saturn');
  });

  it('stays beside the planet after arriving', async () => {
    const { dives } = fakeSolar();
    const done = closerLook('saturn');
    dives[0].settle(true);
    await done;
    expect(useStage.getState().solarCloseUp).toBe('saturn');
  });

  it('drops the close-up when the dive is cut short', async () => {
    const { dives } = fakeSolar();
    const done = closerLook('venus');
    dives[0].settle(false);
    await done;
    expect(useStage.getState().solarCloseUp).toBeNull();
    expect(useStage.getState().solarPicked).toBe('venus');
  });

  it('leaves a later dive alone when an earlier one is cut short', async () => {
    const { dives } = fakeSolar();
    const first = closerLook('venus');
    void closerLook('venus');
    dives[0].settle(false);
    await first;
    expect(useStage.getState().solarCloseUp).toBe('venus');
    const other = closerLook('uranus');
    dives[1].settle(false);
    await tick();
    expect(useStage.getState().solarCloseUp).toBe('uranus');
    dives[2].settle(true);
    await other;
    expect(useStage.getState().solarCloseUp).toBe('uranus');
  });

  it('does nothing without a solar system on screen', async () => {
    await closerLook('neptune');
    expect(useStage.getState()).toMatchObject({ solarPicked: null, solarCloseUp: null, sheetOpen: false });
  });
});

describe('backToSystem', () => {
  it('pulls back, and says so until the camera lands', async () => {
    const { dives, backs } = fakeSolar();
    const dive = closerLook('jupiter');
    dives[0].settle(true);
    await dive;
    const back = backToSystem();
    expect(useStage.getState()).toMatchObject({ solarCloseUp: null, solarLeaving: true, solarPicked: 'jupiter' });
    backs[0](true);
    await back;
    expect(useStage.getState().solarLeaving).toBe(false);
  });

  it('works during the dive, and the dive it cut short changes nothing', async () => {
    const { dives, backs } = fakeSolar();
    const dive = closerLook('mercury');
    const back = backToSystem();
    dives[0].settle(false);
    await dive;
    expect(useStage.getState()).toMatchObject({ solarCloseUp: null, solarLeaving: true });
    backs[0](true);
    await back;
    expect(useStage.getState()).toMatchObject({ solarCloseUp: null, solarLeaving: false });
  });

  it('does not ask the view to pull back when there is no close-up', async () => {
    const { backs } = fakeSolar();
    await backToSystem();
    expect(backs).toHaveLength(0);
    expect(useStage.getState().solarLeaving).toBe(false);
  });
});
