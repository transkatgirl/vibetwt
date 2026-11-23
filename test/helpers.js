import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export async function waitFor(check, { timeoutMs = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Speaks enough of Buttplug spec v4 to exercise the real client library.
// `acceptDelayMs` holds back the connection itself and `handshakeDelayMs` its
// first answer, `hasDevice: false` leaves it with nothing connected,
// `scansEnd` makes every scan end at once, and `refusedScans` is how many
// scan requests it turns down before agreeing to one.
export async function startFakeButtplug({
  steps = 20, hasDevice = true, acceptDelayMs = 0, handshakeDelayMs = 0, scansEnd = false, refusedScans = 0,
} = {}) {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    ...(acceptDelayMs > 0 && { verifyClient: (info, accept) => setTimeout(accept, acceptDelayMs, true) }),
  });
  await once(wss, 'listening');
  const outputs = [];
  const stops = [];
  const scans = [];
  const timeline = [];
  let losesNextCommand = false;
  const device = {
    DeviceIndex: 0,
    DeviceName: 'Fake Vibe',
    DeviceFeatures: {
      0: { FeatureIndex: 0, FeatureDescriptor: 'motor', Output: { Vibrate: { Value: [0, steps] } }, Input: {} },
    },
  };

  wss.on('connection', (ws) => {
    const send = (reply) => {
      if (ws.readyState === 1) ws.send(JSON.stringify([reply]));
    };
    ws.on('message', (raw) => {
      for (const message of JSON.parse(raw.toString())) {
        const [type, body] = Object.entries(message)[0];
        let reply = { Ok: { Id: body.Id } };
        if (type === 'RequestServerInfo') {
          reply = { ServerInfo: { Id: body.Id, ServerName: 'Fake Intiface', MaxPingTime: 0, ProtocolVersionMajor: 4, ProtocolVersionMinor: 0 } };
        } else if (type === 'RequestDeviceList') {
          reply = { DeviceList: { Id: body.Id, Devices: hasDevice ? { 0: device } : {} } };
        } else if (type === 'OutputCmd') {
          if (losesNextCommand) {
            losesNextCommand = false;
            ws.terminate();
            return;
          }
          outputs.push({ at: Date.now(), value: body.Command.Vibrate.Value });
          timeline.push(body.Command.Vibrate.Value);
        } else if (type === 'StopCmd') {
          stops.push(Date.now());
          timeline.push(0);
        } else if (type === 'StartScanning') {
          scans.push(Date.now());
          if (scans.length <= refusedScans) {
            reply = { Error: { Id: body.Id, ErrorMessage: 'Bluetooth is off', ErrorCode: 4 } };
          }
        }

        if (type === 'RequestServerInfo' && handshakeDelayMs > 0) setTimeout(send, handshakeDelayMs, reply);
        else send(reply);
        if (type === 'StartScanning' && scansEnd) send({ ScanningFinished: { Id: 0 } });
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${wss.address().port}`,
    outputs,
    stops,
    scans,
    timeline,
    steps,
    dropClients: () => wss.clients.forEach((client) => client.terminate()),
    // The next device command gets no answer, and its connection is dropped.
    loseNextCommand: () => { losesNextCommand = true; },
    clientCount: () => [...wss.clients].filter((client) => client.readyState === 1).length,
    close: () => new Promise((resolve) => {
      wss.clients.forEach((client) => client.terminate());
      wss.close(resolve);
    }),
  };
}

// `postFields` is how this X lets optional post fields be asked for: the
// parameter it knows, and the fields it knows by that name. X's own docs give
// two answers. `slowDeletesMs` makes removing a subscription take as long as a
// real network would.
export async function startFakeX({
  userToken = 'user-token', appToken = 'app-token', users = [], posts = [],
  postFields = { 'post.fields': ['note_post'] }, slowDeletesMs = 0,
} = {}) {
  const subscriptions = new Map();
  const streams = new Set();
  const streamQueries = [];
  const tokenRequests = [];
  const userLookups = [];
  const postLookups = [];
  let nextId = 1;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x.test');
    const auth = req.headers.authorization;
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };

    if (url.pathname === '/2/oauth2/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      tokenRequests.push(Object.fromEntries(new URLSearchParams(raw)));
      return json(200, { access_token: userToken, refresh_token: 'rotated-refresh', expires_in: 7200 });
    }

    if (url.pathname === '/2/users/me') {
      if (auth !== `Bearer ${userToken}`) return json(401, { title: 'Unauthorized' });
      return json(200, { data: { id: ME, username: 'tester' } });
    }

    if (url.pathname === '/2/users/by') {
      if (auth !== `Bearer ${userToken}`) return json(401, { title: 'Unauthorized' });
      const names = url.searchParams.get('usernames').split(',');
      userLookups.push(names);
      const find = (name) => users.find((user) => user.username.toLowerCase() === name.toLowerCase());
      const data = names.map(find).filter(Boolean);
      const errors = names.filter((name) => !find(name)).map((value) => ({
        value,
        parameter: 'usernames',
        resource_type: 'user',
        title: 'Not Found Error',
        detail: `Could not find user with usernames: [${value}].`,
        type: 'https://api.x.com/2/problems/resource-not-found',
      }));
      return json(200, { ...(data.length > 0 && { data }), ...(errors.length > 0 && { errors }) });
    }

    if (url.pathname === '/2/users') {
      if (auth !== `Bearer ${userToken}`) return json(401, { title: 'Unauthorized' });
      const ids = url.searchParams.get('ids').split(',');
      userLookups.push(ids);
      const data = users.filter((user) => ids.includes(user.id));
      return json(200, data.length > 0 ? { data } : { errors: [{ title: 'Not Found Error' }] });
    }

    if (url.pathname === '/2/tweets') {
      if (auth !== `Bearer ${userToken}`) return json(401, { title: 'Unauthorized' });
      postLookups.push(Object.fromEntries(url.searchParams));
      const fields = [];
      for (const name of ['post.fields', 'tweet.fields'].filter((param) => url.searchParams.has(param))) {
        const known = postFields[name];
        const values = url.searchParams.get(name).split(',').filter(Boolean);
        const unknown = values.find((value) => !known?.includes(value));
        if (!known || unknown) {
          const message = known
            ? `The \`${name}\` query parameter value [${unknown}] is not one of [${known}]`
            : `The query parameter [${name}] is not one of [${['ids', ...Object.keys(postFields)]}]`;
          return json(400, {
            title: 'Invalid Request',
            detail: 'One or more parameters to your request was invalid.',
            errors: [{ message }],
          });
        }
        fields.push(...values);
      }
      // Like X, only hands over the full text when it is asked for, and under
      // the name it was asked for by.
      const fullText = fields.find((field) => field === 'note_post' || field === 'note_tweet');
      const data = url.searchParams.get('ids').split(',')
        .map((id) => posts.find((post) => post.id === id))
        .filter(Boolean)
        .map(({ note_post, ...post }) => (fullText && note_post ? { ...post, [fullText]: note_post } : post));
      return json(200, { data });
    }

    if (url.pathname === '/2/activity/stream') {
      if (auth !== `Bearer ${appToken}`) return json(403, { title: 'Forbidden' });
      streamQueries.push(Object.fromEntries(url.searchParams));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('\r\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return undefined;
    }

    if (url.pathname.startsWith('/2/activity/subscriptions')) {
      if (auth !== `Bearer ${userToken}`) {
        const detail = auth === `Bearer ${appToken}` ? 'This needs a user token.' : 'This token was not accepted.';
        return json(403, { title: 'Forbidden', detail });
      }
      const id = url.pathname.split('/')[4];
      if (req.method === 'GET') return json(200, { data: [...subscriptions.values()] });
      if (req.method === 'DELETE') {
        if (slowDeletesMs > 0) await new Promise((resolve) => setTimeout(resolve, slowDeletesMs));
        if (!subscriptions.delete(id)) return json(404, { title: 'Not found' });
        return json(200, { data: { deleted: true } });
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      // X's docs: creating a subscription that exists is a refresh, and "the
      // existing subscription is kept".
      const existing = [...subscriptions.values()].find((subscription) => (
        subscription.event_type === body.event_type && JSON.stringify(subscription.filter) === JSON.stringify(body.filter)
      ));
      const subscription_id = existing?.subscription_id ?? String(nextId++);
      subscriptions.set(subscription_id, { subscription_id, ...body });
      return json(200, { data: { subscription: { subscription_id, ...body } } });
    }

    return json(404, { title: 'Not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    subscriptions,
    streamQueries,
    tokenRequests,
    userLookups,
    postLookups,
    streamCount: () => streams.size,
    push(data, { split = false } = {}) {
      const text = `${JSON.stringify({ data })}\r\n`;
      for (const stream of streams) {
        if (split) {
          stream.write(text.slice(0, 25));
          setTimeout(() => stream.write(text.slice(25)), 20);
        } else {
          stream.write(text);
        }
      }
    },
    dropStreams: () => streams.forEach((stream) => stream.destroy()),
    close: () => new Promise((resolve) => {
      streams.forEach((stream) => stream.destroy());
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

// Payloads follow the examples in X's Activity API event documentation.
export const ME = '1111111111111111111';
export const OTHER = '2222222222222222222';

export const likeEvent = (id = 'like-1', overrides = {}) => ({
  event_uuid: `uuid-${id}`,
  event_type: 'like.create',
  filter: { user_id: ME, direction: 'inbound' },
  payload: { id, liking_user_id: OTHER, liked_tweet_author_id: ME, liked_tweet_id: '2079814480427442556', ...overrides },
});

export const repostEvent = (id = '2090000000000000003', overrides = {}) => ({
  event_uuid: `uuid-${id}`,
  event_type: 'post.repost.create',
  filter: { user_id: ME },
  payload: { id, author_id: OTHER, referenced_tweets: [{ type: 'retweeted', id: '2080761390344937796' }], ...overrides },
});

export const replyEvent = (id = '2090000000000000001', overrides = {}) => ({
  event_uuid: `uuid-${id}`,
  event_type: 'post.reply.create',
  filter: { user_id: ME },
  payload: { id, author_id: OTHER, in_reply_to_user_id: ME, in_reply_to_tweet_id: '2080761390344937796', ...overrides },
});
