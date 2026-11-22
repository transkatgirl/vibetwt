import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { stripVTControlCharacters as strip } from 'node:util';
import { CostMeter } from '../src/cost.js';
import { formatFilter } from '../src/filter.js';
import { Mixer } from '../src/mixer.js';
import { PatternPlayer } from '../src/player.js';
import { Session } from '../src/session.js';
import { displayWidth } from '../src/text.js';
import { Tui } from '../src/ui/app.js';
import { KeyParser } from '../src/ui/keys.js';
import { renderScreen } from '../src/ui/render.js';
import { NullOutput } from '../src/vibrator.js';
import { likeEvent, ME, OTHER, replyEvent, repostEvent } from './helpers.js';

function harness({ cols = 100, rows = 30, api = {} } = {}) {
  const output = new NullOutput();
  const played = [];
  const mixer = new Mixer(output, { intensity: 0.6 });
  const player = new PatternPlayer(mixer);
  const realPlay = player.play.bind(player);
  player.play = (kind) => {
    played.push(kind);
    return realPlay(kind);
  };
  const session = new Session({
    me: ME, username: 'tester', player, mixer, output, api: { lookupUsers: async () => [], ...api }, cost: new CostMeter(), intensityPct: 60,
  });
  const stdin = Object.assign(new EventEmitter(), {
    setRawMode() {}, setEncoding() {}, resume() {}, pause() {},
  });
  let written = '';
  const stdout = Object.assign(new EventEmitter(), {
    columns: cols, rows, write(text) { written += text; },
  });
  let quits = 0;
  const tui = new Tui(session, { stdin, stdout, color: true, onQuit: () => { quits++; } });
  return {
    session,
    tui,
    player,
    played,
    send: (text) => stdin.emit('data', text),
    screen: () => renderScreen(tui.view(), { cols, rows }).lines.map(strip),
    written: () => written,
    quits: () => quits,
  };
}

const seed = (session) => {
  session.receive({
    ...likeEvent('l1', { liked_tweet_id: '100' }),
    includes: { tweets: [{ id: '100', text: 'My first post' }], users: [{ id: OTHER, username: 'alice' }] },
  });
  session.receive(repostEvent('200', {
    author_id: '3', text: 'RT @tester: Second post', referenced_tweets: [{ type: 'retweeted', id: '101' }],
  }));
  session.receive(replyEvent('300', {
    author_id: '4', text: 'What a reply', in_reply_to_tweet_id: '100', conversation_id: '100',
  }));
};

test('key parser reads arrows, escape, unicode, and split sequences', () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push('\x1b[A\x1b[D').map((key) => key.name), ['up', 'left']);
  assert.deepEqual(parser.push('é🙂').map((key) => key.text), ['é', '🙂']);
  assert.deepEqual(parser.push('\x1b'), []);
  assert.ok(parser.pending);
  assert.deepEqual(parser.flush().map((key) => key.name), ['escape']);
  assert.deepEqual(parser.push('\x1b['), []);
  assert.deepEqual(parser.push('B').map((key) => key.name), ['down']);
  assert.deepEqual(parser.push('\x1b[5~\x03').map((key) => key.name), ['pageup', 'ctrl-c']);
});

test('a paste arrives as one key, even split across chunks', () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push('\x1b[200~https://x.com/q/'), []);
  assert.deepEqual(parser.push('status/1\x1b[20'), []);
  assert.deepEqual(parser.push('1~'), [{ name: 'paste', text: 'https://x.com/q/status/1' }]);
});

test('every line fits the terminal at many sizes, with hostile content', () => {
  for (const cols of [20, 43, 44, 50, 63, 64, 75, 76, 80, 120, 200]) {
    for (const rows of [5, 11, 12, 17, 18, 23, 24, 40]) {
      const app = harness({ cols, rows });
      app.tui.start();
      seed(app.session);
      app.session.receive(replyEvent('wide', {
        author_id: '9',
        text: `日本語のテキスト 🏳️‍🌈 ${'long'.repeat(80)}\x1b[2J\x1b]0;pwned\x07\n\nsecond line`,
      }));
      app.session.notify('n'.repeat(400));
      const { lines } = renderScreen(app.tui.view(), { cols, rows });
      assert.equal(lines.length, rows, `${cols}x${rows} line count`);
      for (const line of lines) {
        assert.equal(displayWidth(strip(line)), cols, `${cols}x${rows}: ${strip(line)}`);
        assert.ok(!line.includes('\x1b[2J') && !line.includes('pwned\x07'));
      }
      app.tui.stop();
      app.player.setPaused(true);
    }
  }
});

test('shows the post that was liked and the contents of a reply', () => {
  const app = harness();
  app.tui.start();
  seed(app.session);
  let screen = app.screen().join('\n');
  assert.match(screen, /What a reply/);
  assert.match(screen, /Second post/);
  assert.match(screen, /@alice\s+My first post/);
  assert.match(screen, /Est\. cost \$0\.011/);
  assert.match(screen, /vibetwt/);
  assert.match(screen, /↻ Retweet user 3/, 'the label keeps a space before the name');
  assert.match(screen, /t this tweet/);
  assert.doesNotMatch(screen, /repost/i);

  app.send('\x1b[B\x1b[B');
  app.tui.render();
  screen = app.screen().join('\n');
  assert.match(screen, /♥ Like from @alice/);
  assert.match(screen, /x\.com\/i\/status\/100/);
  app.tui.stop();
  app.player.setPaused(true);
});

test('filtering to a post limits the list and what vibrates, but cost counts everything', () => {
  const app = harness();
  app.tui.start();
  seed(app.session);
  app.played.length = 0;

  app.send('\x1b[B\x1b[B');
  app.send('t');
  assert.equal(formatFilter(app.session.filter), 'tweet:100');
  assert.equal(app.session.visible().length, 2);

  app.session.receive(likeEvent('l2', { liked_tweet_id: '100' }));
  app.session.receive(likeEvent('l3', { liked_tweet_id: '999' }));
  assert.deepEqual(app.played, ['like'], 'the like on another post did not vibrate');
  assert.equal(app.session.events[0].outcome, 'filtered out');
  assert.equal(app.session.cost.snapshot().totalMicros, 13_000);

  app.send('c');
  assert.equal(app.session.visible().length, 5);
  app.tui.stop();
  app.player.setPaused(true);
});

test('the filter prompt previews, applies, cancels, and rejects bad input', () => {
  const app = harness();
  app.tui.start();
  seed(app.session);

  app.send('/');
  app.send('type:reply');
  assert.match(app.screen()[3], /Filter › type:reply/);
  assert.match(app.screen()[3], /1\/3/);
  assert.equal(app.session.filter.kinds.length, 3, 'not applied until enter');
  app.send('\x1b');
  app.tui.handleKey({ name: 'escape' });
  assert.equal(app.session.filter.kinds.length, 3);

  app.send('/');
  app.send('type:nope');
  app.send('\r');
  assert.match(app.screen().join('\n'), /Unknown type "nope"/);
  assert.equal(app.session.filter.kinds.length, 3);
  app.send('\x15type:reply\r');
  assert.deepEqual(app.session.filter.kinds, ['reply']);
  app.tui.stop();
  app.player.setPaused(true);
});

test('typing q or space in the filter prompt does not quit or pause', () => {
  const app = harness();
  app.tui.start();
  app.send('/');
  app.send('q q');
  assert.equal(app.quits(), 0);
  assert.equal(app.session.paused, false);
  app.send('\x03');
  assert.equal(app.quits(), 1, 'ctrl+c always quits');
  app.tui.stop();
});

test('pasting a post URL filters to it without firing shortcuts', () => {
  const app = harness();
  app.tui.start();
  seed(app.session);
  app.send('\x1b[200~https://x.com/quinn/status/100?t=q\x1b[201~');
  assert.equal(app.quits(), 0);
  app.send('\r');
  assert.equal(formatFilter(app.session.filter), 'tweet:100');
  app.tui.stop();
  app.player.setPaused(true);
});

test('OR filters control both the list and what vibrates', () => {
  const app = harness();
  app.tui.start();
  seed(app.session);
  app.played.length = 0;

  app.send('/');
  app.send('from:@alice OR "what a reply"');
  app.send('\r');
  assert.equal(formatFilter(app.session.filter), 'from:@alice OR "what a reply"');
  assert.deepEqual(app.session.visible().map((event) => event.kind), ['reply', 'like']);

  app.session.receive(likeEvent('or-match', { liked_tweet_id: '500' }));
  app.session.receive(replyEvent('or-miss', { author_id: '8', text: 'nope' }));
  assert.deepEqual(app.played, ['like']);
  assert.equal(app.session.events[0].outcome, 'filtered out');
  app.tui.stop();
  app.player.setPaused(true);
});

test('an unfinished OR filter shows why and is not applied', () => {
  const app = harness();
  app.tui.start();
  seed(app.session);
  app.send('/');
  app.send('(from:@alice OR');
  app.send('\r');
  assert.match(app.screen().join('\n'), /OR needs a filter after it/);
  assert.equal(formatFilter(app.session.filter), '');
  app.send(' from:@carol)');
  assert.doesNotMatch(app.screen().join('\n'), /needs a filter/);
  app.send('\r');
  assert.equal(formatFilter(app.session.filter), 'from:@alice OR from:@carol');
  app.tui.stop();
  app.player.setPaused(true);
});

test('space pauses, arrows change strength, and limits hold', () => {
  const app = harness();
  app.tui.start();
  app.send(' ');
  assert.equal(app.session.paused, true);
  assert.match(app.screen()[1], /PAUSED/);
  app.session.receive(likeEvent('muted'));
  assert.equal(app.session.events[0].outcome, 'paused');
  assert.deepEqual(app.played, []);
  app.send(' ');
  assert.equal(app.session.paused, false);

  for (let i = 0; i < 12; i++) app.send('\x1b[C');
  assert.equal(app.session.intensityPct, 100);
  assert.equal(app.session.notice, null);
  for (let i = 0; i < 25; i++) app.send('-');
  assert.equal(app.session.intensityPct, 0);
  app.tui.stop();
  app.player.setPaused(true);
});

test('x hides the selected user from the list and the device', () => {
  const app = harness();
  app.tui.start();
  seed(app.session);
  app.played.length = 0;

  app.send('x');
  assert.equal(formatFilter(app.session.filter), 'NOT from:4', 'a user with no name is hidden by ID');
  assert.deepEqual(app.session.visible().map((event) => event.kind), ['retweet', 'like']);
  assert.equal(app.session.notice, null);

  app.session.receive(replyEvent('hidden', { author_id: '4', text: 'still here' }));
  assert.deepEqual(app.played, []);
  assert.equal(app.session.events[0].outcome, 'filtered out');

  app.send('j');
  app.send('x');
  assert.equal(formatFilter(app.session.filter), 'NOT from:4,@alice');
  app.session.receive(likeEvent('alice-again', { liked_tweet_id: '500' }));
  assert.deepEqual(app.played, [], 'a later unnamed like from a named user is caught');
  app.tui.stop();
  app.player.setPaused(true);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function applyFilter(app, text) {
  app.send('/');
  app.send('\x15');
  app.send(text);
  app.send('\r');
}

test('applying a filter looks up an unknown username once and adds its cost', async () => {
  const calls = [];
  const app = harness({
    api: {
      async lookupUsers(names) {
        calls.push(names);
        return [{ id: '7', username: 'Bob' }];
      },
    },
  });
  app.tui.start();
  app.session.receive(replyEvent('before', { author_id: '7', text: 'first' }));

  app.send('/');
  app.send('-from:@Bob');
  assert.deepEqual(calls, [], 'typing in the prompt costs nothing');
  app.send('\r');
  assert.match(app.session.notice, /Looking up @bob/);
  await settle();

  assert.deepEqual(calls, [['bob']]);
  assert.equal(app.session.cost.snapshot().lookups.micros, 10_000);
  assert.match(app.session.notice, /Found @Bob \(\+\$0\.010\)/);
  assert.match(app.screen()[2], /fetches \$0\.010/);
  assert.equal(app.session.visible().length, 0, 'the earlier unnamed event is hidden too');

  app.played.length = 0;
  app.session.receive(replyEvent('after', { author_id: '7', text: 'second' }));
  assert.equal(app.session.events[0].outcome, 'filtered out');
  assert.deepEqual(app.played, []);

  applyFilter(app, 'NOT from:@bob cats');
  app.send('1');
  await settle();
  assert.equal(calls.length, 1, 'a known user is never looked up again');
  assert.equal(app.session.cost.snapshot().lookups.micros, 10_000);
  app.tui.stop();
  app.player.setPaused(true);
});

test('usernames already seen in events need no paid lookup', async () => {
  const calls = [];
  const app = harness({ api: { async lookupUsers(names) { calls.push(names); return []; } } });
  app.tui.start();
  app.session.receive(replyEvent('payload-name', { author_id: '8', username: 'dana', text: 'hello' }));
  app.session.receive({
    ...replyEvent('included-name', { author_id: '9', text: 'hi' }),
    includes: { users: [{ id: '9', username: 'Erin' }] },
  });
  applyFilter(app, 'NOT from:@dana,@erin');
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(app.session.cost.snapshot().lookups.micros, 0);
  app.session.receive(replyEvent('unnamed', { author_id: '8', text: 'again' }));
  assert.equal(app.session.events[0].outcome, 'filtered out');
  app.tui.stop();
  app.player.setPaused(true);
});

test('a missing or invalid username costs nothing and is not retried', async () => {
  const calls = [];
  const app = harness({ api: { async lookupUsers(names) { calls.push(names); return []; } } });
  app.tui.start();
  applyFilter(app, 'NOT from:@nobody,@not-a-name');
  await settle();
  assert.deepEqual(calls, [['nobody']], 'an impossible username is never sent to X');
  assert.match(app.session.notice, /No X user named @not-a-name, @nobody/);
  assert.equal(app.session.cost.snapshot().lookups.micros, 0);
  applyFilter(app, 'NOT from:@nobody');
  await settle();
  assert.equal(calls.length, 1);
  app.tui.stop();
  app.player.setPaused(true);
});

test('a failed lookup explains itself and retries when the filter is applied again', async () => {
  let failing = true;
  const calls = [];
  const app = harness({
    api: {
      async lookupUsers(names) {
        calls.push(names);
        if (failing) throw new Error('X API returned HTTP 429');
        return [{ id: '7', username: 'bob' }];
      },
    },
  });
  app.tui.start();
  applyFilter(app, 'NOT from:@bob');
  await settle();
  assert.match(app.session.notice, /Could not look up @bob: X API returned HTTP 429/);
  assert.equal(app.session.cost.snapshot().lookups.micros, 0);

  failing = false;
  applyFilter(app, 'NOT from:@bob');
  await settle();
  assert.equal(calls.length, 2);
  assert.match(app.session.notice, /Found @bob/);
  app.tui.stop();
  app.player.setPaused(true);
});

test('lookups are batched, not repeated while pending, and bill partial results', async () => {
  const names = Array.from({ length: 101 }, (_, index) => `u${index}`);
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = harness({
    api: {
      async lookupUsers(batch) {
        calls.push(batch);
        await gate;
        if (calls.length === 2) throw new Error('X API returned HTTP 503');
        return batch.map((username, index) => ({ id: `id-${username}-${index}`, username }));
      },
    },
  });
  app.tui.start();
  applyFilter(app, `NOT from:${names.join(',')}`);
  app.send('1');
  assert.equal(calls.length, 1, 'a second apply does not repeat a pending lookup');
  release();
  await settle();

  assert.deepEqual(calls.map((batch) => batch.length), [100, 1]);
  assert.equal(app.session.cost.snapshot().lookups.micros, 1_000_000, 'the batch X returned is still billed');
  assert.match(app.session.notice, /Could not look up @u100: X API returned HTTP 503/);
  app.tui.stop();
  app.player.setPaused(true);
});

test('the retweet toggle and filter use the word retweet', () => {
  const app = harness();
  app.tui.start();
  seed(app.session);
  app.send('1');
  assert.equal(formatFilter(app.session.filter), 'type:retweet,reply');
  assert.match(app.screen()[3], /Filter type:retweet,reply/);
  app.tui.stop();
  app.player.setPaused(true);
});

test('selection stays on its event as new ones arrive', () => {
  const app = harness();
  app.tui.start();
  seed(app.session);
  app.send('j');
  const before = app.tui.view().selected.key;
  app.session.receive(likeEvent('new'));
  assert.equal(app.tui.view().selected.key, before);
  app.send('g');
  app.session.receive(likeEvent('newer'));
  assert.equal(app.tui.view().selected.key, app.session.events[0].key, 'back at the top, it follows');
  app.tui.stop();
  app.player.setPaused(true);
});

test('fetch is manual, shows its price, adds to cost, and fills in details', async () => {
  const calls = [];
  const api = {
    async lookupPosts(ids, { withAuthors }) {
      calls.push({ ids, withAuthors });
      return ids[0] === '101'
        ? { posts: [{ id: '101', text: 'The original post' }], users: [] }
        : { posts: [{ id: '200', author_id: '3', text: 'RT' }], users: [{ id: '3', username: 'bob' }] };
    },
  };
  const app = harness({ api });
  app.tui.start();
  app.session.receive(repostEvent('200', { author_id: '3', referenced_tweets: [{ type: 'retweeted', id: '101' }] }));
  assert.equal(calls.length, 0, 'nothing is fetched automatically');
  assert.match(app.screen().join('\n'), /f fetch missing info ~\$0\.020/);

  app.send('f');
  app.send('f');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 2, 'a double press does not fetch twice');
  const event = app.session.events[0];
  assert.equal(event.tweetText, 'The original post');
  assert.equal(event.actor, '@bob');
  assert.equal(app.session.cost.snapshot().lookups.micros, 20_000);
  assert.doesNotMatch(app.screen().join('\n'), /fetch missing info/);
  app.tui.stop();
  app.player.setPaused(true);
});

test('leaving restores the terminal', () => {
  const app = harness();
  const original = console.log;
  app.tui.start();
  assert.notEqual(console.log, original);
  console.log('library noise');
  assert.equal(app.session.notice, 'library noise');
  app.tui.stop();
  assert.equal(console.log, original);
  assert.ok(app.written().endsWith('\x1b[?1049l'));
  assert.ok(app.written().includes('\x1b[?25h'));
});
