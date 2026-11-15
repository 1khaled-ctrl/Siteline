import { describe, expect, it } from 'vitest';
import { speakable } from './voice';

describe('speakable', () => {
  it('drops emoji and turns lines into sentences', () => {
    expect(speakable('✅ Good news: it passes.\n☀️ Sunlight: the Sun stays up\n💡 Try the slider')).toBe(
      'Good news: it passes. Sunlight: the Sun stays up. Try the slider',
    );
  });
  it('keeps numbers as they are written', () => {
    expect(speakable('🌍 Earth: in view 55.9% of the stay.')).toBe('Earth: in view 55.9% of the stay.');
  });
});
