import {
  EMPTY_FILTER, formatFilter, parseFilter, toggleKind, withoutUser, withTweet, withUser,
} from '../filter.js';
import { graphemes, singleLine } from '../text.js';
import { KeyParser } from './keys.js';
import { layout, renderScreen } from './render.js';

const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h\x1b[2J';
const LEAVE_SCREEN = '\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[0m\x1b[?1049l';
const FRAME_MS = 33;
const ESCAPE_WAIT_MS = 40;
const INTENSITY_STEP = 5;

const userOf = (event) => event.actorHandle?.toLowerCase() ?? event.actorId;

export class Tui {
  #session;
  #stdin;
  #stdout;
  #onQuit;
  #color;
  #parser = new KeyParser();
  #selectedKey = null;
  #scrollTop = 0;
  #edit = null;
  #frame = [];
  #frameTimer = null;
  #escapeTimer = null;
  #active = false;
  #console = null;

  constructor(session, { stdin = process.stdin, stdout = process.stdout, onQuit, color = !process.env.NO_COLOR }) {
    this.#session = session;
    this.#stdin = stdin;
    this.#stdout = stdout;
    this.#onQuit = onQuit;
    this.#color = color;
  }

  start() {
    this.#active = true;
    this.#stdout.write(ENTER_SCREEN);
    this.#stdin.setRawMode(true);
    this.#stdin.setEncoding('utf8');
    this.#stdin.resume();
    this.#stdin.on('data', this.#onData);
    this.#stdout.on('resize', this.#onResize);
    process.on('exit', this.#restore);

    // Anything printed now would corrupt the screen, so show it as a notice.
    this.#console = { log: console.log, warn: console.warn, error: console.error };
    const toNotice = (...args) => this.#session.notify(args.join(' '));
    console.log = toNotice;
    console.warn = toNotice;
    console.error = toNotice;

    this.#session.onChange = () => this.requestRender();
    this.render();
  }

  stop() {
    if (!this.#active) return;
    this.#session.onChange = () => {};
    clearTimeout(this.#frameTimer);
    clearTimeout(this.#escapeTimer);
    this.#stdin.off('data', this.#onData);
    this.#stdout.off('resize', this.#onResize);
    process.off('exit', this.#restore);
    Object.assign(console, this.#console);
    this.#restore();
    this.#stdin.pause();
  }

  #restore = () => {
    if (!this.#active) return;
    this.#active = false;
    this.#stdin.setRawMode(false);
    this.#stdout.write(LEAVE_SCREEN);
  };

  #onResize = () => {
    this.#frame = [];
    this.#stdout.write('\x1b[2J');
    this.render();
  };

  #onData = (chunk) => {
    clearTimeout(this.#escapeTimer);
    for (const key of this.#parser.push(chunk)) this.handleKey(key);
    if (this.#parser.pending) {
      this.#escapeTimer = setTimeout(() => {
        for (const key of this.#parser.flush()) this.handleKey(key);
      }, ESCAPE_WAIT_MS);
    }
  };

  requestRender() {
    this.#frameTimer ??= setTimeout(() => {
      this.#frameTimer = null;
      this.render();
    }, FRAME_MS);
  }

  get #size() {
    return { cols: this.#stdout.columns || 80, rows: this.#stdout.rows || 24 };
  }

  #activeFilter() {
    return this.#edit?.preview ?? this.#session.filter;
  }

  #list() {
    return this.#session.visible(this.#activeFilter());
  }

  #selectedIndex(events) {
    if (this.#selectedKey === null) return 0;
    const index = events.findIndex((event) => event.key === this.#selectedKey);
    if (index >= 0) return index;
    this.#selectedKey = null;
    return 0;
  }

  view() {
    const session = this.#session;
    const events = this.#list();
    const selectedIndex = this.#selectedIndex(events);
    const { list } = layout(this.#size.rows);
    if (selectedIndex < this.#scrollTop) this.#scrollTop = selectedIndex;
    if (selectedIndex >= this.#scrollTop + list) this.#scrollTop = selectedIndex - list + 1;
    this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, Math.max(0, events.length - list)));

    const selected = events[selectedIndex] ?? null;
    const filter = this.#activeFilter();
    return {
      username: session.username,
      stream: session.stream,
      device: session.device,
      paused: session.paused,
      intensityPct: session.intensityPct,
      levelPct: session.levelPct,
      active: session.active,
      cost: session.cost.snapshot(),
      filterText: formatFilter(session.filter),
      filterKinds: filter.kinds,
      edit: this.#edit,
      events,
      total: session.events.length,
      selected,
      selectedIndex,
      scrollTop: this.#scrollTop,
      notice: session.notice,
      lookupEstimate: session.lookupEstimate(selected),
    };
  }

  render() {
    if (!this.#active) return;
    const { lines, cursor } = renderScreen(this.view(), { ...this.#size, color: this.#color });
    let out = '\x1b[?2026h';
    lines.forEach((line, index) => {
      if (this.#frame[index] !== line) out += `\x1b[${index + 1};1H${line}`;
    });
    this.#frame = lines;
    out += cursor ? `\x1b[${cursor.row};${cursor.col}H\x1b[?25h` : '\x1b[?25l';
    out += '\x1b[?2026l';
    this.#stdout.write(out);
  }

  handleKey(key) {
    if (key.name === 'ctrl-c') {
      this.#onQuit();
      return;
    }
    if (this.#edit) this.#editKey(key);
    else this.#commandKey(key);
    this.requestRender();
  }

  #commandKey(key) {
    const session = this.#session;
    const events = this.#list();
    const selected = events[this.#selectedIndex(events)] ?? null;
    const page = Math.max(1, layout(this.#size.rows).list - 1);

    switch (key.name) {
      case 'left': session.adjustIntensity(-INTENSITY_STEP); return;
      case 'right': session.adjustIntensity(INTENSITY_STEP); return;
      case 'up': this.#move(-1, events); return;
      case 'down': this.#move(1, events); return;
      case 'pageup': this.#move(-page, events); return;
      case 'pagedown': this.#move(page, events); return;
      case 'home': this.#move(-events.length, events); return;
      case 'end': this.#move(events.length, events); return;
      case 'paste': this.#beginEdit(singleLine(key.text)); return;
      case 'char': break;
      default: return;
    }

    switch (key.text) {
      case ' ': session.togglePause(); break;
      case 'q': this.#onQuit(); break;
      case '-': case '_': session.adjustIntensity(-INTENSITY_STEP); break;
      case '+': case '=': session.adjustIntensity(INTENSITY_STEP); break;
      case 'k': this.#move(-1, events); break;
      case 'j': this.#move(1, events); break;
      case 'g': this.#move(-events.length, events); break;
      case 'G': this.#move(events.length, events); break;
      case '/': this.#beginEdit(formatFilter(session.filter)); break;
      case '1': this.#applyFilter(toggleKind(session.filter, 'like')); break;
      case '2': this.#applyFilter(toggleKind(session.filter, 'retweet')); break;
      case '3': this.#applyFilter(toggleKind(session.filter, 'reply')); break;
      case 'c': this.#applyFilter(EMPTY_FILTER); break;
      case 't':
        if (selected?.tweetId) this.#applyFilter(withTweet(session.filter, selected.tweetId));
        break;
      case 'u':
        if (selected) this.#applyFilter(withUser(session.filter, userOf(selected)));
        break;
      case 'x':
        if (selected) this.#applyFilter(withoutUser(session.filter, userOf(selected)));
        break;
      case 'f': session.lookup(selected); break;
      default:
    }
  }

  #move(delta, events) {
    if (events.length === 0) return;
    const next = Math.max(0, Math.min(events.length - 1, this.#selectedIndex(events) + delta));
    this.#selectedKey = next === 0 ? null : events[next].key;
  }

  #applyFilter(filter) {
    this.#session.setFilter(filter);
    this.#selectedKey = null;
    this.#scrollTop = 0;
  }

  #beginEdit(text) {
    this.#edit = { text: '', cursor: 0, error: null, preview: null };
    this.#setDraft(text, text.length);
  }

  #setDraft(text, cursor) {
    const edit = this.#edit;
    edit.text = text;
    edit.cursor = cursor;
    try {
      edit.preview = parseFilter(text);
      edit.error = null;
    } catch (error) {
      edit.error = error.message;
    }
    this.#selectedKey = null;
    this.#scrollTop = 0;
  }

  #editKey(key) {
    const edit = this.#edit;
    const { text, cursor } = edit;
    const before = text.slice(0, cursor);
    const after = text.slice(cursor);

    switch (key.name) {
      case 'char': this.#setDraft(before + key.text + after, cursor + key.text.length); break;
      case 'paste': {
        const pasted = singleLine(key.text);
        this.#setDraft(before + pasted + after, cursor + pasted.length);
        break;
      }
      case 'backspace': {
        const removed = graphemes(before).at(-1)?.length ?? 0;
        if (removed) this.#setDraft(before.slice(0, -removed) + after, cursor - removed);
        break;
      }
      case 'delete': {
        const removed = graphemes(after)[0]?.length ?? 0;
        if (removed) this.#setDraft(before + after.slice(removed), cursor);
        break;
      }
      case 'left': edit.cursor -= graphemes(before).at(-1)?.length ?? 0; break;
      case 'right': edit.cursor += graphemes(after)[0]?.length ?? 0; break;
      case 'home': case 'ctrl-a': edit.cursor = 0; break;
      case 'end': case 'ctrl-e': edit.cursor = text.length; break;
      case 'ctrl-u': this.#setDraft(after, 0); break;
      case 'escape':
        this.#edit = null;
        this.#selectedKey = null;
        this.#scrollTop = 0;
        break;
      case 'enter':
        if (!edit.error) {
          const filter = edit.preview;
          this.#edit = null;
          this.#applyFilter(filter);
        }
        break;
      default:
    }
  }
}
