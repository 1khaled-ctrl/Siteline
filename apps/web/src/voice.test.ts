import { describe, expect, it, vi } from 'vitest';
import { bestVoice, isGoodbye, speakAsLuna, speakable } from './voice';

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

describe('isGoodbye', () => {
  it('ends the talk on a goodbye or a request to hang up', () => {
    for (const s of [
      'Bye',
      'bye bye!',
      'Goodbye, Luna.',
      "OK, that's all",
      'Thanks, bye',
      'End call',
      'please end the call',
      'hang up',
      "I'm done",
    ])
      expect(isGoodbye(s)).toBe(true);
  });
  it('keeps going on a question that only mentions the words', () => {
    for (const s of [
      'Fly to Mars',
      'Thanks',
      'What does the end of the stay look like?',
      'Is that all the sites?',
      'Find me a landing site for a rover',
    ])
      expect(isGoodbye(s)).toBe(false);
  });
});

describe('speakAsLuna', () => {
  it('never asks the server before a tap has unlocked the audio, and settles at once where the browser has no voice', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const speech = speakAsLuna('Hello from the Moon 🌙', 'en', fetcher);
    expect(await speech.done).toBe('browser');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await speakAsLuna('👋', 'en', fetcher).done).toBe('none');
  });
});
