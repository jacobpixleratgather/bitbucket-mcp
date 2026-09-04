import * as fs from "node:fs/promises";
import * as path from "node:path";
import { configPath } from "./index.ts";

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 200;

/**
 * The cross-process lock guarding a token refresh. Lives beside the config so
 * that every tool sharing that config - other server processes, and scripts
 * that borrow these credentials - contends for the same lock.
 */
export function refreshLockPath(): string {
  return path.join(path.dirname(configPath()), ".refresh.lock");
}

/**
 * Runs `fn` while holding the refresh lock, and reports whether the lock was
 * actually acquired.
 *
 * Bitbucket's refresh tokens rotate: spending one retires it, so two processes
 * refreshing at the same moment means one of them ends up holding a token the
 * server has already thrown away. Serialising the refresh removes that race.
 *
 * A lock is never allowed to block a tool call forever: one older than
 * `staleMs` belonged to a process that died holding it and is broken, and after
 * `waitMs` of queueing `fn` runs anyway with `held: false`. Both are safer than
 * hanging, because a lost race is recoverable and a hung MCP call is not.
 */
export async function withRefreshLock<T>(
  fn: (held: boolean) => Promise<T>,
  opts?: { waitMs?: number; staleMs?: number; pollMs?: number; now?: () => number },
): Promise<T> {
  const waitMs = opts?.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const now = opts?.now ?? Date.now;

  const held = await acquire({ waitMs, staleMs, pollMs, now });
  try {
    return await fn(held);
  } finally {
    if (held) {
      await release();
    }
  }
}

/** mkdir without `recursive` fails if the directory exists, which makes it the lock. */
async function acquire(p: {
  waitMs: number;
  staleMs: number;
  pollMs: number;
  now: () => number;
}): Promise<boolean> {
  const lock = refreshLockPath();
  await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = p.now() + p.waitMs;
  for (;;) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      return true;
    } catch (err) {
      if (!isNodeError(err) || err.code !== "EEXIST") {
        // Cannot lock (read-only home, exotic filesystem): refreshing unlocked
        // beats refusing to refresh at all.
        return false;
      }
      const age = await fs.stat(lock).then(
        (s) => p.now() - s.mtimeMs,
        () => 0,
      );
      if (age > p.staleMs) {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (p.now() >= deadline) {
        return false;
      }
      await sleep(p.pollMs);
    }
  }
}

async function release(): Promise<void> {
  await fs.rm(refreshLockPath(), { recursive: true, force: true }).catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
