import { CostMeter, formatUsd } from './cost.js';
import { Mixer } from './mixer.js';
import { PatternPlayer } from './player.js';
import { Session } from './session.js';
import { loadSettings, saveSettings, startingIntensity } from './settings.js';
import { Tui } from './ui/app.js';
import { NullOutput, Vibrator } from './vibrator.js';
import { XApi } from './x-api.js';
import { XAuth } from './x-auth.js';
import { ActivityStream } from './x-stream.js';
import { SubscriptionManager } from './x-subscriptions.js';

export const log = (message) => console.log(`${new Date().toLocaleTimeString()}  ${message}`);

function watchPlainKeyboard({ onToggle, onQuit }) {
  const { stdin } = process;
  if (!stdin.isTTY) return () => {};

  const onData = (key) => {
    if (key === ' ') onToggle();
    else if (key === 'q' || key === '\u0003') onQuit();
  };
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  stdin.on('data', onData);
  log('Press space to stop and pause, q to quit.');

  return () => {
    stdin.off('data', onData);
    stdin.setRawMode(false);
    stdin.pause();
  };
}

export async function runService(config, { noDevice = false, plain = false } = {}) {
  const interactive = !plain && process.stdin.isTTY && process.stdout.isTTY;
  const auth = new XAuth(config);
  const account = await auth.requireSession();
  const api = new XApi(config, auth);
  const settings = await loadSettings(config.stateDir);
  const intensityPct = startingIntensity(settings.intensityPct);

  let session = null;
  const say = (message) => (session ? session.notify(message) : log(message));
  const changed = () => session?.changed();

  const output = noDevice
    ? new NullOutput()
    : new Vibrator({ url: config.buttplugUrl, log: say });
  const mixer = new Mixer(output, { intensity: intensityPct / 100, log: say, onChange: changed });
  const player = new PatternPlayer(mixer, { onChange: changed });
  output.onChange = () => {
    mixer.resync();
    changed();
  };

  let saveTimer = null;
  let saving = Promise.resolve();
  let unsaved = false;
  const persist = () => {
    unsaved = false;
    const value = session.intensityPct;
    saving = saving
      .then(() => saveSettings(config.stateDir, { ...settings, intensityPct: value }))
      .catch((error) => say(`Could not save strength: ${error.message}`));
  };

  session = new Session({
    me: account.user_id,
    username: account.username,
    player,
    mixer,
    output,
    api,
    cost: new CostMeter(),
    intensityPct,
    print: interactive ? null : log,
    onIntensity: () => {
      unsaved = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 400);
    },
  });

  const subscriptions = new SubscriptionManager(api, account.user_id, { stateDir: config.stateDir, log: say });
  const shutdown = new AbortController();

  const quit = (reason) => {
    if (shutdown.signal.aborted) process.exit(1);
    if (reason) say(reason);
    shutdown.abort();
    // Stop the motor right away, before any slower network cleanup.
    player.close();
  };
  const onSignal = () => quit('Shutting down.');
  const onCrash = (error) => {
    process.exitCode = 1;
    quit(`Unexpected error: ${error?.message ?? error}`);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  signals.forEach((name) => process.on(name, onSignal));
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  const tui = interactive ? new Tui(session, { onQuit: () => quit('Shutting down.') }) : null;
  const stopPlainKeyboard = interactive
    ? () => {}
    : watchPlainKeyboard({
      onToggle: () => {
        session.togglePause();
        log(session.paused ? 'Stopped and paused. Press space to resume.' : 'Resumed.');
      },
      onQuit: () => quit('Shutting down.'),
    });

  const stream = new ActivityStream({
    api,
    log: say,
    onStatus: (status) => session.setStream(status),
    onEvent: (event) => session.receive(event),
  });

  if (!interactive) log(`Signed in as @${account.username}. Strength: ${intensityPct}%.`);
  tui?.start();
  output.start();

  try {
    await subscriptions.start();
    await stream.run(shutdown.signal);
  } finally {
    tui?.stop();
    session.notify = log;
    stopPlainKeyboard();
    await player.close();
    await output.close();
    clearTimeout(saveTimer);
    if (unsaved) persist();
    await saving;
    const { failed } = await subscriptions.stop();
    if (failed > 0) log(`${failed} X subscription(s) could not be removed. Run \`npm run cleanup\`.`);
    else log('Removed X subscriptions.');
    log(`Estimated API cost this session: ${formatUsd(session.cost.snapshot().totalMicros)}`);
    signals.forEach((name) => process.off(name, onSignal));
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  }
}
