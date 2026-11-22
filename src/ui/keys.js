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
};
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const MAX_PASTE = 4096;

// Turns raw terminal input into keys. Pastes arrive as a single key so that a
// pasted URL cannot trigger shortcuts such as "q" to quit.
export class KeyParser {
  #buffer = '';
  #paste = null;

  get pending() {
    return this.#buffer.length > 0 && this.#paste === null;
  }

  push(chunk) {
    this.#buffer += chunk;
    return this.#drain(false);
  }

  // A lone Escape looks like the start of a sequence until no more arrives.
  flush() {
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
        const sequence = this.#buffer.match(/^\x1b(?:\[([0-9;?]*)([@-~])|O([@-~]))/);
        if (sequence) {
          const name = sequence[3]
            ? CSI_LETTERS[sequence[3]]
            : sequence[2] === '~'
              ? CSI_NUMBERS[sequence[1].split(';')[0]]
              : CSI_LETTERS[sequence[2]];
          if (name) keys.push({ name });
          this.#buffer = this.#buffer.slice(sequence[0].length);
          continue;
        }
        if (!final && /^\x1b(?:\[[0-9;?]*|O)?$/.test(this.#buffer)) break;
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
