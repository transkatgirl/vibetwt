// Lets many voices drive one device, the way vibeclaude's DeviceMixer does.
// The device plays the strongest of what the channels ask for, so overlapping
// patterns fill each other's gaps. Intensity is one multiplier, applied after mixing.
// A device answers slower than events can arrive, so it is only ever sent the
// latest level, never a backlog.
export class Mixer {
  #output;
  #log;
  #onChange;
  #levels = new Map();
  #intensity;
  #muted = false;
  #closed = false;
  #wanted = 0;
  #sent = 0;
  #generation = 0;
  #isDraining = false;
  #draining = Promise.resolve();
  #retry = null;
  #lastError = '';

  constructor(output, { intensity = 1, log = () => {}, onChange = () => {} } = {}) {
    this.#output = output;
    this.#intensity = intensity;
    this.#log = log;
    this.#onChange = onChange;
  }

  get intensity() {
    return this.#intensity;
  }

  get level() {
    return this.#wanted;
  }

  channel() {
    const channel = {
      set: (level) => {
        this.#levels.set(channel, level);
        this.#update();
      },
    };
    return channel;
  }

  release(channel) {
    this.#levels.delete(channel);
    this.#update();
  }

  setIntensity(intensity) {
    this.#intensity = intensity;
    this.#update();
  }

  setMuted(muted) {
    this.#muted = muted;
    this.#update();
    if (muted) this.#stopPastQueue();
  }

  // The device may have just reconnected, so its state is unknown. Send it
  // what should be playing, which is a stop if nothing is.
  resync() {
    this.#generation++;
    this.#sent = undefined;
    this.#update();
  }

  async settled() {
    while (this.#isDraining) await this.#draining;
  }

  async close() {
    this.#closed = true;
    clearTimeout(this.#retry);
    this.#levels.clear();
    this.#muted = true;
    this.#update();
    this.#stopPastQueue();
    await this.settled();
  }

  #update() {
    const strongest = Math.max(0, ...this.#levels.values());
    const wanted = this.#muted ? 0 : strongest * this.#intensity;
    if (wanted !== this.#wanted) {
      this.#wanted = wanted;
      this.#onChange();
    }
    if (wanted !== this.#sent && !this.#isDraining) this.#draining = this.#drain();
  }

  // A stop should not wait behind a command a slow device has yet to answer.
  // Commands stay in order on the socket, so nothing older can land after it.
  #stopPastQueue() {
    if (this.#isDraining) this.#output.stop().catch((error) => this.#report(error));
  }

  // The flag is cleared in the same tick the loop exits, so a level asked for
  // just as it ends always starts a new drain.
  async #drain() {
    this.#isDraining = true;
    try {
      while (this.#wanted !== this.#sent) {
        const level = this.#wanted;
        const generation = this.#generation;
        try {
          await (level > 0 ? this.#output.set(level) : this.#output.stop());
          if (generation === this.#generation) this.#sent = level;
          this.#lastError = '';
        } catch (error) {
          this.#sent = undefined;
          this.#report(error);
          if (!this.#closed) {
            this.#retry ??= setTimeout(() => {
              this.#retry = null;
              this.#update();
            }, 500);
            this.#retry.unref?.();
          }
          return;
        }
      }
    } finally {
      this.#isDraining = false;
    }
  }

  #report(error) {
    if (error.message === this.#lastError) return;
    this.#lastError = error.message;
    this.#log(`Device command failed: ${error.message}`);
  }
}
