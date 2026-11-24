import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XApiError } from './x-api.js';
import { LoginExpired, writePrivateJson } from './x-auth.js';

export const TAG = 'vibetwt';
const PATH = '/2/activity/subscriptions';
const TTL_MS = 24 * 60 * 60_000;
const RENEW_BEFORE_MS = 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const CHECK_MS = 60_000;

// What asking again will not put right: the login has run out, or X turns it down.
const isRefusal = (error) => error instanceof LoginExpired
  || (error instanceof XApiError && (error.status === 401 || error.status === 403));

export const subscriptionSpecs = (userId) => [
  { event_type: 'like.create', filter: { user_id: userId, direction: 'inbound' } },
  { event_type: 'post.repost.create', filter: { user_id: userId } },
  { event_type: 'post.reply.create', filter: { user_id: userId } },
];

// Subscriptions exist only while the app runs, because X bills per event. Each
// one also carries an expiry, so a crash cannot leave billing on indefinitely.
export class SubscriptionManager {
  #api;
  #userId;
  #dir;
  #file;
  #log;
  #onRefused;
  #active = new Map();
  #timer = null;
  #renewing = null;
  #stopped = false;

  // `onRefused` is told when a renewal fails in a way that trying again will
  // not mend. Nothing more is tried after that.
  constructor(api, userId, { stateDir, log = () => {}, onRefused }) {
    this.#api = api;
    this.#userId = userId;
    this.#dir = stateDir;
    this.#file = join(stateDir, 'subscriptions.json');
    this.#log = log;
    this.#onRefused = onRefused ?? ((error) => log(`Subscription renewal was refused: ${error.message}`));
  }

  async start() {
    this.#stopped = false;
    await this.cleanup();
    await this.#createAll();
    this.#schedule(TTL_MS - RENEW_BEFORE_MS);
  }

  // A renewal under way would go on creating subscriptions after the cleanup,
  // so it is told to stop where it is, and waited for first.
  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#renewing;
    return this.cleanup();
  }

  // Deletes only subscriptions this app created, never others on the X app.
  // `listed` is whether X said which ones are open. Without that, only the
  // ones known of here were removed, and nothing says there were no more.
  async cleanup() {
    const ids = new Set([...this.#active.values(), ...(await this.#savedIds())]);
    let listed = true;
    try {
      const list = await this.#api.json('GET', PATH);
      for (const subscription of list?.data ?? []) {
        if (subscription.tag === TAG) ids.add(subscription.subscription_id);
      }
    } catch (error) {
      listed = false;
      this.#log(`Could not list subscriptions: ${error.message}`);
    }

    const failed = [];
    for (const id of ids) {
      try {
        await this.#delete(id);
      } catch (error) {
        failed.push(id);
        this.#log(`Could not delete subscription ${id}: ${error.message}`);
      }
    }

    this.#active.clear();
    await this.#persist(failed);
    return { deleted: ids.size - failed.length, failed: failed.length, listed };
  }

  async #createAll() {
    const previous = new Map(this.#active);
    const expires_at = new Date(Date.now() + TTL_MS).toISOString();

    for (const spec of subscriptionSpecs(this.#userId)) {
      if (this.#stopped) return;
      const body = { ...spec, tag: TAG, expires_at };
      let id;
      try {
        id = await this.#create(body);
      } catch (error) {
        const old = previous.get(spec.event_type);
        if (!(error instanceof XApiError) || error.status !== 409 || !old) throw error;
        await this.#delete(old);
        previous.delete(spec.event_type);
        id = await this.#create(body);
      }
      this.#active.set(spec.event_type, id);
      await this.#persist([...new Set([...this.#active.values(), ...previous.values()])]);
    }

    // X documents a repeat of an existing subscription as a refresh that keeps
    // it, so an ID that came back again is the live one and must stay.
    const live = new Set(this.#active.values());
    for (const id of previous.values()) {
      if (this.#stopped) return;
      if (live.has(id)) continue;
      await this.#delete(id).catch((error) => this.#log(`Could not delete old subscription ${id}: ${error.message}`));
    }
    await this.#persist([...live]);
  }

  async #create(body) {
    const response = await this.#api.json('POST', PATH, body);
    // X's quickstart and API reference disagree on where this field lives.
    const id = response?.data?.subscription?.subscription_id ?? response?.data?.subscription_id;
    if (!id) throw new Error(`X did not return a subscription ID for ${body.event_type}.`);
    return id;
  }

  async #delete(id) {
    try {
      await this.#api.json('DELETE', `${PATH}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof XApiError) || error.status !== 404) throw error;
    }
  }

  // A renewal is due at a time on the clock, so the clock is what gets
  // checked. One long timer stops counting while the machine sleeps, as timers
  // do on Linux, and would fire after the subscriptions had already expired.
  #schedule(ms) {
    const due = Date.now() + ms;
    const check = () => {
      const left = due - Date.now();
      if (left > 0) {
        this.#timer = setTimeout(check, Math.min(left, CHECK_MS));
        this.#timer.unref();
        return;
      }
      this.#renewing = this.#renew().finally(() => {
        this.#renewing = null;
      });
    };
    check();
  }

  async #renew() {
    try {
      await this.#createAll();
      if (this.#stopped) return;
      this.#log('Renewed X subscriptions.');
      this.#schedule(TTL_MS - RENEW_BEFORE_MS);
    } catch (error) {
      if (this.#stopped) return;
      // Trying this again every five minutes would only run the subscriptions
      // down to their expiry, with nothing to show that they had gone.
      if (isRefusal(error)) {
        this.#onRefused(error);
        return;
      }
      this.#log(`Subscription renewal failed, retrying in 5 minutes: ${error.message}`);
      this.#schedule(RETRY_MS);
    }
  }

  // The IDs an earlier run wrote down. A file that cannot be read is no reason
  // to leave anything subscribed: what is open now and what X lists under the
  // tag are still known, and the cleanup ends by writing the file afresh.
  async #savedIds() {
    try {
      const saved = JSON.parse(await readFile(this.#file, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('it does not hold a list');
      return saved.filter((id) => typeof id === 'string' || typeof id === 'number');
    } catch (error) {
      if (error.code !== 'ENOENT') this.#log(`Could not read the saved subscriptions: ${error.message}`);
      return [];
    }
  }

  #persist(ids) {
    return writePrivateJson(this.#file, this.#dir, ids);
  }
}
