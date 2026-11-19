/**
 * Voice for Luna: the browser's own speech recognition for the mic (Chrome and Edge send the audio to their vendor,
 * Safari may run it on the device), and Luna's own voice for replies: the reply's text goes to /api/speak (Cartesia,
 * or Aura "luna" on Workers AI), with the browser's speech synthesis as the fallback. No audio of the visitor goes to
 * SiteLine.
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

// Luna's own voice ------------------------------------------------------------------------------------------------

/** The longest line sent to /api/speak, as the endpoint itself cuts it. */
const MAX_SPEAK_CHARS = 600;

let audio: AudioContext | null = null;
/** Set when this server has no voice of its own (no endpoint, or neither voice answers): the browser speaks instead. */
let noServerVoice = false;

/**
 * Wakes the audio output from inside a tap, the only moment iPhones allow it, with a silent sample so the tap counts.
 * Called on "Talk live" and the mic button; safe to call on every tap.
 */
export function unlockAudio(): void {
  if (typeof window === 'undefined') return;
  const Ctx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  try {
    audio ??= new Ctx();
    if (audio.state === 'suspended') void audio.resume();
    const tick = audio.createBufferSource();
    tick.buffer = audio.createBuffer(1, 1, 22_050);
    tick.connect(audio.destination);
    tick.start(0);
  } catch {
    audio = null;
  }
}

/** A line being spoken: `done` settles when it has been said (or stopped) and names the voice used. */
export interface Speech {
  done: Promise<'cartesia' | 'aura' | 'browser' | 'none'>;
  stop: () => void;
}

/** The browser's own voice for one line, settling when it ends; Chrome sometimes never says so, hence the timer. */
function browserSay(words: string, language: string, onStop: (stop: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    if (!canSpeak()) return resolve();
    const u = new SpeechSynthesisUtterance(words);
    u.lang = localeOf(language);
    const voice = bestVoice(window.speechSynthesis.getVoices(), u.lang);
    if (voice) u.voice = voice;
    u.rate = 1.02;
    const timer = setTimeout(resolve, 3_000 + words.length * 90);
    const end = () => {
      clearTimeout(timer);
      resolve();
    };
    u.onend = end;
    u.onerror = end;
    onStop(() => {
      window.speechSynthesis.cancel();
      end();
    });
    window.speechSynthesis.speak(u);
  });
}

/**
 * Says one line in Luna's own voice: /api/speak (Cartesia, or Aura "luna" on Workers AI) played through the unlocked
 * audio output. Any failure, or no unlocked output, falls back to the browser's own voice, so she always answers out
 * loud where the browser can speak.
 */
export function speakAsLuna(text: string, language: string, fetcher: typeof fetch = fetch): Speech {
  const words = speakable(text).slice(0, MAX_SPEAK_CHARS);
  let stopped = false;
  let stopNow = () => {};
  const done = (async (): Promise<Awaited<Speech['done']>> => {
    if (!words) return 'none';
    const out = audio;
    if (out && !noServerVoice) {
      try {
        const res = await fetcher('/api/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: words }),
        });
        if (stopped) return 'none';
        const voice = res.headers.get('X-Luna-Voice');
        if (res.ok && (res.headers.get('Content-Type') ?? '').startsWith('audio/')) {
          const clip = await out.decodeAudioData(await res.arrayBuffer());
          if (stopped) return 'none';
          await new Promise<void>((resolve) => {
            const src = out.createBufferSource();
            src.buffer = clip;
            src.connect(out.destination);
            src.onended = () => resolve();
            stopNow = () => {
              try {
                src.stop();
              } catch {
                // Already ended.
              }
              resolve();
            };
            src.start();
          });
          return voice === 'cartesia' ? 'cartesia' : 'aura';
        }
        // No endpoint (a plain Vite server answers 404 with its own page) or no voice behind it: stop asking.
        if (res.status === 404 || res.status === 503) noServerVoice = true;
      } catch {
        // Offline, or audio that wouldn't decode: the browser speaks this line.
      }
    }
    if (stopped) return 'none';
    await browserSay(words, language, (s) => {
      stopNow = s;
    });
    return 'browser';
  })();
  return {
    done,
    stop: () => {
      stopped = true;
      stopNow();
    },
  };
}

/** Whether a spoken message ends the conversation: a goodbye, or asking to end or hang up. */
export function isGoodbye(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[.!?,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\b(end|stop) (the )?(call|conversation|talking)\b|\bhang up\b/.test(t)) return true;
  return /^(ok(ay)? |thanks? (you )?|thank you )?(bye( bye)?|goodbye|good bye|see you|that'?s all|that'?s it|i'?m done|we'?re done)( luna)?( thanks?( you)?)?$/.test(
    t,
  );
}
