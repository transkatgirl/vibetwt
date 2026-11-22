import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { openInBrowser } from './browser.js';

const SCOPES = 'tweet.read users.read like.read offline.access';
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export async function writePrivateJson(path, dir, value) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}

// Resolves once the local server is listening. `code` settles after the redirect.
async function listenForCallback(redirect, state) {
  const { promise: code, resolve, reject } = Promise.withResolvers();
  const finish = (settle, value) => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    settle(value);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, redirect);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    if (url.pathname !== redirect.pathname || url.searchParams.get('state') !== state) {
      res.statusCode = 400;
      res.end('This request does not match the login in progress.');
      return;
    }
    const authCode = url.searchParams.get('code');
    if (!authCode) {
      res.end('Login was not completed. You can close this tab.');
      finish(reject, new Error(`X login failed: ${url.searchParams.get('error') ?? 'no code returned'}`));
      return;
    }
    res.end('Logged in. You can close this tab.', () => finish(resolve, authCode));
  });
  const timer = setTimeout(() => finish(reject, new Error('Timed out waiting for X login.')), LOGIN_TIMEOUT_MS);

  try {
    await new Promise((ready, failed) => {
      server.once('error', failed);
      server.listen(Number(redirect.port || 80), redirect.hostname, ready);
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`Could not listen on ${redirect.host} for the login callback: ${error.message}`);
  }
  return { code };
}

export class XAuth {
  #config;
  #file;
  #session = null;
  #refreshing = null;

  constructor(config) {
    this.#config = config;
    this.#file = join(config.stateDir, 'tokens.json');
  }

  async requireSession() {
    if (!this.#session) {
      try {
        this.#session = JSON.parse(await readFile(this.#file, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!this.#session) throw new Error('Not logged in. Run `npm run login` first.');
    return this.#session;
  }

  async accessToken({ force = false } = {}) {
    const session = await this.requireSession();
    if (!force && session.expires_at - 60_000 > Date.now()) return session.access_token;
    this.#refreshing ??= this.#refresh(session).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async login() {
    if (!this.#config.clientId) throw new Error('Set X_CLIENT_ID in .env first.');

    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const redirect = new URL(this.#config.redirectUri);
    const url = new URL(this.#config.xAuthorizeUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.#config.clientId,
      redirect_uri: this.#config.redirectUri,
      scope: SCOPES,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });

    const callback = await listenForCallback(redirect, state);
    console.log(`Open this URL to authorize the app:\n\n${url}\n`);
    if (this.#config.openBrowser) openInBrowser(url.toString());

    const code = await callback.code;
    const tokens = await this.#tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.#config.redirectUri,
      code_verifier: verifier,
    });

    const me = await fetch(`${this.#config.xApiBase}/2/users/me`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!me.ok) throw new Error(`Could not read your X profile (HTTP ${me.status}).`);
    const { data } = await me.json();

    await this.#save({ ...this.#fromTokens(tokens), user_id: data.id, username: data.username });
    return this.#session;
  }

  async #refresh(session) {
    if (!session.refresh_token) throw new Error('X session expired. Run `npm run login` again.');
    let tokens;
    try {
      tokens = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refresh_token });
    } catch (error) {
      if (error.status === 400 || error.status === 401) {
        throw new Error('X session expired. Run `npm run login` again.');
      }
      throw error;
    }
    await this.#save({ ...session, ...this.#fromTokens(tokens, session.refresh_token) });
    return this.#session.access_token;
  }

  #fromTokens(tokens, previousRefresh) {
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? previousRefresh,
      expires_at: Date.now() + (tokens.expires_in ?? 7200) * 1000,
    };
  }

  async #save(session) {
    await writePrivateJson(this.#file, this.#config.stateDir, session);
    this.#session = session;
  }

  async #tokenRequest(params) {
    const { clientId, clientSecret, xApiBase } = this.#config;
    const body = new URLSearchParams(params);
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    } else {
      body.set('client_id', clientId);
    }

    const res = await fetch(`${xApiBase}/2/oauth2/token`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const error = new Error(`X token request failed (HTTP ${res.status}).`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }
}
