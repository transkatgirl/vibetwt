import { formatUsd } from '../cost.js';
import { KINDS } from '../filter.js';
import { displayWidth, fit, graphemes, singleLine, truncate, wrap } from '../text.js';

const GLYPHS = { like: '♥', retweet: '↻', reply: '↩' };
const LABELS = { like: 'Like', retweet: 'Retweet', reply: 'Reply' };
const COLORS = { like: 'magenta', retweet: 'green', reply: 'cyan' };
const SGR = {
  bold: 1, dim: 2, reverse: 7, red: 31, green: 32, yellow: 33, magenta: 35, cyan: 36,
};
const COLOR_NAMES = new Set(['red', 'green', 'yellow', 'magenta', 'cyan']);
const RESET = '\x1b[0m';
const MIN_COLS = 44;
const MIN_ROWS = 12;

const s = (text, ...styles) => ({ text, styles });

function sgr(styles, color) {
  const codes = styles.filter((style) => color || !COLOR_NAMES.has(style)).map((style) => SGR[style]);
  return codes.length > 0 ? `\x1b[${codes.join(';')}m` : '';
}

// Draws spans into exactly `width` cells, so a line can never wrap.
function paint(spans, width, color, base = []) {
  let used = 0;
  let out = '';
  for (const { text, styles } of spans) {
    if (used >= width) break;
    const piece = truncate(text, width - used);
    used += displayWidth(piece);
    out += `${sgr([...base, ...styles], color)}${piece}${RESET}`;
  }
  if (used < width) out += `${sgr(base, color)}${' '.repeat(width - used)}${RESET}`;
  return out;
}

const spanWidth = (spans) => spans.reduce((sum, span) => sum + displayWidth(span.text), 0);

function between(left, right, width) {
  const gap = width - spanWidth(left) - spanWidth(right);
  return gap >= 1 ? [...left, s(' '.repeat(gap)), ...right] : left;
}

export function layout(rows) {
  const detail = rows >= 24 ? 7 : rows >= 18 ? 4 : 0;
  const chrome = 7 + (detail > 0 ? detail + 1 : 0);
  return { list: Math.max(1, rows - chrome), detail };
}

function titleLine(view, cols) {
  const streamState = {
    live: ['green', 'X live'],
    connecting: ['yellow', 'X connecting'],
    reconnecting: ['yellow', 'X reconnecting'],
  }[view.stream] ?? ['red', 'X offline'];
  const { connected, devices } = view.device;
  const deviceState = !connected
    ? ['red', 'Intiface offline']
    : devices.length === 0
      ? ['yellow', 'scanning for device']
      : ['green', devices.length > 1 ? `${devices.length} devices` : devices[0]];

  const left = [s(' vibetwt', 'bold'), s(view.username ? `  @${view.username}` : '', 'dim')];
  const room = Math.max(10, cols - spanWidth(left) - spanWidth([s(streamState[1])]) - 9);
  const right = [
    s('● ', streamState[0]), s(streamState[1]),
    s('   ● ', deviceState[0]), s(`${truncate(singleLine(deviceState[1]), room)} `),
  ];
  return between(left, right, cols);
}

function bar(fraction, width, on, off, ...styles) {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return [s(on.repeat(filled), ...styles), s(off.repeat(width - filled), 'dim')];
}

function strengthLine(view, cols) {
  const barWidth = cols >= 72 ? 20 : 10;
  const left = [
    s(' Strength ', 'dim'),
    ...bar(view.intensityPct / 100, barWidth, '━', '─', 'magenta'),
    s(` ${String(view.intensityPct).padStart(3)}%`, 'bold'),
    s('   Now ', 'dim'),
    ...bar(view.paused ? 0 : view.levelPct / 100, 8, '▮', '▯', 'cyan'),
  ];
  const right = view.paused
    ? [s(' PAUSED ', 'yellow', 'reverse', 'bold'), s(' ')]
    : [...view.active.flatMap((kind) => [s(`${GLYPHS[kind]} `, COLORS[kind], 'bold')])];
  return between(left, right, cols);
}

function costLine(view) {
  const { cost } = view;
  const spans = [s(' Est. cost ', 'dim'), s(formatUsd(cost.totalMicros), 'bold')];
  for (const kind of KINDS) {
    const { count, micros } = cost.events[kind];
    spans.push(s(`   ${GLYPHS[kind]} `, COLORS[kind]), s(`${count} `), s(formatUsd(micros), 'dim'));
  }
  if (cost.lookups.count > 0) spans.push(s('   fetches ', 'dim'), s(formatUsd(cost.lookups.micros), 'dim'));
  return spans;
}

function filterLine(view, cols) {
  const count = `${view.events.length}/${view.total} `;
  const toggles = KINDS.flatMap((kind, index) => {
    const on = view.filterKinds.includes(kind);
    return [s(`${index + 1}`, 'dim'), s(`${GLYPHS[kind]} `, ...(on ? [COLORS[kind], 'bold'] : ['dim']))];
  });
  const right = [...(cols >= 64 ? toggles : []), s(` ${count}`, 'dim')];

  if (view.edit) {
    const label = ' Filter › ';
    const room = Math.max(4, cols - displayWidth(label) - spanWidth(right) - 1);
    const { text, cursor } = fitInput(view.edit.text, view.edit.cursor, room);
    return {
      spans: between([s(label, 'yellow', 'bold'), s(text)], right, cols),
      cursorCol: displayWidth(label) + cursor + 1,
    };
  }
  return {
    spans: between(
      [s(' Filter ', 'dim'), view.filterText ? s(view.filterText, 'yellow') : s('all events', 'dim')],
      right,
      cols,
    ),
    cursorCol: null,
  };
}

// Scrolls the input horizontally so the cursor stays visible.
function fitInput(text, cursor, width) {
  const before = graphemes(text.slice(0, cursor));
  let shown = '';
  let used = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const size = displayWidth(before[i]);
    if (used + size > width - 1) break;
    shown = before[i] + shown;
    used += size;
  }
  const after = truncate(text.slice(cursor), width - used);
  return { text: shown + after, cursor: used };
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });

function summary(event) {
  const body = event.kind === 'reply' ? event.text : event.tweetText;
  return body ? singleLine(body) : `tweet …${String(event.tweetId ?? event.postId ?? '').slice(-6)}`;
}

function eventRow(event, cols, selected, color) {
  const wide = cols >= 76;
  const actorWidth = wide ? 18 : 12;
  const spans = [
    s(wide ? ` ${clock(event.createdAt)}  ` : ' ', 'dim'),
    s(`${GLYPHS[event.kind]} `, COLORS[event.kind], 'bold'),
    ...(wide ? [s(LABELS[event.kind].padEnd(8), COLORS[event.kind])] : []),
    s(`${fit(event.actor, actorWidth)} `, 'bold'),
    s(summary(event), event.text || event.tweetText ? undefined : 'dim'),
  ].map((span) => ({ ...span, styles: span.styles.filter(Boolean) }));
  return paint(spans, cols, color, selected ? ['reverse'] : []);
}

function detailLines(view, cols, height) {
  const event = view.selected;
  if (!event) return Array.from({ length: height }, () => []);

  const width = cols - 2;
  const header = [
    s(` ${GLYPHS[event.kind]} ${LABELS[event.kind]}`, COLORS[event.kind], 'bold'),
    s(' from ', 'dim'),
    s(event.actor, 'bold'),
    s(`  ${clock(event.createdAt)}  ${event.outcome}`, 'dim'),
  ];

  const body = [];
  if (event.kind === 'reply') {
    body.push(...wrap(event.text ?? '(no text in this event)', width).map((line) => [s(` ${line}`)]));
    if (event.tweetText) body.push([s(` on: ${singleLine(event.tweetText)}`, 'dim')]);
  } else if (event.tweetText) {
    body.push(...wrap(event.tweetText, width).map((line) => [s(` ${line}`)]));
  } else {
    body.push([s(' Tweet text was not included in this event.', 'dim')]);
  }

  const room = height - 2;
  const shown = body.slice(0, room);
  if (body.length > room && shown.length > 0) {
    const last = shown[shown.length - 1][0];
    // Cut as one piece, since a line cut first would already end in an ellipsis.
    shown[shown.length - 1] = [s(truncate(`${last.text}…`, width), ...last.styles)];
  }
  while (shown.length < room) shown.push([]);

  const id = event.tweetId ?? event.postId;
  const link = id ? [s(` https://x.com/i/status/${id}`, 'dim')] : [];
  const fetch = view.lookupEstimate > 0
    ? [s('f', 'bold'), s(` fetch missing info ~${formatUsd(view.lookupEstimate)} `, 'yellow')]
    : [];
  const bothFit = spanWidth(link) + spanWidth(fetch) + 1 <= cols;
  const footer = bothFit ? between(link, fetch, cols) : [s(' '), ...fetch];
  return [header, ...shown, fetch.length > 0 ? footer : link];
}

const HINTS = [
  ['space', 'pause'], ['←→', 'strength'], ['q', 'quit'], ['/', 'filter'], ['↑↓', 'select'],
  ['t', 'this tweet'], ['u', 'this user'], ['x', 'hide user'], ['c', 'clear'], ['1-3', 'types'], ['f', 'fetch'],
];
const EDIT_HINTS = [
  ['enter', 'apply'], ['esc', 'cancel'], ['ctrl+c', 'stop & quit'],
  ['a b', 'both'], ['a OR b', 'either'], ['NOT a', 'exclude'], ['( )', 'group'],
];

function hintLine(hints, cols) {
  const spans = [s(' ')];
  let used = 1;
  for (const [key, label] of hints) {
    const size = displayWidth(key) + displayWidth(label) + 3;
    if (used + size > cols) break;
    spans.push(s(key, 'bold'), s(` ${label}  `, 'dim'));
    used += size;
  }
  return spans;
}

function tinyScreen(view, cols, rows, color) {
  const lines = [
    [s(view.paused ? ' PAUSED' : ' Running', 'bold')],
    [s(` Strength ${view.intensityPct}%`)],
    [s(` Cost ${formatUsd(view.cost.totalMicros)}`)],
    [s(' space pause  q quit', 'dim')],
  ];
  return {
    lines: Array.from({ length: rows }, (_, index) => paint(lines[index] ?? [], cols, color)),
    cursor: null,
  };
}

export function renderScreen(view, { cols, rows, color = true }) {
  if (cols < MIN_COLS || rows < MIN_ROWS) return tinyScreen(view, cols, rows, color);

  const { list, detail } = layout(rows);
  const filter = filterLine(view, cols);
  const rule = paint([s('─'.repeat(cols), 'dim')], cols, color);
  const lines = [
    paint(titleLine(view, cols), cols, color),
    paint(strengthLine(view, cols), cols, color),
    paint(costLine(view), cols, color),
    paint(filter.spans, cols, color),
    rule,
  ];

  const visible = view.events.slice(view.scrollTop, view.scrollTop + list);
  for (let row = 0; row < list; row++) {
    const event = visible[row];
    if (event) {
      lines.push(eventRow(event, cols, view.scrollTop + row === view.selectedIndex, color));
    } else if (row === 0) {
      const empty = view.total === 0 ? ' Waiting for notifications…' : ' No events match this filter.';
      lines.push(paint([s(empty, 'dim')], cols, color));
    } else {
      lines.push(paint([], cols, color));
    }
  }

  if (detail > 0) {
    lines.push(rule);
    for (const spans of detailLines(view, cols, detail)) lines.push(paint(spans, cols, color));
  }

  const notice = view.edit?.error
    ? [s(` ${view.edit.error}`, 'red')]
    : view.notice
      ? [s(` ${view.notice}`, 'yellow')]
      : [];
  lines.push(paint(notice, cols, color));
  lines.push(paint(hintLine(view.edit ? EDIT_HINTS : HINTS, cols), cols, color));

  return { lines, cursor: filter.cursorCol === null ? null : { row: 4, col: filter.cursorCol } };
}
