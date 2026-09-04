import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { refreshLockPath, withRefreshLock } from "./lock.ts";

let tmpDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bbmcp-lock-"));
  prevXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = tmpDir;
});

afterEach(() => {
  if (prevXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = prevXdg;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("withRefreshLock holds the lock for the callback and releases it after", async () => {
  const seen = await withRefreshLock(async (held) => {
    expect(held).toBe(true);
    expect(fs.existsSync(refreshLockPath())).toBe(true);
    return "done";
  });
  expect(seen).toBe("done");
  expect(fs.existsSync(refreshLockPath())).toBe(false);
});

test("withRefreshLock releases the lock when the callback throws", async () => {
  await expect(
    withRefreshLock(async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(fs.existsSync(refreshLockPath())).toBe(false);
});

test("withRefreshLock serialises contending callers", async () => {
  const order: string[] = [];
  const body = (name: string) => async () => {
    order.push(`${name}:in`);
    await new Promise((r) => setTimeout(r, 20));
    order.push(`${name}:out`);
  };
  await Promise.all([
    withRefreshLock(body("a"), { pollMs: 5 }),
    withRefreshLock(body("b"), { pollMs: 5 }),
  ]);
  // Whoever went first must have left before the other entered.
  expect(order[1]).toBe(order[0]!.replace(":in", ":out"));
});

test("withRefreshLock breaks a lock left behind by a dead process", async () => {
  const lock = refreshLockPath();
  fs.mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  const held = await withRefreshLock(async (h) => h, { pollMs: 5 });
  expect(held).toBe(true);
});

test("withRefreshLock runs unlocked rather than hanging, and leaves the holder's lock alone", async () => {
  const lock = refreshLockPath();
  fs.mkdirSync(lock, { recursive: true });
  const held = await withRefreshLock(async (h) => h, { waitMs: 0, pollMs: 5 });
  expect(held).toBe(false);
  expect(fs.existsSync(lock)).toBe(true);
});
