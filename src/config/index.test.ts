import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { StoredConfig } from "../types.ts";
import { clearTokens, configPath, readConfig, writeConfig } from "./index.ts";

let tmpDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bbmcp-"));
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

test("configPath honors XDG_CONFIG_HOME", () => {
  const p = configPath();
  expect(p).toBe(path.join(tmpDir, "bitbucket-mcp", "config.json"));
});

test("configPath falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
  delete process.env["XDG_CONFIG_HOME"];
  const p = configPath();
  expect(p).toBe(path.join(os.homedir(), ".config", "bitbucket-mcp", "config.json"));
});

test("configPath falls back to ~/.config when XDG_CONFIG_HOME is empty", () => {
  process.env["XDG_CONFIG_HOME"] = "";
  const p = configPath();
  expect(p).toBe(path.join(os.homedir(), ".config", "bitbucket-mcp", "config.json"));
});

test("readConfig returns {} when file is missing", async () => {
  const cfg = await readConfig();
  expect(cfg).toEqual({});
});

test("writeConfig then readConfig round-trips", async () => {
  const data: StoredConfig = {
    clientKey: "key-abc",
    clientSecret: "secret-xyz",
    tokens: {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1_700_000_000,
      scopes: ["account", "repository"],
    },
  };
  await writeConfig(data);
  const round = await readConfig();
  expect(round).toEqual(data);
});

test("partial writes do not clobber existing fields", async () => {
  await writeConfig({ clientKey: "k1", clientSecret: "s1" });
  await writeConfig({
    tokens: {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 42,
      scopes: ["account"],
    },
  });
  const cfg = await readConfig();
  expect(cfg.clientKey).toBe("k1");
  expect(cfg.clientSecret).toBe("s1");
  expect(cfg.tokens?.accessToken).toBe("a");
});

test("written config file has mode 0600", async () => {
  if (process.platform === "win32") {
    return;
  }
  await writeConfig({ clientKey: "k" });
  const p = configPath();
  const stat = await fsp.stat(p);
  // Low 9 bits = permissions.
  expect(stat.mode & 0o777).toBe(0o600);
});

test("parent directory has mode 0700", async () => {
  if (process.platform === "win32") {
    return;
  }
  await writeConfig({ clientKey: "k" });
  const p = configPath();
  const stat = await fsp.stat(path.dirname(p));
  expect(stat.mode & 0o777).toBe(0o700);
});

test("corrupt JSON throws an error pointing to the config path", async () => {
  const p = configPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, "{ this is not json", "utf8");
  await expect(readConfig()).rejects.toThrow(/config file/);
  await expect(readConfig()).rejects.toThrow(p);
});

test("invalid schema shape throws a clear error", async () => {
  const p = configPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify({ clientKey: 42 }), "utf8");
  await expect(readConfig()).rejects.toThrow(/invalid shape/);
});

test("sequential writes/reads interleave correctly (atomic)", async () => {
  await writeConfig({ clientKey: "one" });
  const a = await readConfig();
  expect(a.clientKey).toBe("one");
  await writeConfig({ clientKey: "two" });
  const b = await readConfig();
  expect(b.clientKey).toBe("two");
  await writeConfig({ clientSecret: "secret-two" });
  const c = await readConfig();
  expect(c.clientKey).toBe("two");
  expect(c.clientSecret).toBe("secret-two");
});

test("concurrent writes always leave a valid, parseable file", async () => {
  // Fire writes in parallel; any order is acceptable, but the final file
  // must be parseable and must contain one of the values (no partial write).
  const writers = await Promise.all(
    Array.from({ length: 10 }, (_, i) => writeConfig({ clientKey: `k${i}` })),
  );
  expect(writers).toHaveLength(10);
  const cfg = await readConfig();
  expect(cfg.clientKey).toMatch(/^k\d$/);
});

test("clearTokens removes tokens but preserves key/secret", async () => {
  await writeConfig({
    clientKey: "k",
    clientSecret: "s",
    tokens: {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
      scopes: ["account"],
    },
  });
  await clearTokens();
  const cfg = await readConfig();
  expect(cfg.clientKey).toBe("k");
  expect(cfg.clientSecret).toBe("s");
  expect(cfg.tokens).toBeUndefined();
});

test("clearTokens on empty config is a no-op", async () => {
  await clearTokens();
  const cfg = await readConfig();
  expect(cfg).toEqual({});
});
