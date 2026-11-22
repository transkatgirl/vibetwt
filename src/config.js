import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function loadEnvFile(path = resolve('.env')) {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(env = process.env) {
  return {
    buttplugUrl: env.BUTTPLUG_URL || 'ws://127.0.0.1:12345',
    xApiBase: (env.X_API_BASE || 'https://api.x.com').replace(/\/$/, ''),
    xAuthorizeUrl: env.X_AUTHORIZE_URL || 'https://x.com/i/oauth2/authorize',
    clientId: env.X_CLIENT_ID || '',
    clientSecret: env.X_CLIENT_SECRET || '',
    bearerToken: env.X_BEARER_TOKEN || '',
    redirectUri: env.X_REDIRECT_URI || 'http://127.0.0.1:8976/callback',
    openBrowser: !env.NO_BROWSER,
    stateDir: env.STATE_DIR || join(homedir(), '.config', 'vibetwt'),
  };
}
