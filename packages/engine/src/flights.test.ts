import { describe, expect, it } from 'vitest';
import { angleBetween, type Flight, onFlight, reportFlight, zoomSize } from './flights';

describe('camera flights', () => {
  it('tells every listener as a flight starts, until it stops listening', () => {
    const heard: Flight[] = [];
    const stop = onFlight((f) => heard.push(f));
    const flight = { durationMs: 1800, zoom: 3.2, turnRad: 0.4 };
    reportFlight(flight);
    stop();
    reportFlight(flight);
    expect(heard).toEqual([flight]);
  });

  it('leaves out a cut, which has no flight to follow', () => {
    const heard: Flight[] = [];
    const stop = onFlight((f) => heard.push(f));
    reportFlight({ durationMs: 0, zoom: 2, turnRad: 1 });
    stop();
    expect(heard).toHaveLength(0);
  });

  it('measures the swing between two directions, whatever their lengths', () => {
    expect(angleBetween({ x: 1, y: 0, z: 0 }, { x: 0, y: 5, z: 0 })).toBeCloseTo(Math.PI / 2, 12);
    expect(angleBetween({ x: 2, y: 0, z: 0 }, { x: -3, y: 0, z: 0 })).toBeCloseTo(Math.PI, 12);
    expect(angleBetween({ x: 1, y: 1, z: 0 }, { x: 1, y: 1, z: 0 })).toBeCloseTo(0, 6);
    expect(angleBetween({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBe(0);
  });

  it('measures a zoom the same in and out', () => {
    expect(zoomSize(10, 1)).toBeCloseTo(Math.log(10), 12);
    expect(zoomSize(1, 10)).toBeCloseTo(Math.log(10), 12);
    expect(zoomSize(5, 5)).toBe(0);
    expect(zoomSize(0, 5)).toBe(0);
  });
});
