import { setTimeout as delay } from 'node:timers/promises';
import { XApiError } from './x-api.js';

const MAX_FRAME_CHARS = 5_000_000;
const MAX_BACKFILL_MINUTES = 5;
const STABLE_CONNECTION_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

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

  // The heartbeat interval is undocumented. This stays under the 5-minute
  // backfill limit so a silently dead connection can recover what it missed.
  constructor({ api, onEvent, log = () => {}, onStatus = () => {}, stallTimeoutMs = 240_000 }) {
    this.#api = api;
    this.#onEvent = onEvent;
    this.#log = log;
    this.#onStatus = onStatus;
    this.#stallTimeoutMs = stallTimeoutMs;
  }

  async run(signal) {
    let failures = 0;
    // Everything up to this moment has been received.
    let caughtUpAt = null;
    let backfillAllowed = true;

    while (!signal.aborted) {
      const connectedAt = Date.now();
      const backfill = caughtUpAt && backfillAllowed
        ? Math.min(MAX_BACKFILL_MINUTES, Math.ceil((Date.now() - caughtUpAt) / 60_000))
        : 0;
      let wait = null;

      try {
        const stall = new AbortController();
        const res = await this.#api.openStream(
          backfill ? { backfill_minutes: backfill } : {},
          AbortSignal.any([signal, stall.signal]),
        );
        this.#onStatus('live');
        this.#log(`Listening for X notifications${backfill ? ` (recovering up to ${backfill} min)` : ''}.`);
        const openedAt = Date.now();
        caughtUpAt ??= openedAt;
        // A connection that drops straight away may not have delivered what it
        // was asked to recover, so the gap stays open until one has lasted.
        await this.#consume(res, stall, () => {
          if (Date.now() - openedAt >= STABLE_CONNECTION_MS) caughtUpAt = Date.now();
        });
        if (!signal.aborted) this.#log('X stream ended. Reconnecting.');
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof XApiError) {
          if (backfill > 0 && (error.status === 400 || error.status === 403)) {
            backfillAllowed = false;
            continue;
          }
          if (error.status === 429) {
            wait = Math.max(error.retryAfterMs ?? MAX_BACKOFF_MS, 1000);
          } else if (error.status >= 400 && error.status < 500) {
            throw error;
          }
        }
        this.#log(`X stream problem: ${error.message}`);
      }

      if (signal.aborted) return;
      this.#onStatus('reconnecting');
      failures = Date.now() - connectedAt >= STABLE_CONNECTION_MS ? 0 : failures + 1;
      wait ??= Math.min(MAX_BACKOFF_MS, 500 * 2 ** failures) * (0.75 + Math.random() / 2);
      await delay(wait, undefined, { signal }).catch(() => {});
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
