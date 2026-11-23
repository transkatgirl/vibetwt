const CSI_LETTERS = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const CSI_NUMBERS = { 1: 'home', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' };
const CONTROL = {
  '\r': 'enter',
  '\n': 'enter',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\x01': 'ctrl-a',
  '\x03': 'ctrl-c',
  '\x05': 'ctrl-e',
  '\x15': 'ctrl-u',
  '\x17': 'ctrl-w',
};
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const MAX_PASTE = 4096;
const SEQUENCE = /^\x1b(?:\[([0-9;?]*)([@-~])|O([@-~]))/;
const UNFINISHED = /^\x1b\x1b?(?:\[[0-9;?]*|O)?$/;
// A sequence counts its modifiers as one more than their sum: Shift is 1, Alt
// is 2, Ctrl is 4 and Meta is 8. Option comes through as Alt or as Meta.
const ALT_MODIFIERS = 2 + 8;
// What Option+←, Option+→ and Option+Delete send where Option is not put
// inside an arrow's sequence: readline's keys for moving and deleting by word.
const ALT_KEYS = { b: 'wordleft', f: 'wordright', '\x7f': 'wordbackspace', '\b': 'wordbackspace' };

// Turns raw terminal input into keys. Pastes arrive as a single key so that a
// pasted URL cannot trigger shortcuts such as "q" to quit.
export class KeyParser {
  #buffer = '';
  #paste = null;

  get pending() {
    return this.#buffer.length > 0 && this.#paste === null;
  }

  // Inside a paste whose end has not arrived yet.
  get pasting() {
    return this.#paste !== null;
  }

  push(chunk) {
    // A terminal sends a paste in large pieces, so a read that is nothing but
    // Ctrl+C was pressed, not pasted. It gets through even when a paste's end
    // never comes, which would otherwise swallow it with every other key.
    if (this.#paste !== null && /^\x03+$/.test(chunk)) return Array.from(chunk, () => ({ name: 'ctrl-c' }));

    // An Escape still waiting when more arrives was the key itself, unless
    // what arrives carries on its sequence.
    const escape = this.pending && this.#buffer === '\x1b' && chunk && !/^[[O]/.test(chunk);
    this.#buffer = escape ? chunk : this.#buffer + chunk;
    return [...(escape ? [{ name: 'escape' }] : []), ...this.#drain(false)];
  }

  // A lone Escape looks like the start of a sequence until no more arrives.
  // A paste still open by then is not going to end. It is dropped, along with
  // whatever was typed into it, so that the keys after it are keys again.
  flush() {
    if (this.#paste !== null) {
      this.#paste = null;
      this.#buffer = '';
      return [];
    }
    return this.#drain(true);
  }

  #drain(final) {
    const keys = [];
    while (this.#buffer) {
      if (this.#paste !== null) {
        const end = this.#buffer.indexOf(PASTE_END);
        if (end < 0) {
          const safe = Math.max(0, this.#buffer.length - PASTE_END.length + 1);
          this.#paste = (this.#paste + this.#buffer.slice(0, safe)).slice(0, MAX_PASTE);
          this.#buffer = this.#buffer.slice(safe);
          break;
        }
        keys.push({ name: 'paste', text: (this.#paste + this.#buffer.slice(0, end)).slice(0, MAX_PASTE) });
        this.#paste = null;
        this.#buffer = this.#buffer.slice(end + PASTE_END.length);
        continue;
      }

      if (this.#buffer.startsWith(PASTE_START)) {
        this.#paste = '';
        this.#buffer = this.#buffer.slice(PASTE_START.length);
        continue;
      }

      if (this.#buffer[0] === '\x1b') {
        // Alt or Option sends Escape and then the key, in one read. An arrow is
        // still that arrow, marked as it is when the modifier is sent inside
        // its sequence (\x1b[1;3D).
        const alt = this.#buffer[1] === '\x1b' && !this.#buffer.startsWith(PASTE_START, 1) ? 1 : 0;
        const sequence = this.#buffer.slice(alt).match(SEQUENCE);
        if (sequence) {
          const name = sequence[3]
            ? CSI_LETTERS[sequence[3]]
            : sequence[2] === '~'
              ? CSI_NUMBERS[sequence[1].split(';')[0]]
              : CSI_LETTERS[sequence[2]];
          const modifiers = (Number(sequence[1]?.split(';')[1]) || 1) - 1;
          if (name) keys.push(alt || modifiers & ALT_MODIFIERS ? { name, alt: true } : { name });
          this.#buffer = this.#buffer.slice(alt + sequence[0].length);
          continue;
        }
        if (!final && UNFINISHED.test(this.#buffer)) break;

        // On anything else it is never Escape and then that key, so a word
        // jump in the filter prompt cannot cancel it and press "f". It is a
        // key of its own if it has a meaning here, and nothing if not.
        const next = this.#buffer.length > 1 ? String.fromCodePoint(this.#buffer.codePointAt(1)) : '';
        if (next && next !== '\x1b' && next !== '\x03') {
          if (Object.hasOwn(ALT_KEYS, next)) keys.push({ name: ALT_KEYS[next] });
          this.#buffer = this.#buffer.slice(1 + next.length);
          continue;
        }
        keys.push({ name: 'escape' });
        this.#buffer = this.#buffer.slice(1);
        continue;
      }

      const char = String.fromCodePoint(this.#buffer.codePointAt(0));
      this.#buffer = this.#buffer.slice(char.length);
      if (CONTROL[char]) keys.push({ name: CONTROL[char] });
      else if (char >= ' ' && !/[\u007f-\u009f]/.test(char)) keys.push({ name: 'char', text: char });
    }
    return keys;
  }
}
