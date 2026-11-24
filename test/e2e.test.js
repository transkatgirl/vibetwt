import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { postText } from '../src/events.js';
import { Vibrator } from '../src/vibrator.js';
import { XApi } from '../src/x-api.js';
import { ActivityStream } from '../src/x-stream.js';
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

// `command` is what to run, if not the app itself. `files` are written to its
// state directory first, by name, over what is put there anyway, and a name
// may put one in a directory of its own. `beside` is an app already started,
// whose state directory this one is to share as it stands.
async function startApp(x, buttplug, tokenOverrides = {}, {
  env = {}, ready = true, args = [], nodeArgs = [], stdin = 'ignore', command = 'run', files = {}, beside = null,
} = {}) {
  const stateDir = beside?.stateDir ?? await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
  if (!beside) {
    await writeFile(join(stateDir, 'tokens.json'), JSON.stringify({
      access_token: 'user-token',
      refresh_token: 'refresh',
      expires_at: Date.now() + 3_600_000,
      user_id: ME,
      username: 'tester',
      ...tokenOverrides,
    }));
    await writeFile(join(stateDir, 'settings.json'), JSON.stringify({ intensityPct: STRENGTH_PCT }));
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(join(stateDir, name)), { recursive: true });
      await writeFile(join(stateDir, name), contents);
    }
  }

  const child = spawn(process.execPath, [...nodeArgs, CLI, command, ...args], {
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

test('a 429 says how long to wait only when X does, or when its limit has run out', async () => {
  let headers = {};
  const server = createHttpServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ title: 'Too Many Requests' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const api = new XApi({ xApiBase: `http://127.0.0.1:${server.address().port}`, bearerToken: 'app-token' }, {});
  const inTenMinutes = () => String(Math.floor(Date.now() / 1000) + 600);
  const asked = async (sent) => {
    headers = sent;
    const refusal = await api.openStream({}, new AbortController().signal).catch((error) => error);
    assert.equal(refusal.status, 429);
    return refusal.retryAfterMs;
  };
  const aboutTenMinutes = (ms) => ms > 590_000 && ms <= 600_000;

  try {
    assert.equal(await asked({}), null, 'nothing said is nothing asked');
    assert.equal(await asked({ 'retry-after': '30' }), 30_000);
    assert.ok(
      aboutTenMinutes(await asked({ 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': inTenMinutes() })),
      'a limit that has run out is back when it resets',
    );
    assert.ok(
      aboutTenMinutes(await asked({ 'x-rate-limit-reset': inTenMinutes() })),
      'and one that does not say what is left of it is taken to have run out',
    );
    assert.equal(
      await asked({ 'retry-after': '30', 'x-rate-limit-remaining': '49', 'x-rate-limit-reset': inTenMinutes() }),
      30_000,
      'what X asks for outright counts whatever is left',
    );
    assert.equal(
      await asked({ 'x-rate-limit-remaining': '49', 'x-rate-limit-reset': inTenMinutes() }),
      null,
      'with requests left, the limit is not what refused this one, and its reset says nothing',
    );

    // So a stream turned away with requests to spare is asked for again in a
    // minute, and not when the window ends.
    const stop = new AbortController();
    const logs = [];
    const log = (line) => {
      logs.push(line);
      stop.abort();
    };
    await new ActivityStream({ api, onEvent() {}, log }).run(stop.signal);
    assert.match(logs[0], /HTTP 429: Too Many Requests \(trying again in 60s\)$/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
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

test('a saved login that cannot be read says so, and how to put it right', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug, {}, { files: { 'tokens.json': '{"access_token": "user-to' }, ready: false });

  try {
    const code = app.child.exitCode ?? (await once(app.child, 'exit'))[0];
    assert.equal(code, 1);
    await waitFor(() => app.output.includes('npm run login'), { label: `what to do about it:\n${app.output}` });
    assert.ok(app.output.includes(`The saved login in ${join(app.stateDir, 'tokens.json')} cannot be read.`), app.output);
    assert.equal(x.subscriptions.size, 0);
    assert.equal(buttplug.clientCount(), 0);
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

// Each start takes every subscription that carries the tag for its own
// leftovers, and removes it. So does `npm run cleanup`.
test('a second copy is refused while one is running, and its subscriptions are left alone', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug);

  try {
    const subscribed = [...x.subscriptions.keys()];
    for (const command of ['run', 'cleanup']) {
      const second = await startApp(x, buttplug, {}, { beside: app, command, ready: false });
      const code = second.child.exitCode ?? (await once(second.child, 'exit'))[0];
      assert.equal(code, 1, `${command}:\n${second.output}`);
      await waitFor(() => second.output.includes('Quit it first'), { label: `refusing ${command}:\n${second.output}` });
      assert.ok(second.output.includes(`vibetwt is already running (process ${app.child.pid})`), second.output);
      assert.ok(second.output.includes(join(app.stateDir, 'lock')), 'and names the file, in case it is wrong');
      assert.deepEqual([...x.subscriptions.keys()], subscribed, command);
    }
    assert.equal(buttplug.clientCount(), 1, 'nor did either reach for the device');

    // Its events still arrive, which they would not had the subscriptions gone.
    const start = buttplug.timeline.length;
    x.push(likeEvent('still-here'));
    await waitFor(() => buttplug.timeline.length >= start + 4, { label: 'pattern after the refusals' });

    const exit = once(app.child, 'exit');
    app.child.kill('SIGTERM');
    assert.equal((await exit)[0], 0, app.output);
    assert.ok(!existsSync(join(app.stateDir, 'lock')), 'quitting gives the directory back');

    const cleanup = await startApp(x, buttplug, {}, { beside: app, command: 'cleanup', ready: false });
    assert.equal(cleanup.child.exitCode ?? (await once(cleanup.child, 'exit'))[0], 0, cleanup.output);
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

// With nothing written down and nothing listed, there is nothing to remove.
// That is no sign of nothing being open, when X never said.
test('a cleanup that X would not answer does not pass for one that found nothing', async () => {
  const unwell = createHttpServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ title: 'Service Unavailable' }));
  });
  unwell.listen(0, '127.0.0.1');
  await once(unwell, 'listening');
  const x = { url: `http://127.0.0.1:${unwell.address().port}` };
  const cleanup = await startApp(x, { url: 'ws://127.0.0.1:1' }, {}, { command: 'cleanup', ready: false });

  try {
    const code = cleanup.child.exitCode ?? (await once(cleanup.child, 'exit'))[0];
    await waitFor(() => cleanup.output.includes('there may be more'), { label: `saying so:\n${cleanup.output}` });
    assert.match(cleanup.output, /Could not list subscriptions: X API returned HTTP 503/);
    assert.match(cleanup.output, /Removed 0 subscription\(s\)\.\nX did not say which subscriptions are open/);
    assert.equal(code, 1, cleanup.output);
  } finally {
    await stopApp(cleanup);
    unwell.closeAllConnections();
    unwell.close();
  }
});

// After a crash or a power cut the lock is still there, naming a process that is not.
test('a lock left by a copy that is gone keeps nobody out', async () => {
  const gone = spawn(process.execPath, ['-e', '']);
  await once(gone, 'exit');
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();

  try {
    // Nor does one holding what no copy put there, or a file where the lock goes.
    for (const left of [{ [`lock/${gone.pid}-0a1b2c3d`]: '' }, { 'lock/not a process': '' }, { lock: '' }]) {
      const app = await startApp(x, buttplug, {}, { files: left });
      try {
        assert.equal(x.subscriptions.size, 3);
        const held = readdirSync(join(app.stateDir, 'lock'));
        assert.equal(held.length, 1, `only its own is left: ${held}`);
        assert.ok(held[0].startsWith(`${app.child.pid}-`), `and it is named for it: ${held}`);
        assert.deepEqual(readdirSync(app.stateDir).filter((name) => name.endsWith('.tmp')), [], 'with nothing left over from taking it');
      } finally {
        await stopApp(app);
      }
    }
  } finally {
    await buttplug.close();
    await x.close();
  }
});

// After a restart the process that left a lock is gone, but its ID may be some
// other program's by now. This test's own process stands in for that program:
// it is running, and it did not start when the lock says its process did.
test('a lock whose process ID has since gone to something else keeps nobody out', {
  skip: !['darwin', 'linux'].includes(process.platform) && 'nothing here says when a process started',
}, async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug, {}, { files: { [`lock/${process.pid}-0a1b2c3d`]: 'Thu Jan  1 00:00:00 1970' } });

  try {
    assert.equal(x.subscriptions.size, 3);
    const held = readdirSync(join(app.stateDir, 'lock'));
    assert.equal(held.length, 1, `only its own is left: ${held}`);
    assert.ok(held[0].startsWith(`${app.child.pid}-`), `and it is named for it: ${held}`);
    assert.notEqual(readFileSync(join(app.stateDir, 'lock', held[0]), 'utf8'), '', 'which says when it started in turn');
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

// Guessing that it is abandoned would cost a copy that is running its subscriptions.
test('a lock that does not say when its process started is taken at its word', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug, {}, { files: { [`lock/${process.pid}-0a1b2c3d`]: '' }, ready: false });

  try {
    const code = app.child.exitCode ?? (await once(app.child, 'exit'))[0];
    assert.equal(code, 1, app.output);
    await waitFor(() => app.output.includes('Quit it first'), { label: `refusing:\n${app.output}` });
    assert.ok(app.output.includes(`vibetwt is already running (process ${process.pid})`), app.output);
    assert.equal(x.subscriptions.size, 0);
    assert.deepEqual(readdirSync(join(app.stateDir, 'lock')), [`${process.pid}-0a1b2c3d`], 'and is left as it was');
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

// Each finds the same lock to clear away, and what one clears must not be the
// lock that another has just taken.
test('of several copies started at once over a lock left behind, one gets it', async () => {
  const gone = spawn(process.execPath, ['-e', '']);
  await once(gone, 'exit');
  const dir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
  await mkdir(join(dir, 'lock'));
  await writeFile(join(dir, 'lock', `${gone.pid}-0a1b2c3d`), '');
  // Says how it went, then holds on until told, so that none of them starts
  // after the lock has been given back.
  const script = `
    import { takeLock } from ${JSON.stringify(pathToFileURL(resolve('src/lock.js')).href)};
    console.log(await takeLock(process.argv[1]).then(() => 'held', () => 'refused'));
    process.stdin.resume();
  `;

  const copies = Array.from({ length: 8 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['pipe', 'pipe', 'inherit'] });
    const copy = { child, said: '' };
    child.stdout.on('data', (data) => { copy.said += data; });
    return copy;
  });
  try {
    await waitFor(() => copies.every((copy) => copy.said.includes('\n')), { label: 'every copy to say how it went' });
    const said = copies.map((copy) => copy.said.trim());
    assert.equal(said.filter((answer) => answer === 'held').length, 1, said.join(' '));
    assert.equal(said.filter((answer) => answer === 'refused').length, copies.length - 1, said.join(' '));

    const exits = copies.map((copy) => once(copy.child, 'exit'));
    for (const copy of copies) copy.child.stdin.end();
    await Promise.all(exits);
    assert.deepEqual(readdirSync(dir), [], 'and the one that got it gives it back, with nothing left over');
  } finally {
    for (const copy of copies) copy.child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test('only a pattern there is can be tried', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();

  try {
    // Every object answers to these names, and they are not patterns.
    for (const name of ['constructor', 'toString']) {
      const app = await startApp(x, buttplug, {}, { command: 'try', args: ['like', name, '--no-device'], ready: false });
      try {
        const code = app.child.exitCode ?? (await once(app.child, 'exit'))[0];
        assert.equal(code, 1, app.output);
        await waitFor(() => app.output.includes(`Unknown pattern "${name}"`), { label: `refusing ${name}:\n${app.output}` });
        assert.doesNotMatch(app.output, /soft double tap/, 'and nothing is played before it is refused');
      } finally {
        await stopApp(app);
      }
    }
  } finally {
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

// `npm start --no-device`, without the `--`, never reaches the app as an option.
test('an option that npm kept for itself is refused too', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();

  try {
    for (const [flag, setting] of [['--no-device', { npm_config_device: '' }], ['--plain', { npm_config_plain: 'true' }]]) {
      const app = await startApp(x, buttplug, {}, { env: { ...setting, npm_lifecycle_event: 'start' }, ready: false });
      try {
        await waitFor(() => app.child.exitCode !== null, { label: `refusing ${flag}:\n${app.output}` });
        assert.equal(app.child.exitCode, 1);
        assert.ok(app.output.includes(`npm kept "${flag}" for itself. Put "--" before it: npm start -- ${flag}`), app.output);
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

// npm passes on every setting it has, wherever it got it.
test('a setting that an .npmrc gave npm is not taken for an option it kept', async () => {
  const x = await startFakeX();
  const buttplug = await startFakeButtplug();
  const settings = { npm_config_device: '', npm_config_plain: 'true', npm_lifecycle_event: 'start' };

  try {
    // In turn, the project's file, the user's, and the one for everybody.
    for (const [name, where] of [['.npmrc', 'npm_config_local_prefix'], ['npmrc', 'npm_config_userconfig'], ['npmrc', 'npm_config_globalconfig']]) {
      const dir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
      await writeFile(join(dir, name), '; not vibetwt\'s\r\nplain\r\n"device" = false\r\n');
      const env = { ...settings, [where]: name === '.npmrc' ? dir : join(dir, name) };
      // Starting at all shows it was let through, and the device that neither was read as an option.
      const app = await startApp(x, buttplug, {}, { env });
      try {
        assert.doesNotMatch(app.output, /npm kept/, where);
        assert.equal(buttplug.clientCount(), 1, where);
      } finally {
        await stopApp(app);
        await rm(dir, { recursive: true, force: true });
      }
    }

    // A file that has other settings, or only speaks of these, explains nothing.
    const dir = await mkdtemp(join(tmpdir(), 'vibetwt-test-'));
    await writeFile(join(dir, 'npmrc'), '# device=false\nplaintext=true\nmy-device = 1\n');
    const app = await startApp(x, buttplug, {}, { env: { ...settings, npm_config_userconfig: join(dir, 'npmrc') }, ready: false });
    try {
      await waitFor(() => app.child.exitCode !== null, { label: `refusing:\n${app.output}` });
      assert.match(app.output, /npm kept "--no-device" for itself/);
    } finally {
      await stopApp(app);
      await rm(dir, { recursive: true, force: true });
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
    assert.ok(!existsSync(join(app.stateDir, 'lock')), 'and is not kept out');
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

// Those inside the first second are passed over, and do not put off the one
// that comes after it.
test('a Ctrl+C pressed again and again is asking again', async () => {
  const x = await startFakeX({ slowDeletesMs: 1500 });
  const buttplug = await startFakeButtplug();
  const app = await startApp(x, buttplug);

  try {
    const exit = once(app.child, 'exit');
    for (let pressedMs = 0; pressedMs < 3000 && app.child.exitCode === null; pressedMs += 300) {
      app.child.kill('SIGINT');
      await new Promise((r) => setTimeout(r, 300));
    }
    const [code] = await exit;
    assert.equal(code, 1, app.output);
    assert.match(app.output, /Quit before the X subscriptions were removed.*npm run cleanup/);
    assert.ok(x.subscriptions.size > 0);
  } finally {
    await stopApp(app);
    await buttplug.close();
    await x.close();
  }
});

// X takes the connection and says nothing, not even no.
test('an X that never answers is given up on, and asked again', async () => {
  const sockets = new Set();
  const silent = createServer((socket) => sockets.add(socket.on('error', () => {}).resume()));
  silent.listen(0, '127.0.0.1');
  await once(silent, 'listening');
  const api = new XApi(
    { xApiBase: `http://127.0.0.1:${silent.address().port}`, bearerToken: 'app-token' },
    { accessToken: async () => 'user-token' },
  );
  const stop = new AbortController();
  const logs = [];
  const statuses = [];
  const stream = new ActivityStream({
    api,
    onEvent() {},
    openTimeoutMs: 100,
    onStatus: (status) => statuses.push(status),
    log: (line) => {
      logs.push(line);
      if (logs.length === 2) stop.abort();
    },
  });

  try {
    await stream.run(stop.signal);
    assert.deepEqual(logs, ['X stream problem: No answer from X.', 'X stream problem: No answer from X.']);
    assert.deepEqual(statuses, ['reconnecting', 'reconnecting'], 'and it is never called live');
    assert.equal(sockets.size, 2);
    await waitFor(() => [...sockets].every((socket) => socket.destroyed), { label: 'both attempts dropped' });
  } finally {
    stop.abort();
    for (const socket of sockets) socket.destroy();
    silent.close();
  }
});

test('closing does not wait for an Intiface that never answers', async () => {
  // Takes the connection and then says nothing, so the attempt would run to its timeout.
  const sockets = new Set();
  const silent = createServer((socket) => sockets.add(socket.on('error', () => {}).resume()));
  silent.listen(0, '127.0.0.1');
  await once(silent, 'listening');
  const logs = [];
  const vibrator = new Vibrator({ url: `ws://127.0.0.1:${silent.address().port}`, log: (line) => logs.push(line) });

  try {
    vibrator.start();
    await waitFor(() => sockets.size === 1, { label: 'connection attempt' });
    const closingAt = Date.now();
    await vibrator.close();
    assert.ok(Date.now() - closingAt < 1000, 'well inside the five seconds an attempt is given');
    await waitFor(() => [...sockets].every((socket) => socket.destroyed), { label: 'attempt abandoned' });
    assert.deepEqual(logs, [], 'and leaving is not reported as Intiface being away');
  } finally {
    await vibrator.close();
    for (const socket of sockets) socket.destroy();
    silent.close();
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
