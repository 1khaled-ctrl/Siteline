/**
 * Voice for Ask SiteLine, from the browser itself: speech recognition for the mic and speech synthesis for replies.
 * Nothing is sent anywhere by SiteLine; the browser's own speech service handles the audio (Chrome and Edge send it to
 * their vendor, Safari may run it on the device). This is the free first step; a LiveKit voice agent can replace it
 * later behind the same two functions.
 */

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [i: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionClass = new () => Recognition;

const Recognizer = (): RecognitionClass | undefined => {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export const canListen = (): boolean => Recognizer() !== undefined;
export const canSpeak = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** The browser locale for a UI language. */
const localeOf = (language: string) => (language.startsWith('ar') ? 'ar-SA' : 'en-US');

/**
 * Listens for one utterance. `onPartial` gets the words so far; `onDone` gets the final text (empty if nothing was
 * heard) or an error code. Returns a function that stops listening early.
 */
export function listen(
  language: string,
  onPartial: (text: string) => void,
  onDone: (result: { text: string } | { error: string }) => void,
): () => void {
  const R = Recognizer();
  if (!R) {
    onDone({ error: 'unsupported' });
    return () => {};
  }
  const rec = new R();
  rec.lang = localeOf(language);
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  let failed = false;
  rec.onresult = (e) => {
    let partial = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else partial += r[0].transcript;
    }
    onPartial((finalText + partial).trim());
  };
  rec.onerror = (e) => {
    failed = true;
    // "no-speech" and "aborted" are a quiet mic or a stop, not something to report.
    onDone(e.error === 'no-speech' || e.error === 'aborted' ? { text: '' } : { error: e.error });
  };
  rec.onend = () => {
    if (!failed) onDone({ text: finalText.trim() });
  };
  rec.start();
  return () => rec.stop();
}

/** What a reply sounds like read aloud: no emoji, arrows or markup, and one pause per line. */
export function speakable(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/[↳•·]/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speak(text: string, language: string): void {
  if (!canSpeak()) return;
  const words = speakable(text);
  if (!words) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(words);
  u.lang = localeOf(language);
  u.rate = 1.04;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}
