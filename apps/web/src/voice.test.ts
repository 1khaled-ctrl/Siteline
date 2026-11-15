import { describe, expect, it } from 'vitest';
import { bestVoice, speakable } from './voice';

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

describe('bestVoice', () => {
  const voices = [
    { name: 'Microsoft David - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
    { name: 'Google français', lang: 'fr-FR' },
  ];
  it('prefers a natural neural voice in the language', () => {
    expect(bestVoice(voices, 'en-US')?.name).toContain('Aria Online (Natural)');
  });
  it('falls back to a female voice when there is no natural one', () => {
    expect(bestVoice(voices.slice(0, 2), 'en-US')?.name).toContain('Zira');
  });
  it('lets the browser choose when no voice speaks the language', () => {
    expect(bestVoice(voices.slice(0, 2), 'ar-SA')).toBeUndefined();
  });
});
