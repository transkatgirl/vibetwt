export class XApiError extends Error {
  constructor(status, detail, retryAfterMs = null) {
    super(`X API returned HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfter(headers) {
  const seconds = Number(headers.get('retry-after'));
  if (seconds > 0) return seconds * 1000;
  const reset = Number(headers.get('x-rate-limit-reset'));
  return reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : null;
}

async function toError(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json.detail ?? json.title ?? json.errors?.[0]?.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    // The status code alone is still useful.
  }
  return new XApiError(res.status, String(detail).slice(0, 300), retryAfter(res.headers));
}

export class XApi {
  #config;
  #auth;

  constructor(config, auth) {
    this.#config = config;
    this.#auth = auth;
  }

  async json(method, path, body) {
    const res = await this.#send(method, path, {
      body,
      prefer: 'user',
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // Billed per post and user returned, so only called when the user asks.
  async lookupPosts(ids, { withAuthors = false } = {}) {
    const query = new URLSearchParams({ ids: ids.join(','), 'post.fields': 'author_id' });
    if (withAuthors) query.set('expansions', 'author_id');
    const response = await this.json('GET', `/2/tweets?${query}`);
    return { posts: response?.data ?? [], users: response?.includes?.users ?? [] };
  }

  // Billed per user returned. X accepts up to 100 usernames per request.
  async lookupUsers(usernames) {
    const query = new URLSearchParams({ usernames: usernames.join(',') });
    const response = await this.json('GET', `/2/users/by?${query}`);
    return response?.data ?? [];
  }

  // X's docs list only a bearer token for the stream and do not say which kind
  // works for private events, so try the app token and then the user token.
  openStream(query, signal) {
    const search = new URLSearchParams(query).toString();
    return this.#send('GET', `/2/activity/stream${search ? `?${search}` : ''}`, { prefer: 'app', signal });
  }

  #credentials(prefer) {
    const user = { name: 'user', token: (force) => this.#auth.accessToken({ force }) };
    const app = this.#config.bearerToken ? { name: 'app', token: async () => this.#config.bearerToken } : null;
    return (prefer === 'app' ? [app, user] : [user, app]).filter(Boolean);
  }

  #fetch(method, path, token, { body, signal }) {
    const headers = { authorization: `Bearer ${token}` };
    if (body) headers['content-type'] = 'application/json';
    return fetch(`${this.#config.xApiBase}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  }

  async #send(method, path, options) {
    let lastError;
    for (const credential of this.#credentials(options.prefer)) {
      let res = await this.#fetch(method, path, await credential.token(false), options);
      if (res.status === 401 && credential.name === 'user') {
        await res.body?.cancel();
        res = await this.#fetch(method, path, await credential.token(true), options);
      }
      if (res.ok) return res;

      const error = await toError(res);
      if (error.status !== 401 && error.status !== 403) throw error;
      lastError = error;
    }
    throw lastError;
  }
}
