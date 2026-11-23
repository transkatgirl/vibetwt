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

// One Ctrl+C can arrive twice: the terminal sends it to npm and to its script,
// and npm passes its copy on. A key can also repeat. Neither is a second request.
const SAME_REQUEST_MS = 1000;

function watchPlainKeyboard({ onToggle, onQuit, onInterrupt }) {
  const { stdin } = process;
  if (!stdin.isTTY) return () => {};

  // Keys pressed close together can arrive in one read. Ctrl+C counts wherever
  // it turns up. Space and q only count in a read made of nothing but keys,
  // so that a paste cannot press them.
  const onData = (chunk) => {
    const keys = [...chunk];
    const typed = keys.every((key) => key === ' ' || key === 'q' || key === '\u0003');
    for (const key of keys) {
      if (key === '\u0003') onInterrupt();
      else if (typed && key === ' ') onToggle();
      else if (typed && key === 'q') onQuit();
    }
  };
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  stdin.on('data', onData);
  log('Press space to stop and pause, q to quit.');

  return () => {
    stdin.off('data', onData);
    try {
      stdin.setRawMode(false);
    } catch {
      // The terminal is gone. What comes after a quit still has to happen.
    }
    stdin.pause();
  };
}

export async function runService(config, { noDevice = false, plain = false } = {}) {
  // Checked before anything is subscribed to, since the stream cannot open without it.
  if (!config.bearerToken) throw new Error('Set X_BEARER_TOKEN in .env first.');

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
  let quitAt = 0;
  let unsubscribed = false;

  // Starts a clean shutdown. Asking again changes nothing: only `interrupt`
  // can cut one short.
  const quit = (reason = 'Shutting down.') => {
    if (shutdown.signal.aborted) return;
    quitAt = Date.now();
    say(reason);
    shutdown.abort();
    // Stop the motor right away, before any slower network cleanup.
    player.close();
  };
  // Ctrl+C, or a signal that means the same. The first is an ordinary quit. A
  // later one means now, without waiting for X, so say what that leaves behind.
  const interrupt = () => {
    if (!shutdown.signal.aborted) {
      quit();
      return;
    }
    if (Date.now() - quitAt < SAME_REQUEST_MS) return;
    restoreTerminal();
    if (!unsubscribed) {
      log('Quit before the X subscriptions were removed. X bills for them until they expire. Run `npm run cleanup`.');
    }
    process.exit(1);
  };
  // A crash while shutting down is reported, but the shutdown still finishes.
  // The dashboard takes its notices with it when it closes, so a reason it was
  // showing is kept, to print once the terminal is back.
  const crashes = [];
  const onCrash = (error) => {
    process.exitCode = 1;
    const reason = `Unexpected error: ${error?.message ?? error}`;
    if (tui?.active) crashes.push(reason);
    if (shutdown.signal.aborted) say(reason);
    else quit(reason);
  };
  // A closed terminal sends SIGHUP. Nobody is waiting, so it never cuts cleanup short.
  const handlers = {
    SIGINT: interrupt,
    SIGTERM: interrupt,
    SIGHUP: () => quit(),
    uncaughtException: onCrash,
    unhandledRejection: onCrash,
  };
  Object.entries(handlers).forEach(([name, handler]) => process.on(name, handler));
  // A closed terminal or pipe fails every write to it. Nobody is left to read
  // them, so that is a reason to leave cleanly and never a crash. These stay
  // attached, because the last lines are written after the rest is undone.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => quit());

  const tui = interactive ? new Tui(session, { onQuit: () => quit(), onInterrupt: interrupt }) : null;
  const stopPlainKeyboard = interactive
    ? () => {}
    : watchPlainKeyboard({
      onToggle: () => {
        session.togglePause();
        log(session.paused ? 'Stopped and paused. Press space to resume.' : 'Resumed.');
      },
      onQuit: () => quit(),
      onInterrupt: interrupt,
    });
  const restoreTerminal = () => {
    tui?.stop();
    stopPlainKeyboard();
    for (const reason of crashes.splice(0)) log(reason);
  };

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
    restoreTerminal();
    session.notify = log;
    await player.close();
    await output.close();
    clearTimeout(saveTimer);
    if (unsaved) persist();
    await saving;
    // This takes a few requests to X, and silence here looks like a hang.
    log('Removing X subscriptions…');
    const { failed } = await subscriptions.stop();
    unsubscribed = true;
    if (failed > 0) log(`${failed} X subscription(s) could not be removed. Run \`npm run cleanup\`.`);
    else log('Removed X subscriptions.');
    log(`Estimated API cost this session: ${formatUsd(session.cost.snapshot().totalMicros)}`);
    Object.entries(handlers).forEach(([name, handler]) => process.off(name, handler));
  }
}
