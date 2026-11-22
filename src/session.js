import { formatUsd, POST_READ_MICROS, USER_READ_MICROS } from './cost.js';
import { actorLabel, collectKnown, Deduper, eventKey, normalizeEvent } from './events.js';
import { EMPTY_FILTER, filterUsernames, matchesFilter } from './filter.js';
import { sanitizeText, singleLine } from './text.js';

const MAX_EVENTS = 1000;
const MAX_KNOWN = 5000;
const NOTICE_MS = 10_000;
const USERNAME = /^[a-z0-9_]{1,15}$/i;
const USERNAMES_PER_REQUEST = 100;

const atNames = (names) => names.map((name) => `@${name}`).join(', ');

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KNOWN) map.delete(map.keys().next().value);
}

// What the app knows and can do while running, shared by both interfaces.
export class Session {
  events = [];
  filter = EMPTY_FILTER;
  stream = 'connecting';
  notice = null;
  onChange = () => {};

  #me;
  #player;
  #mixer;
  #output;
  #api;
  #print;
  #onIntensity;
  #intensityPct;
  #deduper = new Deduper();
  #tweets = new Map();
  #users = new Map();
  #lookups = new Set();
  // Accounts a filter depends on, kept even if `#users` ages them out.
  #filterUsers = new Map();
  #resolving = new Set();
  #missingUsers = new Set();
  #noticeTimer = null;

  constructor({ me, username, player, mixer, output, cost, api, intensityPct, onIntensity, print }) {
    this.#me = me;
    this.username = username;
    this.#player = player;
    this.#mixer = mixer;
    this.#output = output;
    this.cost = cost;
    this.#api = api;
    this.#intensityPct = intensityPct;
    this.#onIntensity = onIntensity ?? (() => {});
    this.#print = print ?? null;
  }

  get intensityPct() {
    return this.#intensityPct;
  }

  get levelPct() {
    return Math.round(this.#mixer.level * 100);
  }

  get paused() {
    return this.#player.paused;
  }

  get active() {
    return this.#player.active;
  }

  get device() {
    return this.#output.status;
  }

  changed() {
    this.onChange();
  }

  notify(message) {
    const text = singleLine(message);
    this.notice = text;
    clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => {
      this.notice = null;
      this.changed();
    }, NOTICE_MS);
    this.#noticeTimer.unref();
    this.#print?.(text);
    this.changed();
  }

  setStream(status) {
    this.stream = status;
    this.changed();
  }

  // Every delivered event is billed, so cost is counted before filtering.
  receive(event) {
    if (!this.#deduper.isNew(eventKey(event))) return;
    this.cost.recordEvent(event?.event_type);
    this.#learn(collectKnown(event));

    const notification = normalizeEvent(event, this.#me);
    if (!notification) {
      this.changed();
      return;
    }
    // Later events from this user may omit the name, and exclusions rely on it.
    const { actorId, actorHandle } = notification;
    if (actorHandle && this.#users.get(actorId) !== actorHandle) {
      this.#learn({ tweets: [], users: [{ id: actorId, username: actorHandle }] });
    }
    this.#hydrate(notification);

    const matched = matchesFilter(this.filter, notification);
    notification.outcome = !matched
      ? 'filtered out'
      : this.paused
        ? 'paused'
        : !this.#output.ready
          ? 'no device'
          : 'played';
    if (notification.outcome === 'played') this.#player.play(notification.kind);

    this.events.unshift(notification);
    this.events.length = Math.min(this.events.length, MAX_EVENTS);
    if (this.#print) {
      const body = notification.text ?? notification.tweetText;
      const suffix = notification.outcome === 'played' ? '' : ` (${notification.outcome})`;
      this.#print(`${notification.kind} from ${notification.actor}${body ? `: ${singleLine(body).slice(0, 100)}` : ''}${suffix}`);
    }
    this.changed();
  }

  visible(filter = this.filter) {
    return this.events.filter((event) => matchesFilter(filter, event));
  }

  setFilter(filter) {
    this.filter = filter;
    this.#resolveFilterUsers();
    this.changed();
  }

  // X often omits usernames from events, so a `from:` filter needs the account
  // behind each name to catch them. Only applied filters reach this, so typing
  // in the filter prompt never costs anything.
  async #resolveFilterUsers() {
    const wanted = new Set(filterUsernames(this.filter));
    if (wanted.size === 0) return;
    for (const [id, username] of this.#users) {
      if (wanted.has(username.toLowerCase())) this.#filterUsers.set(id, username);
    }
    const known = new Set([...this.#filterUsers.values()].map((name) => name.toLowerCase()));
    const needed = [...wanted].filter((name) => (
      !known.has(name) && !this.#resolving.has(name) && !this.#missingUsers.has(name)
    ));
    if (needed.length === 0) return;

    const names = needed.filter((name) => USERNAME.test(name));
    const notFound = needed.filter((name) => !USERNAME.test(name));
    const found = [];
    const settled = new Set();
    let spent = 0;
    let failure = null;
    names.forEach((name) => this.#resolving.add(name));
    if (names.length > 0) this.notify(`Looking up ${atNames(names)}…`);

    try {
      for (let start = 0; start < names.length; start += USERNAMES_PER_REQUEST) {
        const batch = names.slice(start, start + USERNAMES_PER_REQUEST);
        const users = (await this.#api.lookupUsers(batch))
          .filter((user) => user?.id && user.username)
          .map((user) => ({ id: String(user.id), username: singleLine(user.username) }));

        const before = this.cost.snapshot().totalMicros;
        this.cost.recordLookup({ users: users.map((user) => user.id) });
        spent += this.cost.snapshot().totalMicros - before;

        users.forEach((user) => this.#filterUsers.set(user.id, user.username));
        this.#learn({ tweets: [], users });
        found.push(...users.map((user) => user.username));
        const returned = new Set(users.map((user) => user.username.toLowerCase()));
        batch.forEach((name) => settled.add(name));
        notFound.push(...batch.filter((name) => !returned.has(name)));
      }
    } catch (error) {
      failure = error;
    }

    names.forEach((name) => this.#resolving.delete(name));
    notFound.forEach((name) => this.#missingUsers.add(name));

    const parts = [];
    if (found.length > 0) parts.push(`Found ${atNames(found)}${spent > 0 ? ` (+${formatUsd(spent)})` : ''}.`);
    if (notFound.length > 0) parts.push(`No X user named ${atNames(notFound)}.`);
    if (failure) {
      const unfinished = names.filter((name) => !settled.has(name));
      parts.push(`Could not look up ${atNames(unfinished)}: ${failure.message}. Apply the filter again to retry.`);
    }
    if (parts.length > 0) this.notify(parts.join(' '));
    else this.changed();
  }

  adjustIntensity(deltaPct) {
    const next = Math.max(0, Math.min(100, this.#intensityPct + deltaPct));
    if (next === this.#intensityPct) return;
    this.#intensityPct = next;
    this.#mixer.setIntensity(next / 100);
    this.#onIntensity(next);
    this.changed();
  }

  togglePause() {
    this.#player.setPaused(!this.paused);
    this.changed();
  }

  // What a paid lookup would cost for this event, or 0 if nothing is missing.
  lookupEstimate(event) {
    if (!event) return 0;
    return (event.tweetId && !event.tweetText ? POST_READ_MICROS : 0)
      + (event.postId && !event.actorHandle ? POST_READ_MICROS + USER_READ_MICROS : 0);
  }

  async lookup(event) {
    if (!event || this.#lookups.has(event.key)) return;
    const needsTweet = Boolean(event.tweetId && !event.tweetText);
    const needsActor = Boolean(event.postId && !event.actorHandle);
    if (!needsTweet && !needsActor) {
      this.notify('Nothing to fetch for this event.');
      return;
    }

    this.#lookups.add(event.key);
    this.notify('Fetching from X…');
    try {
      if (needsTweet) await this.#fetch([event.tweetId], false);
      if (needsActor) await this.#fetch([event.postId], true);
      const missing = (needsTweet && !event.tweetText) || (needsActor && !event.actorHandle);
      this.notify(missing ? 'X did not return that tweet. It may be deleted or private.' : 'Fetched.');
    } catch (error) {
      this.notify(`Fetch failed: ${error.message}`);
    } finally {
      this.#lookups.delete(event.key);
    }
  }

  async #fetch(ids, withAuthors) {
    const { posts, users } = await this.#api.lookupPosts(ids, { withAuthors });
    this.cost.recordLookup({ posts: posts.map((post) => post.id), users: users.map((user) => user.id) });
    this.#learn({
      tweets: posts
        .filter((post) => post?.id && post.text)
        .map((post) => ({ id: String(post.id), text: sanitizeText(post.note_tweet?.text ?? post.text) })),
      users: users
        .filter((user) => user?.id && user.username)
        .map((user) => ({ id: String(user.id), username: singleLine(user.username) })),
    });
    this.changed();
  }

  #learn({ tweets, users }) {
    for (const tweet of tweets) remember(this.#tweets, tweet.id, tweet.text);
    for (const user of users) remember(this.#users, user.id, user.username);
    if (tweets.length > 0 || users.length > 0) {
      for (const event of this.events) this.#hydrate(event);
    }
  }

  #hydrate(event) {
    event.tweetText ??= this.#tweets.get(event.tweetId) ?? null;
    event.actorHandle ??= this.#users.get(event.actorId) ?? this.#filterUsers.get(event.actorId) ?? null;
    event.actor = actorLabel(event.actorHandle, event.actorId);
  }
}
