import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

// The command that opens a URL in the default browser, or null where there is
// no desktop to open one on.
export function browserCommand(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return ['open'];
  if (platform === 'win32') {
    // Not `start`, which runs through cmd.exe and would cut the URL at its first "&".
    return [win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), 'url.dll,FileProtocolHandler'];
  }
  // Without a display, xdg-open would reach for a terminal browser.
  return env.DISPLAY || env.WAYLAND_DISPLAY ? ['xdg-open'] : null;
}

// Best effort. The caller prints the URL too, so a missing launcher is not an error.
export function openInBrowser(url, launcher = browserCommand()) {
  if (!launcher) return;
  const [command, ...args] = launcher;
  try {
    // Detached, so the browser outlives this process and a Ctrl+C in its terminal.
    const child = spawn(command, [...args, url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Nothing to do. The URL is still on screen.
  }
}
