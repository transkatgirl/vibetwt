import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { postText } from '../src/events.js';
import { Vibrator } from '../src/vibrator.js';
import { XApi } from '../src/x-api.js';
import { likeEvent, ME, replyEvent, repostEvent, startFakeButtplug, startFakeX, waitFor } from './helpers.js';

const CLI = resolve('src/cli.js');
const STRENGTH_PCT = 50;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Lets a child with piped output pass for one in a terminal, so that it opens
// the dashboard, and makes it throw from nowhere when it is sent SIGUSR2.
const FAKE_TERMINAL = `data:text/javascript,${encodeURIComponent(`
  for (const stream of [process.stdin, process.stdout]) stream.isTTY = true;
  process.stdin.setRawMode = () => {};
  process.on('SIGUSR2', () => { throw new Error('thrown on request'); });
`)}`;

async function startApp(x, buttplug, tokenOverrides = {}, {
  env = {}, ready = true, args = [], nodeArgs = [], stdin = 'ignore',
} = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
  await writeFile(join(stateDir, 'tokens.json'), JSON.stringify({
    access_token: 'user-token',
    refresh_token: 'refresh',
    expires_at: Date.now() + 3_600_000,
    user_id: ME,
    username: 'tester',
    ...tokenOverrides,
  }));
  await writeFile(join(stateDir, 'settings.json'), JSON.stringify({ intensityPct: STRENGTH_PCT }));

  const child = spawn(process.execPath, [...nodeArgs, CLI, 'run', ...args], {
    cwd: stateDir,
    stdio: [stdin, 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: stateDir,
      STATE_DIR: stateDir,
      X_API_BASE: x.url,
      X_BEARER_TOKEN: 'app-token',
      X_CLIENT_ID: 'client',
      BUTTPLUG_URL: buttplug.url,
      ...env,
    },
  });
  const app = { child, stateDir, output: '' };
  child.stdout.on('data', (data) => { app.output += data; });
  child.stderr.on('data', (data) => { app.output += data; });
  if (ready) {
    await waitFor(() => app.output.includes('Device ready') && app.output.includes('Listening'), { label: `startup:\n${app.output}` });
  }
  return app;
}

async function stopApp(app) {
  if (app.child.exitCode === null) {
    const exit = once(app.child, 'exit');
    app.child.kill('SIGTERM');
    await exit;
  }
  await rm(app.stateDir, { recursive: true, force: true });
}

const sequence = (buttplug, from = 0) => buttplug.timeline.slice(from);

test('plays a distinct pattern per interaction at the saved strength, then cleans up', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug({ steps: 20 });
  const app = await startApp(x, buttplug);

  try {
    assert.deepEqual([...x.subscriptions.values()].map((s) => s.event_type).sort(), [
      'like.create', 'post.reply.create', 'post.repost.create',
    ]);
    const like = [...x.subscriptions.values()].find((s) => s.event_type === 'like.create');
    assert.equal(like.filter.direction, 'inbound');
    assert.ok(Date.parse(like.expires_at) > Date.now());

    const seen = {};
    for (const [kind, event, count] of [
      ['like', likeEvent(), 4],
      ['retweet', repostEvent(), 10],
      ['reply', replyEvent(), 6],
    ]) {
      const start = buttplug.timeline.length;
      x.push(event, { split: kind === 'reply' });
      await waitFor(() => buttplug.timeline.length >= start + count, { label: `${kind} pattern` });
      await new Promise((r) => setTimeout(r, 250));
      seen[kind] = sequence(buttplug, start);
    }

    assert.deepEqual(seen.like, [5, 0, 7, 0]);
    assert.deepEqual(seen.retweet, [3, 5, 8, 10, 0, 3, 5, 8, 10, 0]);
    assert.deepEqual(seen.reply, [10, 0, 7, 0, 7, 0]);
    assert.ok(Math.max(...sequence(buttplug)) <= 20 * (STRENGTH_PCT / 100), 'never exceeds the strength setting');

    // Duplicates and your own activity must not vibrate.
    const before = buttplug.outputs.length;
    x.push(likeEvent());
    x.push(likeEvent('self', { liking_user_id: ME }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(buttplug.outputs.length, before);

    // An overlapping like is masked by a stronger reply and fills its gaps.
    const overlapStart = buttplug.timeline.length;
    x.push(replyEvent('overlap-reply'));
    await waitFor(() => buttplug.timeline.length > overlapStart, { label: 'overlap start' });
    await new Promise((r) => setTimeout(r, 450));
    x.push(likeEvent('overlap-like'));
    await new Promise((r) => setTimeout(r, 1000));
    const overlap = sequence(buttplug, overlapStart);
    assert.equal(overlap[0], 10, 'reply starts at full strength');
    assert.ok(overlap.includes(5) || overlap.includes(7), `the like is felt in the reply's gaps: ${overlap}`);
    assert.equal(overlap.at(-1), 0, 'ends stopped');

    // Two rapid likes both play, with the second filling the first one's gap.
    const blendStart = buttplug.timeline.length;
    x.push(likeEvent('blend-1'));
    await waitFor(() => buttplug.timeline.length > blendStart, { label: 'blend start' });
    await new Promise((r) => setTimeout(r, 150));
    x.push(likeEvent('blend-2'));
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(sequence(buttplug, blendStart), [5, 0, 5, 7, 0]);

    const stopsBefore = buttplug.stops.length;
    const exit = once(app.child, 'exit');
    app.child.kill('SIGTERM');
    const [code] = await exit;
    assert.equal(code, 0, app.output);
    assert.ok(buttplug.stops.length > stopsBefore, 'device stopped on exit');
    assert.equal(x.subscriptions.size, 0, 'subscriptions removed on exit');
    assert.deepEqual(JSON.parse(await readFile(join(app.stateDir, 'subscriptions.json'), 'utf8')), []);
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

test('looks up usernames through X\'s user endpoint', async () => {
  const x = await startFakeX({ users: [{ id: '7', username: 'Bob' }] });
  try {
    const api = new XApi({ xApiBase: x.url, bearerToken: '' }, { accessToken: async () => 'user-token' });
    assert.deepEqual(await api.lookupUsers(['bob', 'nobody']), [{ id: '7', username: 'Bob' }]);
    assert.deepEqual(await api.lookupUsers(['nobody']), []);
    assert.deepEqual(await api.lookupUsersById(['7', '8']), [{ id: '7', username: 'Bob' }]);
    assert.deepEqual(await api.lookupUsersById(['8']), []);
    assert.deepEqual(x.userLookups, [['bob', 'nobody'], ['nobody'], ['7', '8'], ['8']]);
  } finally {
    await x.close();
  }
});

test('fetching a post asks for its full text each way X documents, and manages without', async () => {
  const full = 'long '.repeat(80).trim();
  const posts = [{ id: '5', author_id: '7', text: `${full.slice(0, 279)}…`, note_post: { text: full } }];
  const byReference = { 'post.fields': 'note_post' };
  const byDictionary = { 'tweet.fields': 'note_tweet' };

  for (const [label, postFields, attempts, text] of [
    ['as the API reference has it', { 'post.fields': ['note_post'] }, [byReference], full],
    ['as the data dictionary has it', { 'tweet.fields': ['note_tweet'] }, [byReference, byDictionary], full],
    ['an X that knows neither', {}, [byReference, byDictionary, {}], posts[0].text],
  ]) {
    const x = await startFakeX({ posts, postFields });
    try {
      const api = new XApi({ xApiBase: x.url, bearerToken: '' }, { accessToken: async () => 'user-token' });
      const asked = () => x.postLookups.map(({ ids, ...fields }) => fields);

      assert.equal(postText((await api.lookupPosts(['5']))[0]), text, label);
      assert.deepEqual(asked(), attempts, label);
      assert.equal(postText((await api.lookupPosts(['5']))[0]), text, label);
      assert.deepEqual(asked(), [...attempts, attempts.at(-1)], `${label}: what worked is where the next one starts`);

      const stranger = new XApi({ xApiBase: x.url, bearerToken: '' }, { accessToken: async () => 'someone-else' });
      await assert.rejects(stranger.lookupPosts(['5']), /HTTP 401/, 'any other refusal is still an error');
    } finally {
      await x.close();
    }
  }
});

test('a refused request reports the answer given to the token it was meant for', async () => {
  const x = await startFakeX();
  try {
    const api = new XApi({ xApiBase: x.url, bearerToken: 'app-token' }, { accessToken: async () => 'revoked' });
    await assert.rejects(api.json('GET', '/2/activity/subscriptions'), /HTTP 403: This token was not accepted\./);
  } finally {
    await x.close();
  }
});

test('login verifies state, uses PKCE, and stores tokens privately', async () => {
  const x = await startFakeX();
  const stateDir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'login'], {
    cwd: stateDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: stateDir,
      STATE_DIR: stateDir,
      NO_BROWSER: '1',
      X_API_BASE: x.url,
      X_AUTHORIZE_URL: `${x.url}/authorize`,
      X_CLIENT_ID: 'client',
      X_REDIRECT_URI: `http://127.0.0.1:${port}/callback`,
    },
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });

  try {
    const link = await waitFor(() => output.match(/http:\S+\/authorize\S+/)?.[0], { label: 'authorize URL' });
    const params = new URL(link).searchParams;
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.equal(params.get('scope'), 'tweet.read users.read like.read offline.access');

    const forged = await fetch(`http://127.0.0.1:${port}/callback?code=forged&state=wrong`);
    assert.equal(forged.status, 400);

    const exit = once(child, 'exit');
    const good = await fetch(`http://127.0.0.1:${port}/callback?code=good&state=${encodeURIComponent(params.get('state'))}`);
    assert.equal(good.status, 200);
    const [code] = await exit;
    assert.equal(code, 0, output);

    const [request] = x.tokenRequests;
    assert.equal(x.tokenRequests.length, 1);
    assert.equal(request.code, 'good');
    assert.equal(createHash('sha256').update(request.code_verifier).digest('base64url'), params.get('code_challenge'));

    const file = join(stateDir, 'tokens.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.user_id, ME);
    assert.equal(saved.refresh_token, 'rotated-refresh');
  } finally {
    child.kill();
    await rm(stateDir, { recursive: true, force: true });
    await x.close();
  }
});

// Windows runs rundll32 by its full path, so a stand-in cannot be put in its way.
test('login opens the authorization URL in the browser', { skip: process.platform === 'win32' }, async () => {
  const x = await startFakeX();
  const stateDir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
  const opened = join(stateDir, 'opened-url');
  // Stands in for the desktop's launcher: `open` on macOS, `xdg-open` elsewhere.
  for (const name of ['open', 'xdg-open']) {
    await writeFile(join(stateDir, name), '#!/bin/sh\nprintf %s "$1" > "$OPENED_URL"\n', { mode: 0o755 });
  }
  const child = spawn(process.execPath, [CLI, 'login'], {
    cwd: stateDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${stateDir}:${process.env.PATH}`,
      HOME: stateDir,
      STATE_DIR: stateDir,
      DISPLAY: ':0',
      OPENED_URL: opened,
      X_API_BASE: x.url,
      X_AUTHORIZE_URL: `${x.url}/authorize`,
      X_CLIENT_ID: 'client',
      X_REDIRECT_URI: `http://127.0.0.1:${await freePort()}/callback`,
    },
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });

  try {
    const link = await waitFor(() => output.match(/http:\S+\/authorize\S+/)?.[0], { label: 'authorize URL' });
    const url = await waitFor(() => existsSync(opened) && readFileSync(opened, 'utf8'), { label: 'browser launch' });
    assert.equal(url, link);
  } finally {
    child.kill();
    await rm(stateDir, { recursive: true, force: true });
    await x.close();
  }
});

test('refreshes an expired X token on startup', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug, { access_token: 'expired', expires_at: Date.now() - 1000 });

  try {
    assert.equal(x.tokenRequests[0].grant_type, 'refresh_token');
    assert.equal(x.tokenRequests[0].refresh_token, 'refresh');
    assert.equal(x.subscriptions.size, 3);
    const saved = JSON.parse(await readFile(join(app.stateDir, 'tokens.json'), 'utf8'));
    assert.equal(saved.access_token, 'user-token');
    assert.equal(saved.refresh_token, 'rotated-refresh');
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

test('recovers from X stream and Intiface disconnects', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug);

  try {
    x.dropStreams();
    await waitFor(() => x.streamQueries.length >= 2 && x.streamCount() === 1, { label: 'stream reconnect' });
    assert.ok(Number(x.streamQueries.at(-1).backfill_minutes) >= 1, 'reconnect requests backfill');

    buttplug.dropClients();
    await waitFor(() => app.output.includes('Lost connection'), { label: 'disconnect notice' });
    await waitFor(() => buttplug.clientCount() === 1 && app.output.split('Device ready').length >= 3, { label: 'Intiface reconnect' });

    await new Promise((r) => setTimeout(r, 100));
    const start = buttplug.timeline.length;
    x.push(likeEvent('after-reconnect'));
    await waitFor(() => buttplug.timeline.length >= start + 4, { label: 'pattern after reconnect' });
    assert.deepEqual(sequence(buttplug, start), [5, 0, 7, 0]);
    assert.equal(app.child.exitCode, null, 'app stayed running');
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

test('will not start without a bearer token, and subscribes to nothing first', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug, {}, { env: { X_BEARER_TOKEN: '' }, ready: false });

  try {
    const code = app.child.exitCode ?? (await once(app.child, 'exit'))[0];
    assert.equal(code, 1);
    assert.match(app.output, /Set X_BEARER_TOKEN in \.env first/);
    assert.equal(x.subscriptions.size, 0);
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

test('a mistyped option is refused, so a wrong --no-device cannot run with the device on', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();

  try {
    for (const typo of ['--no-devise', 'no-device']) {
      const app = await startApp(x, buttplug, {}, { args: [typo], ready: false });
      try {
        await waitFor(() => app.child.exitCode !== null, { label: `refusing ${typo}:\n${app.output}` });
        assert.equal(app.child.exitCode, 1);
        assert.match(app.output, new RegExp(`Unknown option "${typo}"`));
        assert.equal(x.subscriptions.size, 0);
        assert.equal(buttplug.clientCount(), 0);
      } finally {
        await stopApp(app);
      }
    }
  } finally {
    await buttplug.close();
    await x.close();
  }
});

test('an unexpected error in the dashboard is still there to read once it has closed', { skip: process.platform === 'win32' }, async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug, {}, { nodeArgs: ['--import', FAKE_TERMINAL], ready: false });

  try {
    await waitFor(() => app.output.includes('X live'), { label: `dashboard:\n${app.output}` });
    const exit = once(app.child, 'exit');
    app.child.kill('SIGUSR2');
    const [code] = await exit;
    assert.equal(code, 1, app.output);
    const afterDashboard = app.output.slice(app.output.lastIndexOf('\x1b[?1049l'));
    assert.match(afterDashboard, /Unexpected error: thrown on request/);
    assert.match(afterDashboard, /Removed X subscriptions/, 'and the shutdown still finished');
    assert.equal(x.subscriptions.size, 0);
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

// npm passes Ctrl+C on to a script that the terminal has already sent it to.
test('one Ctrl+C that arrives twice still removes the subscriptions', async () => {
  const x = await startFakeX({ slowDeletesMs: 100 });
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug);

  try {
    const exit = once(app.child, 'exit');
    app.child.kill('SIGINT');
    await waitFor(() => app.output.includes('Removing X subscriptions'), { label: 'cleanup under way' });
    app.child.kill('SIGINT');
    const [code] = await exit;
    assert.equal(code, 0, app.output);
    assert.equal(x.subscriptions.size, 0);
    assert.match(app.output, /Removed X subscriptions/);
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

test('a second Ctrl+C later on quits at once, and says what it leaves behind', async () => {
  const x = await startFakeX({ slowDeletesMs: 1500 });
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug);

  try {
    const exit = once(app.child, 'exit');
    const stopsBefore = buttplug.stops.length;
    app.child.kill('SIGINT');
    await waitFor(() => app.output.includes('Removing X subscriptions'), { label: 'cleanup under way' });
    await new Promise((r) => setTimeout(r, 1100));
    app.child.kill('SIGINT');
    const [code] = await exit;
    assert.equal(code, 1, app.output);
    assert.match(app.output, /Quit before the X subscriptions were removed.*npm run cleanup/);
    assert.ok(buttplug.stops.length > stopsBefore, 'the device was stopped all the same');
    assert.ok(x.subscriptions.size > 0);
    const saved = JSON.parse(await readFile(join(app.stateDir, 'subscriptions.json'), 'utf8'));
    assert.deepEqual(saved.sort(), [...x.subscriptions.keys()].sort(), 'the next start knows what to remove');
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

test('closing while Intiface is still answering returns, and leaves no connection', { timeout: 5000 }, async () => {
  const buttplug = await startFakeButtplug({ handshakeDelayMs: 150 });
  const vibrator = new Vibrator({ url: buttplug.url });

  try {
    vibrator.start();
    await waitFor(() => buttplug.clientCount() === 1, { label: 'connection attempt' });
    await vibrator.close();
    await waitFor(() => buttplug.clientCount() === 0, { label: 'connection closed' });
    assert.equal(vibrator.ready, false);
  } finally {
    await buttplug.close();
  }
});

test('a connection that opens after it was given up on is closed, not left behind', async () => {
  const buttplug = await startFakeButtplug({ acceptDelayMs: 250 });
  const logs = [];
  const vibrator = new Vibrator({ url: buttplug.url, connectTimeoutMs: 100, log: (line) => logs.push(line) });

  try {
    vibrator.start();
    await waitFor(() => logs.some((line) => line.includes('No response within 100ms')), { label: 'attempt given up' });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(buttplug.clientCount(), 0);
    assert.ok(!logs.some((line) => line.includes('Device ready')), logs.join('\n'));
    assert.equal(vibrator.ready, false);
  } finally {
    await vibrator.close();
    await buttplug.close();
  }
});

// Intiface went away with a command unanswered and was back within a second.
// Giving up on that command is no reason to drop the connection that replaced it.
test('a command lost with its connection does not take the next one down', async () => {
  const buttplug = await startFakeButtplug();
  const logs = [];
  const vibrator = new Vibrator({ url: buttplug.url, log: (line) => logs.push(line) });
  const count = (text) => logs.filter((line) => line.includes(text)).length;

  try {
    vibrator.start();
    assert.ok(await vibrator.waitForDevice(3000));
    buttplug.loseNextCommand();
    const lost = vibrator.set(0.5).then(() => null, (error) => error);
    await waitFor(() => count('Device ready') === 2, { label: 'reconnect' });

    assert.match((await lost)?.message, /No response within 2000ms/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(count('Lost connection'), 1, logs.join('\n'));
    assert.equal(buttplug.clientCount(), 1);
    assert.equal(vibrator.ready, true);
  } finally {
    await vibrator.close();
    await buttplug.close();
  }
});

test('scans again when a scan ends with nothing found', async () => {
  const buttplug = await startFakeButtplug({ hasDevice: false, scansEnd: true });
  const vibrator = new Vibrator({ url: buttplug.url, rescanMs: 40 });

  try {
    vibrator.start();
    await waitFor(() => buttplug.scans.length >= 3, { label: 'repeated scans' });
    assert.ok(buttplug.scans[1] - buttplug.scans[0] >= 30, 'it pauses between scans');
    assert.deepEqual(vibrator.status, { connected: true, devices: [] });
  } finally {
    await vibrator.close();
    await buttplug.close();
  }
});

test('asks again when the server refuses a scan, and says why once', async () => {
  const buttplug = await startFakeButtplug({ hasDevice: false, refusedScans: 2 });
  const logs = [];
  const vibrator = new Vibrator({ url: buttplug.url, rescanMs: 40, log: (line) => logs.push(line) });

  try {
    vibrator.start();
    await waitFor(() => buttplug.scans.length >= 3, { label: 'a scan the server agrees to' });
    assert.ok(buttplug.scans[1] - buttplug.scans[0] >= 30, 'it pauses before asking again');
    assert.deepEqual(logs.filter((line) => line.includes('scan')), ['Device scan problem: Bluetooth is off']);

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(buttplug.scans.length, 3, 'one that is running is left to run');
  } finally {
    await vibrator.close();
    await buttplug.close();
  }
});

// Without the dashboard, a terminal still hands over Ctrl+C as a key, and two
// presses close together come in one read.
test('keys that arrive in one read each count, and a paste presses none of them', { skip: process.platform === 'win32' }, async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug, {}, { args: ['--plain'], nodeArgs: ['--import', FAKE_TERMINAL], stdin: 'pipe' });

  try {
    app.child.stdin.write('quit quietly');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(app.child.exitCode, null, app.output);
    assert.doesNotMatch(app.output, /paused|Shutting down/);

    app.child.stdin.write('  ');
    await waitFor(() => app.output.includes('Resumed.'), { label: `two spaces:\n${app.output}` });
    assert.match(app.output, /Stopped and paused/);

    const exit = once(app.child, 'exit');
    app.child.stdin.write('\x03\x03');
    const [code] = await exit;
    assert.equal(code, 0, app.output);
    assert.equal(x.subscriptions.size, 0);
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

test('a closed output pipe is a reason to leave cleanly, not a crash', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug);

  try {
    const exit = once(app.child, 'exit');
    app.child.stdout.destroy();
    x.push(likeEvent('unread'));
    const [code] = await exit;
    assert.equal(code, 0, app.output);
    assert.equal(x.subscriptions.size, 0, 'subscriptions removed with nobody reading');
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});
