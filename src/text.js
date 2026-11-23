import { stripVTControlCharacters } from 'node:util';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const graphemes = (text) => Array.from(segmenter.segment(text), (part) => part.segment);

// Post text is written by strangers. Without this, a crafted post could send
// escape codes to your terminal or reorder text with bidi controls.
export function sanitizeText(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '')
    .trim();
}

// X escapes these three in post text. They are undone once, where that text
// comes in, because a second pass would turn a post's literal "&lt;" into "<".
export const decodeEntities = (text) => text
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

export const singleLine = (text) => sanitizeText(text).replace(/\s+/g, ' ');

// A word is a run of letters, digits and underscores, so `type:reply` is two
// and `@some_name` is one. Marks and joiners carry a word on, which keeps
// accents and joined scripts in one piece, but cannot begin one: the selector
// and joiners inside an emoji are not words, and stopping at them would leave
// the cursor in the middle of it.
const WORD = /[\p{L}\p{N}_][\p{L}\p{N}\p{M}_\u200c\u200d]*/gu;

// Where a word jump lands from `index`: on the start of the word before it...
export function wordStartBefore(text, index) {
  let start = 0;
  for (const word of text.matchAll(WORD)) {
    if (word.index >= index) break;
    start = word.index;
  }
  return start;
}

// ...or on the end of the word after it.
export function wordEndAfter(text, index) {
  for (const word of text.matchAll(WORD)) {
    const end = word.index + word[0].length;
    if (end > index) return end;
  }
  return text.length;
}

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

function graphemeWidth(grapheme) {
  const code = grapheme.codePointAt(0);
  if (grapheme.length === 1 && code >= 0x20 && code < 0x7f) return 1;
  if (/^[\p{M}\p{Cf}]+$/u.test(grapheme)) return 0;
  if (/\p{Emoji_Presentation}|️/u.test(grapheme)) return 2;
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}

export function displayWidth(text) {
  let width = 0;
  for (const grapheme of graphemes(text)) width += graphemeWidth(grapheme);
  return width;
}

export function truncate(text, width) {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let used = 0;
  let out = '';
  for (const grapheme of graphemes(text)) {
    const next = graphemeWidth(grapheme);
    if (used + next > width - 1) break;
    out += grapheme;
    used += next;
  }
  return `${out}…`;
}

export function fit(text, width) {
  const cut = truncate(text, width);
  return cut + ' '.repeat(Math.max(0, width - displayWidth(cut)));
}

export function wrap(text, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    let used = 0;
    const flush = () => {
      if (line) lines.push(line);
      line = '';
      used = 0;
    };

    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const size = displayWidth(word);
      if (size > width) {
        flush();
        for (const grapheme of graphemes(word)) {
          const next = graphemeWidth(grapheme);
          if (used + next > width) flush();
          line += grapheme;
          used += next;
        }
      } else {
        if (used > 0 && used + 1 + size > width) flush();
        line += (used > 0 ? ' ' : '') + word;
        used += (used > 0 ? 1 : 0) + size;
      }
    }
    flush();
  }
  return lines;
}
