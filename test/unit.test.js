import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  assert.deepEqual(output.sent.filter((level) => level > 0), [1], 'never steps down through the weaker voice');
  assert.equal(output.sent.at(-1), 0);
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
  ]) {
    const parsed = parseFilter(query);
    assert.deepEqual(parseFilter(formatFilter(parsed)), parsed, query);
  }

  assert.equal(formatFilter(parseFilter('https://twitter.com/i/web/status/456')), 'tweet:456');
  assert.equal(formatFilter(parseFilter('1234567890123456789')), 'tweet:1234567890123456789');
  assert.equal(formatFilter(parseFilter('2024')), '2024');
  assert.equal(formatFilter(parseFilter('@bob')), 'from:@bob');
  assert.throws(() => parseFilter('type:nope'), /Unknown type/);
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
  const hidden = withoutUser(withoutUser(withoutUser(EMPTY_FILTER, 'c'), 'd'), 'c');
  assert.equal(formatFilter(hidden), 'NOT from:@c,@d');
  assert.equal(formatFilter(withoutUser(parseFilter('from:@a OR from:@b'), 'c')), '(from:@a OR from:@b) NOT from:@c');
  assert.equal(formatFilter(withTweet(parseFilter('NOT from:@a'), '5')), 'NOT from:@a tweet:5');
  assert.equal(formatFilter(withUser(parseFilter('NOT from:@a'), 'b')), 'NOT from:@a from:@b');
  assert.deepEqual(
    filterUsernames(parseFilter('NOT from:@a,123 NOT (from:@b OR cats) NOT (x NOT from:@c) from:@d')),
    ['a', 'b', 'c', 'd'],
  );
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
  assert.equal(formatFilter(withUser(parseFilter('type:reply from:@a cats'), 'b')), 'type:reply cats from:@b');
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
