import { setTimeout as delay } from 'node:timers/promises';
import { XApiError } from './x-api.js';
import { LoginExpired } from './x-auth.js';

const MAX_FRAME_CHARS = 5_000_000;
const MAX_BACKFILL_MINUTES = 5;
const STABLE_CONNECTION_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
// X counts its rate limits in windows of fifteen minutes.
const MAX_RATE_LIMIT_WAIT_MS = 15 * 60_000;

// A wait as it is told: in seconds up to a minute and a half, and past that in
// minutes with the seconds left over. Rounding to the minute would call a wait
// of 90 seconds two minutes.
function duration(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const left = seconds % 60;
  return `${Math.floor(seconds / 60)} min${left ? ` ${left}s` : ''}`;
}

// X does not document this stream's framing, so split on complete JSON objects.
// This handles newline-delimited, concatenated, and blank keep-alive data.
export class JsonFrameSplitter {
  #buffer = '';
  #index = 0;
  #start = -1;
  #depth = 0;
  #inString = false;
  #escaped = false;

  push(text) {
    this.#buffer += text;
    if (this.#buffer.length > MAX_FRAME_CHARS) throw new Error('Stream frame too large.');

    const frames = [];
    for (; this.#index < this.#buffer.length; this.#index++) {
      const char = this.#buffer[this.#index];
      if (this.#start < 0) {
        if (char === '{') {
          this.#start = this.#index;
          this.#depth = 1;
        }
      } else if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (char === '\\') this.#escaped = true;
        else if (char === '"') this.#inString = false;
      } else if (char === '"') {
        this.#inString = true;
      } else if (char === '{') {
        this.#depth++;
      } else if (char === '}' && --this.#depth === 0) {
        frames.push(this.#buffer.slice(this.#start, this.#index + 1));
        this.#start = -1;
      }
    }

    const keepFrom = this.#start < 0 ? this.#buffer.length : this.#start;
    this.#buffer = this.#buffer.slice(keepFrom);
    this.#index -= keepFrom;
    if (this.#start >= 0) this.#start = 0;
    return frames;
  }
}

export class ActivityStream {
  #api;
  #onEvent;
  #log;
  #onStatus;
  #stallTimeoutMs;
  #openTimeoutMs;

  // The heartbeat interval is undocumented. This stays under the 5-minute
  // backfill limit so a silently dead connection can recover what it missed.
  // Opening gets far less: left alone, a request that X takes and never
  // answers is only given up on after that limit has already passed.
  constructor({
    api, onEvent, log = () => {}, onStatus = () => {}, stallTimeoutMs = 240_000, openTimeoutMs = 30_000,
  }) {
    this.#api = api;
    this.#onEvent = onEvent;
    this.#log = log;
    this.#onStatus = onStatus;
    this.#stallTimeoutMs = stallTimeoutMs;
    this.#openTimeoutMs = openTimeoutMs;
  }

  async run(signal) {
    let failures = 0;
    // Everything up to this moment has been received.
    let caughtUpAt = null;
    let backfillAllowed = true;

    while (!signal.aborted) {
      const backfill = caughtUpAt && backfillAllowed
        ? Math.min(MAX_BACKFILL_MINUTES, Math.ceil((Date.now() - caughtUpAt) / 60_000))
        : 0;
      // When this connection opened, if it did.
      let openedAt = null;
      let problem = null;
      // How long X asked to be left alone, if it is limiting requests.
      let askedMs = null;

      try {
        const stall = new AbortController();
        const res = await this.#open(backfill, stall, signal);
        this.#onStatus('live');
        this.#log(`Listening for X notifications${backfill ? ` (recovering up to ${backfill} min)` : ''}.`);
        openedAt = Date.now();
        caughtUpAt ??= openedAt;
        // A connection that drops straight away may not have delivered what it
        // was asked to recover, so the gap stays open until one has lasted.
        await this.#consume(res, stall, () => {
          if (Date.now() - openedAt >= STABLE_CONNECTION_MS) caughtUpAt = Date.now();
        });
        if (!signal.aborted) this.#log('X stream ended. Reconnecting.');
      } catch (error) {
        if (signal.aborted) return;
        // Asking again does not bring a login back, any more than it changes
        // a refusal from X.
        if (error instanceof LoginExpired) throw error;
        if (error instanceof XApiError) {
          if (backfill > 0 && (error.status === 400 || error.status === 403)) {
            backfillAllowed = false;
            continue;
          }
          if (error.status === 429) {
            askedMs = error.retryAfterMs ?? MAX_BACKOFF_MS;
          } else if (error.status >= 400 && error.status < 500) {
            throw error;
          }
        }
        problem = error.message;
      }

      if (signal.aborted) return;
      this.#onStatus('reconnecting');
      // Only a connection that opened and lasted starts the count again. One
      // that took a long time to fail has shown nothing.
      failures = openedAt !== null && Date.now() - openedAt >= STABLE_CONNECTION_MS ? 0 : failures + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** failures) * (0.75 + Math.random() / 2);
      // What X asks for is a time on its own clock. One already past says
      // nothing, so the wait is never shorter than after any other failure,
      // and grows the same way. One far off is not waited out in full: past
      // one of its windows, X may well have let go sooner than it said.
      const wait = Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(backoff, askedMs ?? 0));
      if (problem) {
        this.#log(`X stream problem: ${problem}${askedMs === null ? '' : ` (trying again in ${duration(wait)})`}`);
      }
      await delay(wait, undefined, { signal }).catch(() => {});
    }
  }

  // The stall timer only starts once there is a stream to watch, so the wait
  // for X to answer at all has a limit of its own.
  async #open(backfill, stall, signal) {
    const timer = setTimeout(() => stall.abort(new Error('No answer from X.')), this.#openTimeoutMs);
    try {
      return await this.#api.openStream(
        backfill ? { backfill_minutes: backfill } : {},
        AbortSignal.any([signal, stall.signal]),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #consume(res, stall, onData) {
    const decoder = new TextDecoder();
    const splitter = new JsonFrameSplitter();
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(new Error('No data from X stream.')), this.#stallTimeoutMs);
    };

    arm();
    try {
      for await (const chunk of res.body) {
        arm();
        onData();
        for (const frame of splitter.push(decoder.decode(chunk, { stream: true }))) this.#handle(frame);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  #handle(frame) {
    try {
      const message = JSON.parse(frame);
      if (message.errors) this.#log(`X stream error: ${message.errors[0]?.message ?? message.errors[0]?.title ?? 'unknown'}`);
      if (message.data) this.#onEvent(message.data);
    } catch (error) {
      this.#log(`Skipped an unreadable stream message: ${error.message}`);
    }
  }
}
