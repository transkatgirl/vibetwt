import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmdirSync, unlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Far more than it takes. Each try that fails found something in the way and
// cleared it, so one that still fails after this many is not waiting on anyone.
const MAX_TRIES = 10;
// How long `ps` gets to answer. It takes a few milliseconds.
const PS_TIMEOUT_MS = 2000;

// Whether a process of this user's has that ID. One that cannot be signalled
// belongs to somebody else, so it is not a vibetwt that used this directory.
function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// When the process with this ID started, as the system tells it, or '' where
// it does not. An ID is only a process's own while it lives, and is given to
// another after that, most of all once the machine has been restarted. When
// it started is what a later process with the same ID cannot share.
//
// The answer must be the same every time for as long as the process runs, or
// a lock that is held would look abandoned. So Linux is asked for its count
// since it was started, which does not move when the clock is set. macOS is
// asked through `ps`, which writes the time in the language and time zone of
// whoever asks, so it is always asked in the same ones.
async function startedAt(pid) {
  try {
    if (process.platform === 'linux') {
      // The process's name comes second, and may hold spaces and brackets of
      // its own, so the rest are counted from where it ends. The start is the
      // twenty-second in all.
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
    }
    if (process.platform === 'darwin') {
      const { stdout } = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        timeout: PS_TIMEOUT_MS,
      });
      return stdout.trim();
    }
  } catch {
    // Not knowing settles nothing, and the ID is left to speak for itself.
  }
  return '';
}

// Whether the process that left `file` in the lock is still running: one has
// its ID, and started when the lock says its process did. Where either start
// is not known, the ID is taken at its word. Being wrong that way refuses a
// start that could have gone ahead, and says which directory to delete. Being
// wrong the other way costs a copy that is running its subscriptions.
async function isHeld(file, owner) {
  if (!isRunning(owner)) return false;
  const then = (await readFile(file, 'utf8').catch(() => '')).trim();
  const now = then && await startedAt(owner);
  return !then || !now || then === now;
}

// Takes out of the lock what processes that are gone left in it, and refuses
// if one that left something is still running. Everything is removed by its
// own name, and the directory only once it is empty, so none of this can take
// a lock that somebody else got hold of in the meantime.
async function clearAbandoned(path) {
  let names;
  try {
    names = await readdir(path);
  } catch (error) {
    // A file where the directory goes is nobody's lock.
    if (error.code === 'ENOTDIR') await unlink(path).catch(() => {});
    else if (error.code !== 'ENOENT') throw error;
    return;
  }

  for (const name of names) {
    const owner = Number(/^(\d+)-/.exec(name)?.[1]);
    // IDs come round again, and in a container a new process often gets the
    // very one the last had. This process cannot be the one that left this.
    if (owner !== process.pid && await isHeld(join(path, name), owner)) {
      throw new Error(
        `vibetwt is already running (process ${owner}), and this would remove its X subscriptions. `
        + `Quit it first. If it is not running, delete ${path}.`,
      );
    }
    await rm(join(path, name), { recursive: true, force: true });
  }
  await rmdir(path).catch(() => {});
}

// Two copies at once undo each other: each takes every subscription tagged
// `vibetwt` for its own leftovers and removes it. So the state directory holds
// a lock naming the one process using it, and a second is refused. What a
// process that is gone left there is cleared away, because a crash must not
// keep the next start, or `npm run cleanup`, out.
//
// The lock is a directory with one file in it, named for its process and
// holding when that process started. It is made whole somewhere else and then
// moved into place, which only works while nothing is there but an empty
// directory. So of any number that try at once, one gets it, and there is
// never a moment when a lock is there but does not yet say whose it is.
// Returns what gives the directory back.
export async function takeLock(dir) {
  const path = join(dir, 'lock');
  // The ID alone is not enough of a name, because another process may be
  // given it later.
  const name = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const made = join(dir, `lock.${name}.tmp`);
  await mkdir(made, { recursive: true, mode: 0o700 });

  try {
    await writeFile(join(made, name), await startedAt(process.pid), { mode: 0o600 });
    for (let tries = 1; ; tries++) {
      try {
        await rename(made, path);
        break;
      } catch (error) {
        if (tries === MAX_TRIES) throw error;
      }
      await clearAbandoned(path);
    }
  } catch (error) {
    await rm(made, { recursive: true, force: true });
    throw error;
  }

  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    process.off('exit', release);
    try {
      unlinkSync(join(path, name));
      rmdirSync(path);
    } catch {
      // Already gone, which is all that was wanted.
    }
  };
  // However the process leaves, short of being killed outright.
  process.once('exit', release);
  return release;
}
