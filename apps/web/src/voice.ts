/**
 * Voice for Luna, from the browser itself: speech recognition for the mic and speech synthesis for replies.
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

/** Reads `text` aloud. A new answer cuts off what was being said; `queue` waits its turn (progress lines). */
export interface VoiceInfo {
  name: string;
  lang: string;
  localService?: boolean;
}

/**
 * The most natural voice a device offers for the language, best first: the neural "Natural" and "Online" voices (Edge,
 * Windows), Google's and Apple's own, a female voice where the name says so (Luna is a she), then any voice in the
 * language. Undefined lets the browser choose.
 */
export function bestVoice<V extends VoiceInfo>(voices: readonly V[], locale: string): V | undefined {
  const base = locale.slice(0, 2).toLowerCase();
  const score = (v: V) => {
    if (!v.lang.toLowerCase().startsWith(base)) return -1;
    let n = 0;
    if (/natural|neural|online/i.test(v.name)) n += 8;
    if (/google|samantha|siri|premium|enhanced/i.test(v.name)) n += 4;
    if (/aria|jenny|ava|emma|sonia|libby|michelle|zira|female|samantha|karen|moira|tessa|serena/i.test(v.name)) n += 2;
    if (v.lang.toLowerCase() === locale.toLowerCase()) n += 1;
    return n;
  };
  let best: V | undefined;
  let bestScore = -1;
  for (const v of voices) {
    const sc = score(v);
    if (sc > bestScore) {
      best = v;
      bestScore = sc;
    }
  }
  return bestScore >= 0 ? best : undefined;
}

export function speak(text: string, language: string, { queue = false }: { queue?: boolean } = {}): void {
  if (!canSpeak()) return;
  const words = speakable(text);
  if (!words) return;
  if (!queue) window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(words);
  u.lang = localeOf(language);
  const voice = bestVoice(window.speechSynthesis.getVoices(), u.lang);
  if (voice) u.voice = voice;
  u.rate = 1.02;
  window.speechSynthesis.speak(u);
}

// Voices load after the page in some browsers: ask early, so the first reply already has the good one.
if (canSpeak()) window.speechSynthesis.getVoices();

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}
