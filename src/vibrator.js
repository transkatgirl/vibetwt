import { setTimeout as delay } from 'node:timers/promises';
import {
  ButtplugClient,
  ButtplugNodeWebsocketClientConnector,
  DeviceOutput,
  OutputType,
} from 'buttplug';
import WebSocket from 'ws';

class CommandTimeout extends Error {}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CommandTimeout(`No response within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The library removes its socket error listener after connecting, and an
// unhandled `ws` error would crash the process. A close event always follows.
class ResilientSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    this.on('error', () => {});
  }
}

class Connector extends ButtplugNodeWebsocketClientConnector {
  _websocketConstructor = ResilientSocket;
}

// The library's own keep-alive is disabled, so servers with a ping timeout
// would otherwise drop the connection.
class KeepAliveClient extends ButtplugClient {
  #timer = null;

  startPing() {
    const maxPing = this.serverInfo?.maxPingTime;
    if (!maxPing) return;
    this.#timer = setInterval(() => {
      withTimeout(this.sendMsgExpectOk({ Ping: { Id: 1 } }), maxPing).catch(() => {});
    }, Math.max(100, Math.floor(maxPing / 2)));
  }

  stopPing() {
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

// Converts a 0-1 level to the nearest device step. Any level above zero gets
// at least the lowest step, so weak patterns stay perceptible on coarse motors.
export function toDeviceValue(level, [min, max]) {
  if (level <= 0) return min;
  return min + Math.max(1, Math.round((max - min) * Math.min(level, 1)));
}

export class Vibrator {
  #url;
  #log;
  #timeoutMs;
  #client = null;
  #connector = null;
  #loop = null;
  #closed = false;
  #abort = new AbortController();
  onChange = () => {};

  constructor({ url, log = () => {}, commandTimeoutMs = 2000 }) {
    this.#url = url;
    this.#log = log;
    this.#timeoutMs = commandTimeoutMs;
  }

  start() {
    this.#loop ??= this.#connectLoop();
  }

  get ready() {
    return this.#motors().length > 0;
  }

  get status() {
    if (!this.#client?.connected) return { connected: false, devices: [] };
    const devices = [...this.#client.devices.values()]
      .filter((device) => device.hasOutput(OutputType.Vibrate))
      .map((device) => device.displayName ?? device.name);
    return { connected: true, devices };
  }

  async waitForDevice(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!this.ready && Date.now() < deadline) await delay(100);
    return this.ready;
  }

  async set(level) {
    const results = await Promise.allSettled(
      this.#motors().map(({ feature, range }) =>
        this.#command(feature.runOutput(DeviceOutput.Vibrate.value(toDeviceValue(level, range)))),
      ),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  async stop() {
    if (this.#client?.connected) await this.#command(this.#client.stopAllDevices());
  }

  async close() {
    this.#closed = true;
    this.#abort.abort();
    const client = this.#client;
    if (client?.connected) {
      client.stopPing();
      await withTimeout(client.disconnect(), 1500).catch(() => this.#connector?.disconnect());
    }
    await this.#loop;
  }

  #motors() {
    if (!this.#client?.connected) return [];
    const motors = [];
    for (const device of this.#client.devices.values()) {
      for (const feature of device.features.values()) {
        const output = feature.output(OutputType.Vibrate);
        if (output) motors.push({ feature, range: output.valueRange });
      }
    }
    return motors;
  }

  async #command(promise) {
    try {
      return await withTimeout(promise, this.#timeoutMs);
    } catch (error) {
      // A silent server may have lost the connection. Closing forces a reconnect.
      if (error instanceof CommandTimeout) await this.#connector?.disconnect().catch(() => {});
      throw error;
    }
  }

  async #connectLoop() {
    let backoff = 1000;
    let lastError = '';

    while (!this.#closed) {
      const connector = new Connector(this.#url);
      const client = new KeepAliveClient('vibetwt');
      const disconnected = new Promise((resolve) => client.once('disconnect', resolve));
      this.#watchDevices(client);

      try {
        await withTimeout(client.connect(connector), 5000);
        this.#client = client;
        this.#connector = connector;
        client.startPing();
        backoff = 1000;
        lastError = '';
        this.#log(`Connected to ${client.serverInfo?.serverName ?? 'Buttplug server'}.`);
        this.#updateScanning(client);
        this.onChange();

        await Promise.race([disconnected, this.#closedSignal()]);
        client.stopPing();
        if (!this.#closed) this.#log('Lost connection to Intiface. Reconnecting.');
      } catch (error) {
        await connector.disconnect().catch(() => {});
        if (error.message !== lastError) {
          lastError = error.message;
          this.#log(`Waiting for Intiface at ${this.#url} (${error.message}). Is its server started?`);
        }
      }

      if (this.#closed) return;
      this.#client = null;
      this.#connector = null;
      this.onChange();
      await delay(backoff, undefined, { signal: this.#abort.signal }).catch(() => {});
      backoff = Math.min(backoff * 2, 15_000);
    }
  }

  #closedSignal() {
    return new Promise((resolve) => this.#abort.signal.addEventListener('abort', resolve, { once: true }));
  }

  #watchDevices(client) {
    client.on('deviceadded', (device) => {
      const motors = [...device.features.values()]
        .map((feature) => feature.output(OutputType.Vibrate))
        .filter(Boolean);
      if (motors.length === 0) {
        this.#log(`Found ${device.displayName ?? device.name}, but it has no vibration motor.`);
      } else {
        this.#log(`Device ready: ${device.displayName ?? device.name} (${motors.length} motor${motors.length > 1 ? 's' : ''}).`);
      }
      this.#updateScanning(client);
      this.onChange();
    });
    client.on('deviceremoved', (device) => {
      this.#log(`Device disconnected: ${device.displayName ?? device.name}.`);
      this.#updateScanning(client);
      this.onChange();
    });
  }

  #updateScanning(client) {
    if (!client.connected || this.#closed) return;
    const hasMotor = [...client.devices.values()].some((device) => device.hasOutput(OutputType.Vibrate));
    const change = hasMotor
      ? client.isScanning && client.stopScanning()
      : !client.isScanning && client.startScanning();
    if (change) {
      withTimeout(change, this.#timeoutMs).catch((error) => this.#log(`Device scan problem: ${error.message}`));
    }
  }
}

export class NullOutput {
  ready = true;
  status = { connected: true, devices: ['no device mode'] };
  onChange = () => {};
  start() {}
  async waitForDevice() {
    return true;
  }
  async set() {}
  async stop() {}
  async close() {}
}
