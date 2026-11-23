import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserCommand } from '../src/browser.js';
import { CostMeter, formatUsd } from '../src/cost.js';
import { collectKnown, Deduper, eventKey, normalizeEvent } from '../src/events.js';
import {
  EMPTY_FILTER, filterUsernames, formatFilter, matchesFilter, parseFilter, toggleKind, withoutUser, withTweet, withUser,
} from '../src/filter.js';
import { Mixer } from '../src/mixer.js';
import { PATTERNS } from '../src/patterns.js';
import { MAX_VOICES, PatternPlayer } from '../src/player.js';
import { displayWidth, sanitizeText, singleLine, truncate, wordEndAfter, wordStartBefore, wrap } from '../src/text.js';
import { toDeviceValue } from '../src/vibrator.js';
import { XApiError } from '../src/x-api.js';
import { LoginExpired } from '../src/x-auth.js';
import { ActivityStream, JsonFrameSplitter } from '../src/x-stream.js';
import { SubscriptionManager, TAG } from '../src/x-subscriptions.js';
import { likeEvent, ME, OTHER, replyEvent, repostEvent } from './helpers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The mock clock schedules a chained timer from the end of the current tick,
// so patterns only keep exact time when it advances one millisecond at a time.
const advance = (t, ms) => {
  for (let elapsed = 0; elapsed < ms; elapsed++) t.mock.timers.tick(1);
};

class RecordingOutput {
  sent = [];
  async set(level) {
    this.sent.push(level);
  }
  async stop() {
    this.sent.push(0);
  }
}

// Holds each command open until released, like a slow Bluetooth device.
class SlowOutput {
  sent = [];
  #release = [];
  #answer(level) {
    this.sent.push(level);
    return new Promise((resolve) => this.#release.push(resolve));
  }
  set(level) {
    return this.#answer(level);
  }
  stop() {
    return this.#answer(0);
  }
  releaseOne() {
    this.#release.shift()?.();
  }
  releaseAll() {
    for (const resolve of this.#release.splice(0)) resolve();
  }
}

test('patterns are distinct and within range', () => {
  const shapes = Object.values(PATTERNS).map((pattern) => JSON.stringify(pattern.steps));
  assert.equal(new Set(shapes).size, 3);
  for (const pattern of Object.values(PATTERNS)) {
    for (const [level, ms] of pattern.steps) {
      assert.ok(level >= 0 && level <= 1);
      assert.ok(ms >= 50);
    }
  }
});

test('device values stay in range, even on coarse motors', () => {
  for (const steps of [1, 3, 4, 7, 10, 20, 100, 255]) {
    for (let level = 0.01; level <= 1; level += 0.01) {
      const value = toDeviceValue(level, [0, steps]);
      assert.ok(value >= 1 && value <= steps, `steps=${steps} level=${level} value=${value}`);
    }
    assert.equal(toDeviceValue(1, [0, steps]), steps);
  }
  assert.equal(toDeviceValue(0, [0, 20]), 0);
  assert.equal(toDeviceValue(0.01, [0, 20]), 1, 'weak levels stay perceptible');
  assert.equal(toDeviceValue(0.5, [10, 30]), 20, 'respects a nonzero minimum');
});

test('cleanup removes only this app\'s subscriptions', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const deleted = [];
  const api = {
    async json(method, path) {
      if (method === 'GET') {
        return {
          data: [
            { subscription_id: 'current', tag: TAG },
            { subscription_id: 'unrelated', tag: 'another-app' },
          ],
        };
      }
      deleted.push(path.split('/').at(-1));
      return {};
    },
  };
  await new SubscriptionManager(api, ME, { stateDir }).cleanup();
  assert.deepEqual(deleted, ['current']);
});

// X's docs say that creating a subscription which already exists refreshes it
// and keeps it. With `refreshes: false`, this X makes a second one instead.
function subscriptionApi({ refreshes }) {
  const live = new Map();
  let nextId = 1;
  return {
    live,
    async json(method, path, body) {
      if (method === 'GET') return { data: [...live.values()] };
      if (method === 'DELETE') {
        live.delete(path.split('/').at(-1));
        return { data: { deleted: true } };
      }
      const existing = [...live.values()].find((item) => item.event_type === body.event_type);
      const subscription_id = (refreshes && existing?.subscription_id) || String(nextId++);
      live.set(subscription_id, { subscription_id, ...body });
      return { data: { subscription: live.get(subscription_id) } };
    },
  };
}

// The file is a note of what was open. What is open now, and what X lists
// under the tag, say the same without it.
test('a saved list that cannot be read does not stop the cleanup', async (t) => {
  for (const contents of ['["1","2",', '{"1":true}']) {
    const stateDir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const file = join(stateDir, 'subscriptions.json');
    const api = subscriptionApi({ refreshes: true });
    const logs = [];
    const manager = new SubscriptionManager(api, ME, { stateDir, log: (line) => logs.push(line) });
    await manager.start();
    assert.equal(api.live.size, 3);

    await writeFile(file, contents);
    assert.deepEqual(await manager.stop(), { deleted: 3, failed: 0 }, contents);
    assert.equal(api.live.size, 0, contents);
    assert.equal(logs.length, 1, logs.join('\n'));
    assert.match(logs[0], /^Could not read the saved subscriptions: /);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [], 'and the file is put right');

    // Nor does it keep the next start out, which begins with a cleanup.
    await writeFile(file, contents);
    const next = new SubscriptionManager(api, ME, { stateDir });
    await next.start();
    assert.equal(api.live.size, 3, contents);
    assert.deepEqual(await next.stop(), { deleted: 3, failed: 0 }, contents);
  }
});

test('renewal leaves one live subscription of each type, however X answers a repeat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  for (const refreshes of [true, false]) {
    const stateDir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const api = subscriptionApi({ refreshes });
    const logs = [];
    const manager = new SubscriptionManager(api, ME, { stateDir, log: (line) => logs.push(line) });
    await manager.start();
    const before = [...api.live.keys()];

    t.mock.timers.tick(23 * 60 * 60_000);
    for (let turn = 0; turn < 5000 && logs.length === 0; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(logs, ['Renewed X subscriptions.']);

    const label = refreshes ? 'refreshed in place' : 'replaced';
    assert.deepEqual(
      [...api.live.values()].map((item) => item.event_type).sort(),
      ['like.create', 'post.reply.create', 'post.repost.create'],
      label,
    );
    const kept = before.filter((id) => api.live.has(id));
    assert.equal(kept.length, refreshes ? 3 : 0, label);
    const saved = JSON.parse(await readFile(join(stateDir, 'subscriptions.json'), 'utf8'));
    assert.deepEqual(saved.sort(), [...api.live.keys()].sort(), `${label}: the saved list matches X`);

    await manager.stop();
    assert.equal(api.live.size, 0, label);
  }
});

test('stopping in the middle of a renewal still leaves nothing subscribed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const turns = async (count) => {
    for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve));
  };

  for (const refreshes of [true, false]) {
    const stateDir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const api = subscriptionApi({ refreshes });
    const logs = [];
    const manager = new SubscriptionManager(api, ME, { stateDir, log: (line) => logs.push(line) });
    await manager.start();

    // The renewal's first request is held open, as a slow network would.
    const held = Promise.withResolvers();
    const answer = api.json;
    api.json = async (method, ...rest) => {
      if (method === 'POST') await held.promise;
      return answer(method, ...rest);
    };
    t.mock.timers.tick(23 * 60 * 60_000);
    await turns(5);

    const stopping = manager.stop();
    await turns(50);
    held.resolve();
    assert.deepEqual(await stopping, { deleted: 3 + (refreshes ? 0 : 1), failed: 0 });
    await turns(50);
    t.mock.timers.tick(24 * 60 * 60_000);
    await turns(50);

    const label = refreshes ? 'refreshed in place' : 'replaced';
    assert.equal(api.live.size, 0, label);
    assert.deepEqual(logs, [], `${label}: it neither finishes nor tries again`);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'subscriptions.json'), 'utf8')), [], label);
  }
});

test('a renewal X will go on refusing is reported once and not tried again, unlike one that may yet work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const turns = async () => {
    for (let turn = 0; turn < 200; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  // A day in steps, so that a retry due five minutes after a failure is reached.
  const aDayPasses = async () => {
    for (let step = 0; step < 24 * 12; step++) {
      t.mock.timers.tick(5 * 60_000);
      await turns();
    }
  };

  const failures = [
    ['a login that has run out', new LoginExpired(), true],
    ['a 401', new XApiError(401, 'Unauthorized'), true],
    ['a 403', new XApiError(403, 'Forbidden'), true],
    ['a 503', new XApiError(503, 'Service Unavailable'), false],
    ['a dropped connection', new TypeError('fetch failed'), false],
  ];
  for (const [label, failure, refused] of failures) {
    const stateDir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const api = subscriptionApi({ refreshes: true });
    const logs = [];
    const told = [];
    const manager = new SubscriptionManager(api, ME, {
      stateDir, log: (line) => logs.push(line), onRefused: (error) => told.push(error),
    });
    await manager.start();

    const answer = api.json;
    let posts = 0;
    api.json = async (method, ...rest) => {
      if (method !== 'POST') return answer(method, ...rest);
      posts++;
      throw failure;
    };
    await aDayPasses();

    if (refused) {
      assert.deepEqual(told, [failure], label);
      assert.equal(posts, 1, `${label}: asked once`);
      assert.deepEqual(logs, [], label);
    } else {
      assert.deepEqual(told, [], label);
      assert.ok(posts > 10, `${label}: asked again and again, ${posts} times`);
      assert.match(logs[0], /^Subscription renewal failed, retrying in 5 minutes: /, label);
    }

    api.json = answer;
    assert.deepEqual(await manager.stop(), { deleted: 3, failed: 0 }, `${label}: stopping still removes them`);
  }
});

// On Linux a timer does not count the time a machine spends asleep, but the
// subscriptions go on expiring.
test('a renewal that came due while the machine slept happens soon after it wakes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = Date.parse('2026-11-22T09:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const stateDir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const api = subscriptionApi({ refreshes: true });
  const logs = [];
  const manager = new SubscriptionManager(api, ME, { stateDir, log: (line) => logs.push(line) });
  const turns = async () => {
    for (let turn = 0; turn < 200; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  const awake = async (ms) => {
    now += ms;
    t.mock.timers.tick(ms);
    await turns();
  };
  await manager.start();

  await awake(8 * 60 * 60_000);
  assert.deepEqual(logs, [], 'nothing is due yet');

  // Asleep until after the renewal was due: the clock moves and no timer does.
  now += 16 * 60 * 60_000;
  await awake(60_000);
  assert.deepEqual(logs, ['Renewed X subscriptions.']);
  const expiries = [...api.live.values()].map((item) => Date.parse(item.expires_at));
  assert.ok(expiries.every((expiry) => expiry > now + 23 * 60 * 60_000), 'with a fresh day ahead of them');

  await manager.stop();
});

test('a reconnect that drops early asks again for what it was meant to recover', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const keepAlive = new TextEncoder().encode('\r\n');
  const stop = new AbortController();
  const queries = [];
  const connections = [
    async function* lastsThenDrops() {
      yield keepAlive;
      t.mock.timers.tick(40_000);
      yield keepAlive;
      t.mock.timers.tick(3 * 60_000);
      throw new Error('dropped');
    },
    async function* dropsAtOnce() {
      yield keepAlive;
      throw new Error('dropped again');
    },
    async function* ends() {
      stop.abort();
    },
  ];
  const api = {
    async openStream(query) {
      queries.push(query);
      return { body: connections[queries.length - 1]() };
    },
  };

  await new ActivityStream({ api, onEvent() {} }).run(stop.signal);
  assert.deepEqual(queries, [{}, { backfill_minutes: 3 }, { backfill_minutes: 3 }]);
});

test('a login that has run out ends the stream, since asking again cannot bring it back', async () => {
  let asked = 0;
  const logs = [];
  const api = {
    async openStream() {
      asked++;
      throw new LoginExpired();
    },
  };
  const stream = new ActivityStream({ api, onEvent() {}, log: (line) => logs.push(line) });
  await assert.rejects(stream.run(new AbortController().signal), /X session expired\. Run `npm run login` again\./);
  assert.equal(asked, 1);
  assert.deepEqual(logs, []);
});

// `asked` is how long X says to wait, one entry for each time it is asked.
// Runs until the last of them has been reported.
async function rateLimitedWaits(asked) {
  const waits = [];
  const stop = new AbortController();
  const api = {
    async openStream() {
      throw new XApiError(429, 'Too Many Requests', asked[waits.length]);
    },
  };
  const log = (line) => {
    waits.push(line.match(/^X stream problem: .*429.* \(trying again in (.+)\)$/)?.[1] ?? line);
    if (waits.length === asked.length) stop.abort();
  };
  await new ActivityStream({ api, onEvent() {}, log }).run(stop.signal);
  return waits;
}

test('a rate limit is waited out as X asks, but never at once and never for long', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  assert.deepEqual(await rateLimitedWaits([0, 0]), ['1s', '2s'], 'a time already past is no reason to hurry');
  assert.deepEqual(await rateLimitedWaits([30_000]), ['30s'], 'a time ahead is kept to');
  assert.deepEqual(await rateLimitedWaits([null]), ['60s'], 'no time at all gets a minute');
  assert.deepEqual(await rateLimitedWaits([24 * 60 * 60_000]), ['15 min'], 'a day off is asked about sooner');
  assert.deepEqual(await rateLimitedWaits([89_000]), ['89s']);
  assert.deepEqual(await rateLimitedWaits([90_000]), ['1 min 30s'], 'a minute and a half is not called two');
  assert.deepEqual(await rateLimitedWaits([149_500]), ['2 min 30s']);
  assert.deepEqual(await rateLimitedWaits([10 * 60_000]), ['10 min']);
});

test('classifies likes, retweets, and replies', () => {
  assert.equal(normalizeEvent(likeEvent(), ME).kind, 'like');
  assert.equal(normalizeEvent(repostEvent(), ME).kind, 'retweet');
  assert.equal(normalizeEvent(replyEvent(), ME).kind, 'reply');
});

test('ignores your own actions and likes of other people\'s posts', () => {
  assert.equal(normalizeEvent(likeEvent('a', { liking_user_id: ME }), ME), null);
  assert.equal(normalizeEvent(likeEvent('b', { liked_tweet_author_id: OTHER }), ME), null);
  assert.equal(normalizeEvent({ ...likeEvent('c'), filter: { user_id: ME, direction: 'outbound' } }, ME), null);
  assert.equal(normalizeEvent(replyEvent('d', { author_id: ME }), ME), null);
  assert.equal(normalizeEvent(repostEvent('e', { author_id: ME }), ME), null);
  assert.equal(normalizeEvent({ event_type: 'follow.follow', payload: {} }, ME), null);
});

test('extracts post text and handles from event payloads', () => {
  const like = normalizeEvent({
    ...likeEvent(),
    includes: {
      tweets: [{ id: '2079814480427442556', text: 'My post &amp; more' }],
      users: [{ id: OTHER, username: 'LikingUser' }],
    },
  }, ME);
  assert.equal(like.tweetText, 'My post & more');
  assert.equal(like.actor, '@LikingUser');

  const repost = normalizeEvent(repostEvent('r', { text: 'RT @me: Hello world' }), ME);
  assert.equal(repost.tweetId, '2080761390344937796');
  assert.equal(repost.tweetText, 'Hello world');

  const reply = normalizeEvent(replyEvent('p', { text: '@me Great post', conversation_id: '99' }), ME);
  assert.equal(reply.text, '@me Great post');
  assert.equal(reply.conversationId, '99');
  assert.equal(reply.actor, `user ${OTHER}`);

  // X's docs use both names for the full text of a long post.
  for (const field of ['note_post', 'note_tweet']) {
    const long = normalizeEvent(replyEvent('long', { text: 'The start…', [field]: { text: 'The start and the rest' } }), ME);
    assert.equal(long.text, 'The start and the rest', field);
  }
});

test('a retweet that carries only the start of its post says so', () => {
  // X stops a retweet's text at 140 characters, the last of them an ellipsis.
  const start = 'The start of a long post, '.repeat(6).slice(0, 131);
  const text = `RT @me: ${start}…`;
  assert.equal(text.length, 140);
  const cut = normalizeEvent(repostEvent('r', { text }), ME);
  assert.equal(cut.tweetText, `${start}…`);
  assert.equal(cut.tweetTextPartial, true);
  const linked = `RT @me: ${start.slice(0, 107)}… https://t.co/abcdefghij`;
  assert.equal(linked.length, 140);
  assert.equal(normalizeEvent(repostEvent('r', { text: linked }), ME).tweetTextPartial, true, 'a link after the ellipsis is still a cut');
  // Tidying turns each "&amp;" into "&", which leaves this one twenty characters shorter.
  const escaped = `${`RT @me: ${'R&amp;D '.repeat(5)}${start}`.slice(0, 139)}…`;
  assert.equal(escaped.length, 140);
  const tidied = normalizeEvent(repostEvent('r', { text: escaped }), ME);
  assert.ok(tidied.tweetText.startsWith('R&D R&D R&D R&D R&D The start'), tidied.tweetText);
  assert.equal(tidied.tweetTextPartial, true, 'a cut is measured as X sent it, not as it reads once tidied');

  const partial = (post) => normalizeEvent(repostEvent('r', { text: `RT @me: ${post}` }), ME).tweetTextPartial;
  assert.equal(partial('Hello world'), false, 'a short post is all there');
  assert.equal(partial('Wait for it…'), false, 'and so is one that ends in an ellipsis of its own');
  assert.equal(partial(`${start.slice(0, 100)}…`), false, 'however long, short of where X cuts');
  assert.equal(partial(start), false, 'nor is a long one cut that does not end in one');

  const carried = normalizeEvent({
    ...repostEvent('r', { text }),
    includes: { tweets: [{ id: '2080761390344937796', text: 'The start of a long post, and the rest' }] },
  }, ME);
  assert.equal(carried.tweetText, 'The start of a long post, and the rest');
  assert.equal(carried.tweetTextPartial, false, 'nor is anything missing when the post came with it');
  const unnamed = normalizeEvent(repostEvent('r', { text, referenced_tweets: undefined }), ME);
  assert.equal(unnamed.tweetTextPartial, false, 'with no post to ask for, what there is has to do');
  assert.equal(normalizeEvent(likeEvent(), ME).tweetTextPartial, false);
});

test('an event is timed by when it happened, which for a like is not when its post was written', () => {
  const happened = '2026-10-07T19:17:36.304Z';
  const written = '2026-07-22T06:23:07.000Z';
  const like = (envelope, payload) => normalizeEvent({ ...likeEvent('t', { created_at: written, ...payload }), ...envelope }, ME);
  assert.equal(like({ created_at: happened }).createdAt, Date.parse(happened), 'the envelope says when');
  assert.equal(like({}, { timestamp_ms: '1784927565236' }).createdAt, 1784927565236, 'and failing that, the like does');
  const before = Date.now();
  assert.ok(like({}).createdAt >= before, 'and failing both it is now, never the time of the post');

  const reply = replyEvent('r', { created_at: written });
  assert.equal(normalizeEvent(reply, ME).createdAt, Date.parse(written), 'a reply is a post, so its time is its own');
  assert.equal(normalizeEvent({ ...reply, created_at: happened }, ME).createdAt, Date.parse(happened));
});

test('malformed includes do not throw', () => {
  const event = { ...likeEvent(), includes: { tweets: 'nope', users: [null, {}] } };
  assert.deepEqual(collectKnown(event), { tweets: [], users: [] });
  assert.equal(normalizeEvent(event, ME).kind, 'like');
});

test('deduper rejects repeats and stays bounded', () => {
  const deduper = new Deduper(2);
  assert.equal(deduper.isNew('a'), true);
  assert.equal(deduper.isNew('a'), false);
  deduper.isNew('b');
  deduper.isNew('c');
  assert.equal(deduper.isNew('a'), true, 'oldest key was evicted');
  assert.equal(eventKey({ event_type: 'x', payload: {} }), null);
});

test('frame splitter handles fragments, keep-alives, braces in strings, and concatenation', () => {
  const splitter = new JsonFrameSplitter();
  assert.deepEqual(splitter.push('\r\n\r\n'), []);
  assert.deepEqual(splitter.push('{"a":"}{\\"'), []);
  assert.deepEqual(splitter.push('","b":{"c":1}}\r\n{"d":2}{"e"'), ['{"a":"}{\\"","b":{"c":1}}', '{"d":2}']);
  assert.deepEqual(splitter.push(':3}'), ['{"e":3}']);
});

test('mixer plays the strongest channel and returns to the others', async () => {
  const output = new RecordingOutput();
  const mixer = new Mixer(output);
  const hold = mixer.channel();
  const pulse = mixer.channel();

  hold.set(0.3);
  await mixer.settled();
  pulse.set(0.8);
  await mixer.settled();
  pulse.set(0);
  await mixer.settled();
  pulse.set(0.1);
  await mixer.settled();
  hold.set(0);
  await mixer.settled();
  pulse.set(0);
  await mixer.settled();
  assert.deepEqual(output.sent, [0.3, 0.8, 0.3, 0.1, 0]);
});

test('intensity multiplies after mixing and applies to what is playing', async () => {
  const output = new RecordingOutput();
  const mixer = new Mixer(output, { intensity: 0.5 });
  const channel = mixer.channel();
  channel.set(0.8);
  await mixer.settled();
  mixer.setIntensity(1);
  await mixer.settled();
  mixer.setIntensity(0);
  await mixer.settled();
  mixer.setIntensity(0.25);
  await mixer.settled();
  assert.deepEqual(output.sent, [0.4, 0.8, 0, 0.2]);
});

test('a slow device gets the latest level, never a backlog', async () => {
  const output = new SlowOutput();
  const mixer = new Mixer(output);
  const channel = mixer.channel();
  for (const level of [0.1, 0.2, 0.3, 0.4, 0.5]) channel.set(level);
  assert.deepEqual(output.sent, [0.1]);
  output.releaseOne();
  await sleep(5);
  assert.deepEqual(output.sent, [0.1, 0.5]);
  output.releaseAll();
  await mixer.settled();
});

test('muting stops immediately, even while a slow command is pending', async () => {
  const output = new SlowOutput();
  const mixer = new Mixer(output);
  mixer.channel().set(0.9);
  assert.deepEqual(output.sent, [0.9]);
  mixer.setMuted(true);
  assert.deepEqual(output.sent, [0.9, 0], 'stop was not held behind the pending command');
  output.releaseAll();
  await sleep(5);
  output.releaseAll();
  await mixer.settled();
});

test('resync restores the current level after a reconnect', async () => {
  const output = new RecordingOutput();
  const mixer = new Mixer(output);
  mixer.channel().set(0.5);
  await mixer.settled();
  mixer.resync();
  await mixer.settled();
  assert.deepEqual(output.sent, [0.5, 0.5]);
});

test('a failed command is retried with the latest level', async () => {
  const sent = [];
  let failing = true;
  const output = {
    async set(level) {
      sent.push(level);
      if (failing) throw new Error('device busy');
    },
    async stop() {
      sent.push(0);
    },
  };
  const logs = [];
  const mixer = new Mixer(output, { log: (line) => logs.push(line) });
  const channel = mixer.channel();
  channel.set(0.7);
  await mixer.settled();
  failing = false;
  await sleep(550);
  assert.deepEqual(sent, [0.7, 0.7]);
  assert.equal(logs.length, 1);
  channel.set(0);
  await mixer.close();
});

test('rapid events of one type each play in full and blend', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mixer = new Mixer(new RecordingOutput());
  const player = new PatternPlayer(mixer);
  let now = 0;
  const levelAt = (ms) => {
    advance(t, ms - now);
    now = ms;
    return mixer.level;
  };

  // First like: 0.45 until 110, gap until 200, 0.7 until 370.
  player.play('like');
  assert.equal(levelAt(50), 0.45);
  assert.equal(levelAt(130), 0, 'only the first like is playing, and it is in its gap');

  // Second like, 150ms in: 0.45 until 260, gap until 350, 0.7 until 520.
  levelAt(150);
  player.play('like');
  assert.equal(levelAt(180), 0.45, 'the second like fills the first one\'s gap');
  assert.equal(levelAt(300), 0.7, 'the first like\'s peak covers the second one\'s gap');
  assert.equal(levelAt(400), 0.7, 'the second like outlasts the first');
  assert.deepEqual(player.active, ['like']);
  assert.equal(levelAt(520), 0);
  assert.deepEqual(player.active, []);
});

test('a huge burst stays bounded and drops the oldest voice', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mixer = new Mixer(new RecordingOutput());
  const player = new PatternPlayer(mixer);
  player.play('reply');
  assert.equal(mixer.level, 1);
  for (let i = 0; i < MAX_VOICES - 1; i++) player.play('like');
  assert.equal(mixer.level, 1, 'the reply still fits');
  player.play('like');
  assert.equal(mixer.level, 0.45, 'the reply made room');
  assert.deepEqual(player.active, ['like']);
  advance(t, 370);
  assert.equal(mixer.level, 0);
  assert.deepEqual(player.active, []);
});

test('quitting with overlapping voices sends one stop', async () => {
  const output = new RecordingOutput();
  const mixer = new Mixer(output);
  const player = new PatternPlayer(mixer);
  player.play('reply');
  player.play('like');
  await mixer.settled();
  await player.close();
  assert.deepEqual(output.sent, [1, 0], 'never steps down through the weaker voice, and stops once');
});

test('a device that has caught up is stopped with one command, on pause and on quit', async () => {
  for (const stop of [(mixer) => mixer.setMuted(true), (mixer) => mixer.close()]) {
    const output = new RecordingOutput();
    const mixer = new Mixer(output);
    mixer.channel().set(0.5);
    await mixer.settled();
    await stop(mixer);
    await mixer.settled();
    assert.deepEqual(output.sent, [0.5, 0]);
  }
});

test('a weaker type does not cut short a stronger one, and fills its gaps', async () => {
  const output = new RecordingOutput();
  const mixer = new Mixer(output);
  const player = new PatternPlayer(mixer);
  player.play('reply');
  await sleep(380);
  player.play('like');
  await sleep(100);
  assert.deepEqual(output.sent, [1], 'the like is masked by the reply hold');
  await player.idle();
  assert.equal(output.sent[0], 1);
  assert.ok(output.sent.includes(0.7), 'the like plays once the hold ends');
  assert.equal(output.sent.at(-1), 0);
});

test('pause stops everything and blocks new patterns until resumed', async () => {
  const output = new RecordingOutput();
  const mixer = new Mixer(output);
  const player = new PatternPlayer(mixer);
  player.play('reply');
  player.play('retweet');
  player.setPaused(true);
  await mixer.settled();
  assert.equal(output.sent.at(-1), 0);
  assert.deepEqual(player.active, []);
  assert.equal(player.play('like'), false);

  const count = output.sent.length;
  await sleep(150);
  assert.equal(output.sent.length, count, 'nothing plays while paused');

  player.setPaused(false);
  assert.equal(player.play('like'), true);
  await player.close();
  assert.equal(output.sent.at(-1), 0);
});

test('a name every object answers to is not a pattern', () => {
  const output = new RecordingOutput();
  const player = new PatternPlayer(new Mixer(output));
  for (const name of ['constructor', 'toString', 'likes']) {
    assert.throws(() => player.play(name), new RegExp(`Unknown pattern: ${name}`));
  }
  assert.deepEqual(player.active, []);
  assert.deepEqual(output.sent, []);
});

test('filter syntax round-trips and reports mistakes', () => {
  const filter = parseFilter('type:reply,rt tweet:https://x.com/me/status/123?s=20 from:@Alice "two words" hello');
  assert.deepEqual(filter.kinds, ['retweet', 'reply']);
  assert.equal(formatFilter(filter), 'type:retweet,reply tweet:123 from:@alice "two words" hello');
  assert.deepEqual(parseFilter('type:repost').kinds, ['retweet'], 'the old word still works');
  assert.equal(formatFilter(parseFilter('post:123')), 'tweet:123', 'the old field still works');

  for (const query of [
    'a OR b',
    'a b OR c',
    'type:reply (a OR b)',
    '(a OR b) (c OR d)',
    'type:like from:@alice OR type:reply',
    'from:@a,@b tweet:1,2',
    '"or" "and" "@bob" "x.com/a/status/1" "1234567890123456789" ":)"',
    '(a OR (b (c OR d)))',
    'from:"a b",@c cats',
    '(from:"a)b" OR NOT from:"(c",12345) d',
  ]) {
    const parsed = parseFilter(query);
    assert.deepEqual(parseFilter(formatFilter(parsed)), parsed, query);
  }
  assert.equal(formatFilter(parseFilter('from:"a b",@c')), 'from:"@a b",@c', 'a name that would not read back whole is quoted');

  assert.equal(formatFilter(parseFilter('https://twitter.com/i/web/status/456')), 'tweet:456');
  assert.equal(formatFilter(parseFilter('1234567890123456789')), 'tweet:1234567890123456789');
  assert.equal(formatFilter(parseFilter('2024')), '2024');
  assert.equal(formatFilter(parseFilter('@bob')), 'from:@bob');
  assert.throws(() => parseFilter('type:nope'), /Unknown type/);
  // Every object answers to these names, and they are not types.
  for (const name of ['constructor', '__proto__', 'Constructor']) {
    for (const query of [`type:${name}`, `NOT type:${name}`, `type:${name} OR cats`, `type:like,${name}`]) {
      assert.throws(() => parseFilter(query), new RegExp(`Unknown type "${name}"`), query);
    }
  }
  assert.throws(() => parseFilter('tweet:abc'), /tweet ID or URL/);
  assert.equal(formatFilter(EMPTY_FILTER), '');
});

test('OR, AND, and parentheses combine with standard precedence', () => {
  const alice = {
    kind: 'like', actorId: '1', actorHandle: 'alice', tweetId: '10', postId: null, conversationId: null, text: null, tweetText: 'cats',
  };
  const bob = {
    kind: 'reply', actorId: '2', actorHandle: 'bob', tweetId: '20', postId: '21', conversationId: '20', text: 'dogs', tweetText: null,
  };
  const carol = {
    kind: 'retweet', actorId: '3', actorHandle: 'carol', tweetId: '10', postId: '31', conversationId: null, text: null, tweetText: 'birds',
  };
  const names = (query) => [alice, bob, carol]
    .filter((event) => matchesFilter(parseFilter(query), event))
    .map((event) => event.actorHandle);

  assert.deepEqual(names('from:@alice OR from:@bob'), ['alice', 'bob']);
  assert.deepEqual(names('from:@alice,@bob'), ['alice', 'bob']);
  assert.deepEqual(names('cats or dogs'), ['alice', 'bob']);
  assert.deepEqual(names('tweet:10 AND type:retweet'), ['carol']);
  assert.deepEqual(names('tweet:10 type:retweet'), ['carol']);
  assert.deepEqual(names('type:like from:@bob OR from:@carol'), ['carol'], 'AND binds tighter than OR');
  assert.deepEqual(names('type:like (from:@alice OR from:@carol)'), ['alice']);
  assert.deepEqual(names('(type:like OR type:reply) (cats OR dogs)'), ['alice', 'bob']);
  assert.deepEqual(names('from:@alice from:@bob'), [], 'a space always means AND');
  assert.deepEqual(names('"or"'), [], 'quoted operators are plain text');
});

test('NOT excludes matches and binds tighter than AND and OR', () => {
  const event = (kind, actorHandle, tweetId, tweetText) => ({
    kind, actorId: `id-${actorHandle}`, actorHandle, tweetId, postId: null, conversationId: null, text: null, tweetText,
  });
  const all = [event('like', 'alice', '10', 'cats'), event('reply', 'bob', '20', 'dogs'), event('retweet', 'carol', '10', 'birds')];
  const names = (query) => all
    .filter((item) => matchesFilter(parseFilter(query), item))
    .map((item) => item.actorHandle);

  assert.deepEqual(names('NOT from:@bob'), ['alice', 'carol']);
  assert.deepEqual(names('not from:@bob'), ['alice', 'carol']);
  assert.deepEqual(names('-from:@bob'), ['alice', 'carol']);
  assert.deepEqual(names('-@bob'), ['alice', 'carol']);
  assert.deepEqual(names('NOT from:@alice,@bob'), ['carol']);
  assert.deepEqual(names('-from:@alice -from:@bob'), ['carol']);
  assert.deepEqual(names('NOT from:@alice from:@bob'), ['bob'], 'NOT applies to the next filter only');
  assert.deepEqual(names('NOT (from:@alice OR from:@bob)'), ['carol']);
  assert.deepEqual(names('NOT(from:@alice OR from:@bob)'), ['carol']);
  assert.deepEqual(names('-(from:@alice OR from:@bob)'), ['carol']);
  assert.deepEqual(names('from:@alice OR NOT tweet:10'), ['alice', 'bob']);
  assert.deepEqual(names('tweet:10 AND NOT cats'), ['carol']);
  assert.deepEqual(names('NOT NOT from:@bob'), ['bob']);
  assert.deepEqual(names('-"cats"'), ['bob', 'carol']);
  assert.deepEqual(names('"not"'), [], 'quoted operators are plain text');
  assert.deepEqual(names('"-cats"'), [], 'a quoted dash is plain text');

  for (const query of [
    'NOT a', 'a NOT b', 'NOT (a b) OR c', 'a NOT (b OR c)', 'NOT from:@a,@b tweet:1', '"not" "-word" "not(x"', 'type:reply NOT (a OR b)',
  ]) {
    const parsed = parseFilter(query);
    assert.deepEqual(parseFilter(formatFilter(parsed)), parsed, query);
  }
  assert.equal(formatFilter(parseFilter('-from:@bob')), 'NOT from:@bob');
  assert.equal(formatFilter(parseFilter('well-known')), 'well-known');
  assert.equal(formatFilter(parseFilter('-_-')), '"-_-"', 'an emoticon stays text');
  assert.equal(formatFilter(parseFilter('-')), '"-"');
});

test('NOT on types stays accurate on the toggles, and incomplete NOTs explain themselves', () => {
  assert.deepEqual(parseFilter('NOT type:like').kinds, ['retweet', 'reply']);
  assert.equal(parseFilter('NOT type:like').expr, null);
  assert.deepEqual(parseFilter('-type:like,reply').kinds, ['retweet']);
  assert.deepEqual(parseFilter('NOT (type:like OR type:reply)').kinds, ['retweet']);
  assert.throws(() => parseFilter('NOT type:like,retweet,reply'), /excludes every type/);
  for (const query of ['NOT', 'a NOT', 'NOT OR a', '(NOT)', 'a AND NOT']) {
    assert.throws(() => parseFilter(query), /NOT needs a filter after/, query);
  }
});

test('hiding users builds one exclusion and keeps the rest of the filter', () => {
  const hidden = withoutUser(withoutUser(withoutUser(EMPTY_FILTER, '@c'), '@d'), '@c');
  assert.equal(formatFilter(hidden), 'NOT from:@c,@d');
  assert.equal(formatFilter(withoutUser(parseFilter('from:@a OR from:@b'), '@c')), '(from:@a OR from:@b) NOT from:@c');
  assert.equal(formatFilter(withTweet(parseFilter('NOT from:@a'), '5')), 'NOT from:@a tweet:5');
  assert.equal(formatFilter(withUser(parseFilter('NOT from:@a'), '@b')), 'NOT from:@a from:@b');
  assert.deepEqual(
    filterUsernames(parseFilter('NOT from:@a,123 NOT (from:@b OR cats) NOT (x NOT from:@c) from:@d')),
    ['a', 'b', 'c', 'd'],
  );
});

// X allows a name made only of digits, and an account ID is nothing else.
test('a user is a name with its @ and an account ID without, even when the name is all digits', () => {
  const named = parseFilter('from:@123456');
  assert.equal(formatFilter(named), 'from:@123456', 'the @ is kept, since it is all that says which');
  assert.deepEqual(filterUsernames(named), ['123456'], 'so it is looked up like any other name');
  assert.equal(formatFilter(parseFilter('@123456')), 'from:@123456');
  assert.equal(formatFilter(parseFilter('from:123456')), 'from:123456');
  assert.deepEqual(filterUsernames(parseFilter('from:123456')), []);
  assert.equal(formatFilter(parseFilter('from:Alice,@BOB,42')), 'from:@alice,@bob,42', 'a name may leave its @ off');

  const from = (actorId, actorHandle) => ({ kind: 'like', actorId, actorHandle });
  assert.ok(matchesFilter(named, from('9', '123456')));
  assert.ok(!matchesFilter(named, from('123456', null)), 'a name is not an account ID');
  assert.ok(!matchesFilter(named, from('123456', 'somebody')));
  assert.ok(matchesFilter(parseFilter('from:123456'), from('123456', 'somebody')));
  assert.ok(!matchesFilter(parseFilter('from:123456'), from('9', '123456')), 'nor an account ID a name');
  assert.ok(matchesFilter(parseFilter('NOT from:@123456'), from('123456', null)));
});

test('type OR filters stay accurate on the type toggles', () => {
  assert.deepEqual(parseFilter('type:like OR type:reply').kinds, ['like', 'reply']);
  assert.equal(parseFilter('type:like OR type:reply').expr, null);
  assert.deepEqual(parseFilter('type:like OR cats').kinds, ['like', 'retweet', 'reply']);
  assert.equal(formatFilter(toggleKind(parseFilter('a OR b'), 'like')), 'type:retweet,reply (a OR b)');
});

test('incomplete boolean filters explain what is wrong', () => {
  assert.throws(() => parseFilter('a OR'), /OR needs a filter after/);
  assert.throws(() => parseFilter('OR a'), /OR needs a filter before/);
  assert.throws(() => parseFilter('a AND'), /AND needs a filter after/);
  assert.throws(() => parseFilter('a OR OR b'), /OR needs a filter after/);
  assert.throws(() => parseFilter('(a OR b'), /closing/);
  assert.throws(() => parseFilter('('), /closing/);
  assert.throws(() => parseFilter('()'), /Empty/);
  assert.throws(() => parseFilter('type:like type:reply'), /both match/);
  assert.equal(formatFilter(parseFilter(':)')), '":)"', 'a lone parenthesis is plain text');
  assert.equal(formatFilter(parseFilter('foo(bar)')), '"foo(bar)"');
});

test('post and user shortcuts narrow an OR filter without breaking it', () => {
  const filter = parseFilter('from:@a OR from:@b');
  assert.equal(formatFilter(withTweet(filter, '5')), '(from:@a OR from:@b) tweet:5');
  assert.equal(formatFilter(withTweet(withTweet(filter, '5'), '6')), '(from:@a OR from:@b) tweet:6');
  assert.equal(formatFilter(withUser(parseFilter('type:reply from:@a cats'), '@b')), 'type:reply cats from:@b');
});

test('filters match by type, post, thread, user, and text', () => {
  const reply = normalizeEvent(replyEvent('p', {
    text: 'Love this idea',
    conversation_id: '777',
    in_reply_to_tweet_id: '555',
  }), ME);
  const matches = (query) => matchesFilter(parseFilter(query), reply);
  assert.ok(matches(''));
  assert.ok(matches('type:reply'));
  assert.ok(!matches('type:like'));
  assert.ok(matches('tweet:555'));
  assert.ok(matches('tweet:777'), 'a deep reply matches its thread root');
  assert.ok(!matches('tweet:888'));
  assert.ok(matches(`from:${OTHER}`));
  assert.ok(matches('LOVE idea'));
  assert.ok(!matches('love hate'));
});

test('toggling types always leaves at least one on', () => {
  let filter = EMPTY_FILTER;
  filter = toggleKind(filter, 'like');
  filter = toggleKind(filter, 'retweet');
  assert.deepEqual(filter.kinds, ['reply']);
  assert.deepEqual(toggleKind(filter, 'reply').kinds, ['reply']);
  assert.deepEqual(toggleKind(filter, 'like').kinds, ['like', 'reply']);
});

test('cost meter totals exactly and counts each post read once a day', () => {
  const meter = new CostMeter();
  for (let i = 0; i < 1000; i++) meter.recordEvent('like.create');
  meter.recordEvent('post.repost.create');
  meter.recordEvent('post.reply.create');
  meter.recordEvent('post.delete');
  assert.equal(meter.snapshot().totalMicros, 1_010_000);
  assert.equal(formatUsd(meter.snapshot().totalMicros), '$1.010');

  const day = new Date('2026-11-21T12:00:00Z');
  meter.recordLookup({ posts: ['1'], users: ['2'] }, day);
  meter.recordLookup({ posts: ['1'], users: ['2'] }, day);
  assert.equal(meter.snapshot().lookups.micros, 15_000);
  meter.recordLookup({ posts: ['1'] }, new Date('2026-11-22T00:00:01Z'));
  assert.equal(meter.snapshot().lookups.micros, 20_000);
});

test('sanitizer removes terminal escapes and bidi controls from post text', () => {
  assert.equal(sanitizeText('a\x1b[2J\x1b[31mb\x07c'), 'abc');
  assert.equal(sanitizeText('x\x9b31my'), 'xy');
  assert.equal(sanitizeText('safe‮txet'), 'safetxet');
  assert.equal(sanitizeText('line\r\nbreak'), 'line\nbreak');
});

// X sends a post's literal "&lt;" as "&amp;lt;". The list and the plain log
// tidy text that was already read once, and must not read it again.
test('post text has its escapes undone once, however often it is tidied', () => {
  const reply = normalizeEvent(replyEvent('p', { text: 'use &amp;lt;b&amp;gt; &amp; not &lt;i&gt;' }), ME);
  assert.equal(reply.text, 'use &lt;b&gt; & not <i>');
  assert.equal(singleLine(reply.text), reply.text);
  assert.equal(singleLine('AT&amp;T'), 'AT&amp;T', 'and text that is not from a post is left as it is');
});

test('text measurement handles wide characters and emoji', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('日本語'), 6);
  assert.equal(displayWidth('🏳️‍🌈'), 2);
  assert.equal(displayWidth('é'), 1);
  assert.equal(displayWidth(truncate('日本語テキスト', 7)), 7);
  for (const line of wrap('a verylongwordthatmustbreak 日本語のテキスト 🏳️‍🌈 end', 8)) {
    assert.ok(displayWidth(line) <= 8, line);
  }
});

test('word jumps stop at letters and digits, on either side of punctuation', () => {
  const stops = (text, step, from) => {
    const seen = [];
    for (let index = step(text, from); seen.at(-1) !== index; index = step(text, index)) seen.push(index);
    return seen;
  };
  const filter = 'type:like,reply -from:@al_1ce (x.com OR "it\'s")';
  assert.deepEqual(stops(filter, wordEndAfter, 0), [4, 9, 15, 21, 29, 32, 36, 39, 43, 45, 47]);
  assert.deepEqual(stops(filter, wordStartBefore, filter.length), [44, 41, 37, 33, 31, 23, 17, 10, 5, 0]);
  assert.equal(wordStartBefore(filter, 7), 5, 'from inside a word, to its start');
  assert.equal(wordEndAfter(filter, 7), 9, 'and to its end');

  assert.deepEqual(stops('日本語 café 👍🏽 naïve', wordEndAfter, 0), [3, 8, 20], 'accents stay inside their word');
  assert.equal(wordStartBefore('((', 2), 0);
  assert.equal(wordEndAfter('', 0), 0);

  // The selector and joiners inside an emoji are not words: a stop at one
  // would leave the cursor in the middle of the emoji.
  const heart = 'text:❤️ cats';
  const family = 'a \u{1f468}‍\u{1f469}‍\u{1f467} b';
  assert.deepEqual(stops(heart, wordEndAfter, 0), [4, 12]);
  assert.deepEqual(stops(heart, wordStartBefore, heart.length), [8, 0]);
  assert.deepEqual(stops(family, wordEndAfter, 0), [1, 12]);
  assert.deepEqual(stops(family, wordStartBefore, family.length), [11, 0]);
  assert.deepEqual(stops('1️⃣ x', wordEndAfter, 0), [3, 5], 'while a keycap is still one word');
});

test('each desktop gets its own browser launcher, and a headless machine gets none', () => {
  assert.deepEqual(browserCommand('darwin', {}), ['open']);
  assert.deepEqual(browserCommand('win32', { SystemRoot: 'D:\\Windows' }), [
    'D:\\Windows\\System32\\rundll32.exe',
    'url.dll,FileProtocolHandler',
  ]);
  assert.deepEqual(browserCommand('win32', {})[0], 'C:\\Windows\\System32\\rundll32.exe');
  assert.deepEqual(browserCommand('linux', { DISPLAY: ':0' }), ['xdg-open']);
  assert.deepEqual(browserCommand('linux', { WAYLAND_DISPLAY: 'wayland-0' }), ['xdg-open']);
  assert.equal(browserCommand('linux', {}), null);
});
