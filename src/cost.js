// Prices from docs.x.com/x-api/activity/event-pricing and
// docs.x.com/x-api/getting-started/pricing, in millionths of a dollar so that
// totals never pick up floating-point error.
const EVENT_PRICES = {
  'like.create': { kind: 'like', micros: 1000 },
  'post.repost.create': { kind: 'retweet', micros: 5000 },
  'post.reply.create': { kind: 'reply', micros: 5000 },
};
export const POST_READ_MICROS = 5000;
export const USER_READ_MICROS = 10_000;

export const formatUsd = (micros) => `$${(micros / 1_000_000).toFixed(3)}`;

export class CostMeter {
  #events = {
    like: { count: 0, micros: 0 },
    retweet: { count: 0, micros: 0 },
    reply: { count: 0, micros: 0 },
  };
  #lookups = { count: 0, micros: 0 };
  #readDay = '';
  #readIds = new Set();

  recordEvent(eventType) {
    const price = EVENT_PRICES[eventType];
    if (!price) return;
    this.#events[price.kind].count++;
    this.#events[price.kind].micros += price.micros;
  }

  // X charges for a resource once per UTC day, so repeat reads are free.
  recordLookup({ posts = [], users = [] }, now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    if (day !== this.#readDay) {
      this.#readDay = day;
      this.#readIds.clear();
    }
    const charge = (prefix, ids, micros) => {
      for (const id of ids) {
        const key = `${prefix}:${id}`;
        if (this.#readIds.has(key)) continue;
        this.#readIds.add(key);
        this.#lookups.count++;
        this.#lookups.micros += micros;
      }
    };
    charge('post', posts, POST_READ_MICROS);
    charge('user', users, USER_READ_MICROS);
  }

  snapshot() {
    const events = Object.fromEntries(Object.entries(this.#events).map(([kind, value]) => [kind, { ...value }]));
    const eventMicros = Object.values(events).reduce((sum, value) => sum + value.micros, 0);
    return { events, lookups: { ...this.#lookups }, totalMicros: eventMicros + this.#lookups.micros };
  }
}
