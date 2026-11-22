#!/usr/bin/env node
import { loadConfig, loadEnvFile } from './config.js';
import { Mixer } from './mixer.js';
import { PATTERNS } from './patterns.js';
import { PatternPlayer } from './player.js';
import { log, runService } from './run.js';
import { loadSettings, startingIntensity } from './settings.js';
import { NullOutput, Vibrator } from './vibrator.js';
import { XApi } from './x-api.js';
import { XAuth } from './x-auth.js';
import { SubscriptionManager } from './x-subscriptions.js';

const USAGE = `Usage:
  npm run login                 Connect your X account
  npm start                     Open the interactive dashboard
  npm start -- --no-device      Run the dashboard without vibrating
  npm start -- --plain          Print a simple log instead of the dashboard
  npm run try -- [like|retweet|reply]  Play patterns without X
  npm run cleanup               Remove this app's X subscriptions`;

async function tryPatterns(config, kinds, noDevice) {
  for (const kind of kinds) {
    if (!PATTERNS[kind]) throw new Error(`Unknown pattern "${kind}". Choose like, retweet, or reply.`);
  }

  const output = noDevice
    ? new NullOutput()
    : new Vibrator({ url: config.buttplugUrl, log });
  const { intensityPct } = await loadSettings(config.stateDir);
  const mixer = new Mixer(output, { intensity: startingIntensity(intensityPct) / 100, log });
  const player = new PatternPlayer(mixer);
  output.onChange = () => mixer.resync();
  const abort = async () => {
    await player.close();
    await output.close();
    process.exit(130);
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  output.start();
  try {
    if (!(await output.waitForDevice(30_000))) {
      throw new Error('No vibrating device found. Start the Intiface server and turn the device on.');
    }
    for (const kind of kinds) {
      log(`${PATTERNS[kind].label}: ${PATTERNS[kind].name}`);
      player.play(kind);
      await player.idle();
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  } finally {
    await player.close();
    await output.close();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = rest.filter((arg) => arg.startsWith('--'));
  const args = rest.filter((arg) => !arg.startsWith('--'));
  const noDevice = flags.includes('--no-device');

  loadEnvFile();
  const config = loadConfig();

  switch (command) {
    case 'login': {
      const session = await new XAuth(config).login();
      console.log(`Logged in as @${session.username}.`);
      break;
    }
    case 'run':
      await runService(config, { noDevice, plain: flags.includes('--plain') });
      break;
    case 'try':
      await tryPatterns(config, args.length ? args : Object.keys(PATTERNS), noDevice);
      break;
    case 'cleanup': {
      const auth = new XAuth(config);
      const session = await auth.requireSession();
      const manager = new SubscriptionManager(new XApi(config, auth), session.user_id, {
        stateDir: config.stateDir,
        log,
      });
      const { deleted, failed } = await manager.cleanup();
      console.log(`Removed ${deleted} subscription(s).${failed ? ` ${failed} failed.` : ''}`);
      if (failed) process.exitCode = 1;
      break;
    }
    default:
      console.log(USAGE);
      if (command && command !== 'help') process.exitCode = 1;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
