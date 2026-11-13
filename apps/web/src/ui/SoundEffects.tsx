import { onFlight } from '@siteline/engine';
import { useEffect } from 'react';
import { sound } from '../sound';

/**
 * The app's sounds that follow what happens anywhere: camera flights, and the pull back out to the solar system with a
 * sound of its own. The time-lapse plays silently.
 */
export function SoundEffects() {
  useEffect(() => onFlight((flight) => (flight.back ? sound.pullBack(flight) : sound.whoosh(flight))), []);
  return null;
}
