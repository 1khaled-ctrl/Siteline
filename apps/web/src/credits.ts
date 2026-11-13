import creditsMd from '../../../CREDITS.md?raw';

/** One dataset row of CREDITS.md, its cells still in Markdown. */
export interface Credit {
  id: string;
  what: string;
  licence: string;
  source: string;
}

/** A run of Markdown text: plain, `code`, or a [link](url). Bare https addresses become links too. */
export type Span = { text: string } | { code: string } | { label: string; url: string };

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/** The dataset table under "## Data": one entry per row, in the file's order. */
export function parseCredits(md: string): Credit[] {
  const lines = md.split(/\r?\n/);
  const head = lines.findIndex((l) => l.trim().startsWith('|') && cells(l).some((c) => c.toLowerCase() === 'id'));
  if (head < 0) return [];
  const names = cells(lines[head]).map((n) => n.toLowerCase());
  const col = (name: string) => names.indexOf(name);
  const out: Credit[] = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.trim().startsWith('|')) break;
    const c = cells(line);
    out.push({ id: c[col('id')], what: c[col('what')], licence: c[col('licence')], source: c[col('source')] });
  }
  return out;
}

/** The paragraphs under a "## <heading>" of CREDITS.md, joined; empty if there is no such heading. */
export function creditsSection(md: string, heading: string): string {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const INLINE = /`([^`]+)`|\[([^\]]+)\]\((https?:[^)\s]+)\)|(https?:\/\/[^\s)]+[^\s).,;])/g;

/** Splits Markdown text into plain runs, code and links; anything else stays as written. */
export function spans(md: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of md.matchAll(INLINE)) {
    if (m.index > last) out.push({ text: md.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ code: m[1] });
    else if (m[2] !== undefined) out.push({ label: m[2], url: m[3] });
    else out.push({ label: m[4], url: m[4] });
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push({ text: md.slice(last) });
  return out;
}

export const CREDITS: readonly Credit[] = parseCredits(creditsMd);
export const FONTS_NOTE = creditsSection(creditsMd, 'Fonts');
export const LIBRARIES_NOTE = creditsSection(creditsMd, 'Libraries');
