#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadEnvFile } from './config.js';
import { takeLock } from './lock.js';
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
const FLAGS = ['--no-device', '--plain'];

// Whether one of the files npm reads its settings from gives it this one: the
// project's, the user's, or the one for everybody.
function inNpmrc(setting) {
  const { npm_config_local_prefix: project, npm_config_userconfig: user, npm_config_globalconfig: everybody } = process.env;
  const given = new RegExp(`^\\s*"?${setting}"?\\s*(?:=|$)`, 'm');
  return [project && join(project, '.npmrc'), user, everybody].filter(Boolean).some((file) => {
    try {
      return given.test(readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
  });
}

// Without `--` in front, npm keeps an option for itself and the script never
// sees it. All that is left is a setting in the environment: `device` for
// --no-device, `plain` for --plain. A setting written in an .npmrc ends up
// there too, and nobody typed that one, so it is not taken for an option. One
// that is both written and typed cannot be told from one only written.
function keptByNpm(flag) {
  const setting = flag.replace(/^--(no-)?/, '');
  return process.env[`npm_config_${setting.replaceAll('-', '_')}`] !== undefined && !inNpmrc(setting);
}

async function tryPatterns(config, kinds, noDevice) {
  for (const kind of kinds) {
    // Its own patterns only: every object also answers to names like "constructor".
    if (!Object.hasOwn(PATTERNS, kind)) throw new Error(`Unknown pattern "${kind}". Choose like, retweet, or reply.`);
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

  // A mistyped --no-device must not go on to run with the device on.
  const unknown = [...flags.filter((flag) => !FLAGS.includes(flag)), ...(command === 'try' ? [] : args)];
  if (unknown.length > 0) throw new Error(`Unknown option "${unknown[0]}".\n\n${USAGE}`);

  // Nor must one that npm kept, which is the same mistake seen from here.
  const kept = FLAGS.find(keptByNpm);
  if (kept) {
    const script = process.env.npm_lifecycle_event ?? 'start';
    const npm = script === 'start' ? 'npm start' : `npm run ${script}`;
    throw new Error(`npm kept "${kept}" for itself. Put "--" before it: ${npm} -- ${kept}`);
  }

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
      // A copy that is running removes its own on the way out, and needs them until then.
      const unlock = await takeLock(config.stateDir);
      try {
        const manager = new SubscriptionManager(new XApi(config, auth), session.user_id, {
          stateDir: config.stateDir,
          log,
        });
        const { deleted, failed, listed } = await manager.cleanup();
        console.log(`Removed ${deleted} subscription(s).${failed ? ` ${failed} failed.` : ''}`);
        // None found is only good news if X was there to be asked.
        if (!listed) console.log('X did not say which subscriptions are open, so there may be more. Run `npm run cleanup` again.');
        if (failed || !listed) process.exitCode = 1;
      } finally {
        unlock();
      }
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
