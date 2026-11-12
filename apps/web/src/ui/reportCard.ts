import type { Check, Verdict } from '../verdict';

/** Everything the card shows, already in words; the card only lays it out. */
export interface CardData {
  kicker: string;
  verdict: string;
  tone: Verdict;
  place: string;
  when: string;
  checks: { label: string; value: string; tone: Check }[];
  stats: { label: string; value: string }[];
  note: string;
  sources: string;
  link: string;
  footer: string;
}

const PALETTES = {
  dark: {
    bg: '#0c1322',
    raised: '#121b30',
    line: '#22304f',
    ink: '#e8edf7',
    quiet: '#8e9ab5',
    pass: '#41cf8f',
    fail: '#ff6f6f',
    warn: '#f0c050',
    accent: '#5ba9ff',
  },
  // For paper: dark text, and the verdict colours deepened enough to read on white.
  light: {
    bg: '#ffffff',
    raised: '#f3f5f9',
    line: '#d5dbe6',
    ink: '#0d1424',
    quiet: '#4d5870',
    pass: '#11804e',
    fail: '#c62828',
    warn: '#8a5a00',
    accent: '#1a5fb4',
  },
} as const;

const W = 1200;
const H = 675;
const PAD = 48;
const DISPLAY = '"Saira Semi Condensed", "IBM Plex Sans", system-ui, sans-serif';
const SANS = '"IBM Plex Sans", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
const ICON: Record<Check, string> = { yes: '✓', no: '✗', unknown: '?' };
const TONE: Record<Verdict, Check> = { pass: 'yes', fail: 'no', undecided: 'unknown' };

/** Writes `text` from (x, y) within `width`, breaking at spaces; returns the y below the last line. */
function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineH: number): number {
  let line = '';
  let at = y;
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width > width && line) {
      g.fillText(line, x, at);
      line = word;
      at += lineH;
    } else line = next;
  }
  if (line) g.fillText(line, x, at);
  return at + lineH;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/** The site report as a 1200 × 675 picture (drawn at twice that for sharp text), for a slide, a post or a PDF. */
export async function renderCard(data: CardData, theme: 'dark' | 'light' = 'dark'): Promise<HTMLCanvasElement> {
  const c = PALETTES[theme];
  await Promise.all(
    [`700 56px ${DISPLAY}`, `400 18px ${SANS}`, `600 18px ${SANS}`, `400 26px ${MONO}`].map((f) =>
      document.fonts.load(f).catch(() => []),
    ),
  );
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2D canvas');
  g.scale(2, 2);
  g.textBaseline = 'alphabetic';

  g.fillStyle = c.bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = c.line;
  g.lineWidth = 2;
  roundRect(g, 1, 1, W - 2, H - 2, 18);
  g.stroke();

  g.fillStyle = c.quiet;
  g.font = `400 18px ${SANS}`;
  g.fillText(data.kicker, PAD, 66);

  const tone = TONE[data.tone];
  g.fillStyle = c[tone === 'yes' ? 'pass' : tone === 'no' ? 'fail' : 'warn'];
  g.font = `700 56px ${DISPLAY}`;
  g.fillText(`${ICON[tone]} ${data.verdict}`, PAD, 130);

  g.fillStyle = c.ink;
  g.font = `600 22px ${SANS}`;
  g.fillText(data.place, PAD, 172);
  g.fillStyle = c.quiet;
  g.font = `400 18px ${SANS}`;
  g.fillText(data.when, PAD, 202);

  // The four checks down the start column.
  let y = 252;
  for (const row of data.checks) {
    const colour = c[row.tone === 'yes' ? 'pass' : row.tone === 'no' ? 'fail' : 'warn'];
    g.fillStyle = c.raised;
    roundRect(g, PAD, y - 30, 560, 44, 10);
    g.fill();
    g.fillStyle = colour;
    g.font = `600 18px ${SANS}`;
    g.fillText(ICON[row.tone], PAD + 14, y - 2);
    g.fillStyle = c.ink;
    g.font = `400 17px ${SANS}`;
    g.fillText(row.label, PAD + 40, y - 2);
    g.fillStyle = colour;
    g.font = `600 17px ${SANS}`;
    g.textAlign = 'right';
    g.fillText(row.value, PAD + 546, y - 2);
    g.textAlign = 'left';
    y += 54;
  }

  // The readings in tiles down the end column, two to a row.
  const tileW = 236;
  const tileX = W - PAD - tileW * 2 - 12;
  data.stats.forEach((s, i) => {
    const x = tileX + (i % 2) * (tileW + 12);
    const top = 222 + Math.floor(i / 2) * 88;
    g.fillStyle = c.raised;
    roundRect(g, x, top, tileW, 76, 10);
    g.fill();
    g.fillStyle = c.quiet;
    g.font = `400 14px ${SANS}`;
    g.fillText(s.label, x + 14, top + 26);
    g.fillStyle = c.ink;
    g.font = `400 26px ${MONO}`;
    g.fillText(s.value, x + 14, top + 60);
  });

  g.fillStyle = c.warn;
  g.font = `400 15px ${SANS}`;
  const below = wrap(g, data.note, PAD, 492, W - PAD * 2, 21);
  g.fillStyle = c.quiet;
  g.font = `400 13px ${SANS}`;
  wrap(g, data.sources, PAD, Math.max(below + 6, 556), W - PAD * 2, 18);
  g.fillStyle = c.accent;
  g.font = `400 14px ${MONO}`;
  g.fillText(data.link, PAD, 616, W - PAD * 2);
  g.fillStyle = c.quiet;
  g.font = `400 13px ${SANS}`;
  g.fillText(data.footer, PAD, 645, W - PAD * 2);
  return canvas;
}
