import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { StoredTokens } from "../types.ts";
import { handleAuthorize, handleCredentials, handlePrintConfig } from "./bitbucket-mcp.ts";

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bbmcp-bin-"));
  originalXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdg;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function feedStdin(stream: PassThrough, text: string): void {
  setImmediate(() => {
    stream.write(text);
    stream.end();
  });
}

function collect(stream: PassThrough): { text: () => string } {
  const chunks: string[] = [];
  stream.on("data", (c: Buffer | string) => {
    chunks.push(typeof c === "string" ? c : c.toString("utf8"));
  });
  return { text: () => chunks.join("") };
}

function configFilePath(): string {
  return path.join(tmpDir, "bitbucket-mcp", "config.json");
}

function readSavedConfig(): { clientKey?: string; clientSecret?: string } {
  return JSON.parse(fs.readFileSync(configFilePath(), "utf8")) as {
    clientKey?: string;
    clientSecret?: string;
  };
}

// --------------------------------------------------------------------------
// credentials
// --------------------------------------------------------------------------

test("credentials writes key and secret from stdin", async () => {
  const stdin = new PassThrough();
  feedStdin(stdin, "super-secret");
  await handleCredentials({
    argv: ["--key", "consumer-key"],
    stdin,
    env: {},
  });
  const saved = readSavedConfig();
  expect(saved.clientKey).toBe("consumer-key");
  expect(saved.clientSecret).toBe("super-secret");
});

test("credentials supports --key=value form", async () => {
  const stdin = new PassThrough();
  feedStdin(stdin, "s");
  await handleCredentials({
    argv: ["--key=k"],
    stdin,
    env: {},
  });
  expect(readSavedConfig().clientKey).toBe("k");
});

test("credentials prefers $BITBUCKET_CLIENT_SECRET over stdin", async () => {
  const stdin = new PassThrough();
  // Feed something bogus; the env var should win.
  feedStdin(stdin, "wrong");
  await handleCredentials({
    argv: ["--key", "k"],
    stdin,
    env: { BITBUCKET_CLIENT_SECRET: "env-secret" },
  });
  expect(readSavedConfig().clientSecret).toBe("env-secret");
});

test("credentials throws when --key is missing", async () => {
  const stdin = new PassThrough();
  feedStdin(stdin, "whatever");
  await expect(handleCredentials({ argv: [], stdin, env: {} })).rejects.toThrow(/requires --key/);
});

test("credentials throws when no secret is provided", async () => {
  const stdin = new PassThrough();
  // End immediately with no data; no env var set.
  setImmediate(() => stdin.end());
  await expect(handleCredentials({ argv: ["--key", "k"], stdin, env: {} })).rejects.toThrow(
    /requires a secret/,
  );
});

test("credentials trims trailing newline from stdin secret", async () => {
  const stdin = new PassThrough();
  feedStdin(stdin, "my-secret\n");
  await handleCredentials({
    argv: ["--key", "k"],
    stdin,
    env: {},
  });
  expect(readSavedConfig().clientSecret).toBe("my-secret");
});

// --------------------------------------------------------------------------
// authorize
// --------------------------------------------------------------------------

function sampleTokens(scopes: readonly string[]): StoredTokens {
  return {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: Date.now() + 3600_000,
    scopes: scopes.slice(),
  };
}

async function seedCredentials(): Promise<void> {
  const stdin = new PassThrough();
  feedStdin(stdin, "the-secret");
  await handleCredentials({
    argv: ["--key", "the-key"],
    stdin,
    env: {},
  });
}

test("authorize throws when credentials are missing", async () => {
  const stdout = new PassThrough();
  await expect(
    handleAuthorize({
      stdout,
      runAuthorizationFlow: vi.fn(async () =>
        sampleTokens(["account", "repository", "pullrequest", "pullrequest:write", "pipeline"]),
      ) as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
    }),
  ).rejects.toThrow(/Missing OAuth credentials/);
});

test("authorize passes stored credentials and prints granted scopes", async () => {
  await seedCredentials();
  const stdout = new PassThrough();
  const out = collect(stdout);
  const runAuth = vi.fn(async () =>
    sampleTokens(["account", "repository", "pullrequest", "pullrequest:write", "pipeline"]),
  );
  await handleAuthorize({
    stdout,
    runAuthorizationFlow:
      runAuth as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });
  expect(runAuth).toHaveBeenCalledWith({
    clientKey: "the-key",
    clientSecret: "the-secret",
  });
  const text = out.text();
  expect(text).toContain("Authentication complete");
  expect(text).toContain("pullrequest:write");
  expect(text).not.toContain("WARNING");
});

test("authorize prints scope warning when required scopes are missing", async () => {
  await seedCredentials();
  const stdout = new PassThrough();
  const out = collect(stdout);
  const runAuth = vi.fn(async () =>
    sampleTokens(["account", "repository", "pullrequest", "pipeline"]),
  );
  await handleAuthorize({
    stdout,
    runAuthorizationFlow:
      runAuth as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });
  const text = out.text();
  expect(text).toContain("WARNING");
  expect(text).toContain("pullrequest:write");
});

// --------------------------------------------------------------------------
// print-config
// --------------------------------------------------------------------------

const NPX_PAYLOAD = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@mcpkit/bitbucket"],
  env: {},
};

test("print-config (bare) emits the hardcoded npx payload", async () => {
  const stdout = new PassThrough();
  const out = collect(stdout);
  await handlePrintConfig({ argv: [], stdout });
  expect(JSON.parse(out.text())).toEqual(NPX_PAYLOAD);
});

test("print-config --mcp-add-json also emits the npx payload", async () => {
  const stdout = new PassThrough();
  const out = collect(stdout);
  await handlePrintConfig({ argv: ["--mcp-add-json"], stdout });
  expect(JSON.parse(out.text())).toEqual(NPX_PAYLOAD);
});

test("print-config --raw is rejected with a clear error", async () => {
  const stdout = new PassThrough();
  await expect(handlePrintConfig({ argv: ["--raw"], stdout })).rejects.toThrow(
    /is no longer supported/,
  );
});
