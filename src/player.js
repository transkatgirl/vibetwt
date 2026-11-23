import { PATTERNS } from './patterns.js';

// More overlap than anyone could feel. Keeps a huge burst, such as a stream
// backfill, from running thousands of timers at once.
export const MAX_VOICES = 64;

// One event's pattern, on its own mixer channel for as long as it plays.
class Voice {
  #channel;
  #steps;
  #onEnd;
  #timer = null;
  #index = 0;

  constructor(kind, steps, channel, onEnd) {
    this.kind = kind;
    this.#steps = steps;
    this.#channel = channel;
    this.#onEnd = onEnd;
  }

  start() {
    this.#advance();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#onEnd(this, this.#channel);
  }

  #advance() {
    if (this.#index >= this.#steps.length) {
      this.stop();
      return;
    }
    const [level, ms] = this.#steps[this.#index++];
    this.#channel.set(level);
    this.#timer = setTimeout(() => this.#advance(), ms);
  }
}

export class PatternPlayer {
  #mixer;
  #onChange;
  #voices = new Set();
  #waiters = [];
  #paused = false;
  #closed = false;

  constructor(mixer, { onChange = () => {} } = {}) {
    this.#mixer = mixer;
    this.#onChange = onChange;
  }

  get paused() {
    return this.#paused;
  }

  get active() {
    const playing = new Set([...this.#voices].map((voice) => voice.kind));
    return Object.keys(PATTERNS).filter((kind) => playing.has(kind));
  }

  play(kind) {
    if (!Object.hasOwn(PATTERNS, kind)) throw new Error(`Unknown pattern: ${kind}`);
    if (this.#paused || this.#closed) return false;

    const voice = new Voice(kind, PATTERNS[kind].steps, this.#mixer.channel(), (ended, channel) => {
      this.#voiceEnded(ended, channel);
    });
    this.#voices.add(voice);
    voice.start();
    // The new voice is already playing, so dropping the oldest cannot cause a dip.
    if (this.#voices.size > MAX_VOICES) this.#voices.values().next().value.stop();
    this.#onChange();
    return true;
  }

  // Pausing cuts everything off at once. What was playing does not come back.
  setPaused(paused) {
    if (this.#closed || paused === this.#paused) return;
    this.#paused = paused;
    this.#mixer.setMuted(paused);
    if (paused) this.#stopVoices();
    this.#onChange();
  }

  async idle() {
    if (this.#voices.size > 0) await new Promise((resolve) => this.#waiters.push(resolve));
    await this.#mixer.settled();
  }

  // The mixer closes first so the device gets one stop, rather than stepping
  // down through the remaining voices as each one ends.
  async close() {
    this.#closed = true;
    const closing = this.#mixer.close();
    this.#stopVoices();
    await closing;
  }

  #stopVoices() {
    for (const voice of [...this.#voices]) voice.stop();
  }

  #voiceEnded(voice, channel) {
    this.#voices.delete(voice);
    this.#mixer.release(channel);
    this.#onChange();
    if (this.#voices.size === 0) {
      for (const resolve of this.#waiters.splice(0)) resolve();
    }
  }
}
