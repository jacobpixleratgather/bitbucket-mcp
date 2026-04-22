import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { RepoTarget, StoredTokens } from "../types.ts";
import { promptMaskedInput, runSetup } from "./index.ts";
import { type ClaudeRunner } from "../claude-cli/index.ts";

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bbmcp-setup-"));
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

function collect(stream: PassThrough): { text: () => string } {
  const chunks: string[] = [];
  stream.on("data", (c: Buffer | string) => {
    chunks.push(typeof c === "string" ? c : c.toString("utf8"));
  });
  return { text: () => chunks.join("") };
}

// readline buffers its input in a way that only the first line is immediately
// consumed when the stream is a PassThrough fed synchronously. Feeding one line
// per tick reliably drives a sequence of question() calls.
function script(stdin: PassThrough, lines: string[]): void {
  const queue = lines.slice();
  const feed = (): void => {
    const next = queue.shift();
    if (next === undefined) return;
    stdin.write(`${next}\n`);
    setImmediate(feed);
  };
  feed();
}

function sampleTokens(): StoredTokens {
  return {
    accessToken: "acc",
    refreshToken: "ref",
    expiresAt: Date.now() + 3600_000,
    scopes: ["account", "repository", "pullrequest"],
  };
}

// ---------- Masked input ----------

test("promptMaskedInput reads input without echoing on non-TTY", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  const stdout = new PassThrough();
  const out = collect(stdout);

  // PassThrough has no isTTY → the helper must fall back to line mode.
  stdin.isTTY = false;

  setImmediate(() => {
    stdin.write("super-secret\n");
  });

  const value = await promptMaskedInput({
    stdin,
    stdout,
    prompt: "Secret: ",
  });

  expect(value).toBe("super-secret");

  // The prompt label should appear, but NOT the secret itself.
  const text = out.text();
  expect(text).toContain("Secret:");
  expect(text).not.toContain("super-secret");
});

// ---------- Injection points ----------

test("runSetup uses injected openBrowser and inferRepo", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  script(stdin, ["", "k", "s"]);

  const openBrowser = vi.fn(async (_url: string) => undefined);
  const inferRepo = vi.fn(
    async (): Promise<RepoTarget | null> => ({
      workspace: "my-ws",
      repo: "my-repo",
    }),
  );
  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    openBrowser,
    inferRepo,
    claudeJsonPath: "/nonexistent",
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(inferRepo).toHaveBeenCalled();
});

// ---------- Scope verification ----------

const FULL_SCOPES: readonly string[] = [
  "account",
  "repository",
  "pullrequest",
  "pullrequest:write",
  "pipeline",
];

test("scope warning is printed when a required scope is missing", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  script(stdin, ["", "k", "s"]);

  const runAuthorizationFlow = vi.fn(async () => ({
    accessToken: "a",
    refreshToken: "r",
    expiresAt: Date.now() + 3600_000,
    scopes: ["account", "repository", "pullrequest", "pipeline"], // missing pullrequest:write
  }));

  await runSetup({
    stdin,
    stdout,
    stderr,
    claudeJsonPath: "/nonexistent",
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  const text = out.text();
  expect(text).toContain("missing scope");
  expect(text).toContain("pullrequest:write");
});

test("no scope warning when all required scopes are granted", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  script(stdin, ["", "k", "s"]);

  const runAuthorizationFlow = vi.fn(async () => ({
    accessToken: "a",
    refreshToken: "r",
    expiresAt: Date.now() + 3600_000,
    scopes: FULL_SCOPES.slice(),
  }));

  await runSetup({
    stdin,
    stdout,
    stderr,
    claudeJsonPath: "/nonexistent",
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(out.text()).not.toContain("missing scope");
});

// ---------- Step structure ----------

test("step 1 opens the workspace-specific consumers page when repo is inferred", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  script(stdin, ["", "k", "s"]);

  const openBrowser = vi.fn(async (_url: string) => undefined);
  const inferRepo = vi.fn(async () => ({ workspace: "acme", repo: "web" }));
  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    openBrowser,
    inferRepo,
    claudeJsonPath: "/nonexistent",
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(openBrowser).toHaveBeenCalledTimes(1);
  expect(openBrowser).toHaveBeenCalledWith(
    "https://bitbucket.org/acme/workspace/settings/oauth-consumers",
  );
  expect(out.text()).toContain("https://bitbucket.org/acme/workspace/settings/oauth-consumers");
});

test("step 1 opens the generic workspaces page when repo inference returns null", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  script(stdin, ["", "k", "s"]);

  const openBrowser = vi.fn(async (_url: string) => undefined);
  const inferRepo = vi.fn(async () => null);
  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    openBrowser,
    inferRepo,
    claudeJsonPath: "/nonexistent",
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(openBrowser).toHaveBeenCalledWith("https://bitbucket.org/account/workspaces/");
});

test("step 2 prompt for credentials appears only after user presses Enter on step 1", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const events: string[] = [];
  stdout.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.includes("Step 1 of 3")) events.push("step1-header");
    if (text.includes("Step 2 of 3")) events.push("step2-header");
    if (text.includes("Key:")) events.push("key-prompt");
  });

  script(stdin, ["", "my-key", "my-secret"]);

  const openBrowser = vi.fn(async (_url: string) => undefined);
  const inferRepo = vi.fn(async () => null);
  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    openBrowser,
    inferRepo,
    claudeJsonPath: "/nonexistent",
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(events).toContain("step1-header");
  expect(events).toContain("step2-header");
  expect(events).toContain("key-prompt");
  expect(events.indexOf("step1-header")).toBeLessThan(events.indexOf("step2-header"));
  expect(events.indexOf("step2-header")).toBeLessThanOrEqual(events.indexOf("key-prompt"));
});

// ---------- Happy path ----------

test("runSetup writes creds, calls runAuthorizationFlow, prints success", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  script(stdin, ["", "my-key", "my-secret"]);

  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    claudeJsonPath: "/nonexistent",
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  // Config should have been written with the provided client key/secret.
  const cfgPath = path.join(tmpDir, "bitbucket-mcp", "config.json");
  const saved = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
    clientKey: string;
    clientSecret: string;
  };
  expect(saved.clientKey).toBe("my-key");
  expect(saved.clientSecret).toBe("my-secret");

  expect(runAuthorizationFlow).toHaveBeenCalledWith({
    clientKey: "my-key",
    clientSecret: "my-secret",
  });

  const output = out.text();
  expect(output).toContain("bitbucket-mcp setup");
  expect(output).toContain("Authentication complete");
  expect(output).toContain("account, repository, pullrequest");
});

// ---------- Empty input re-prompts ----------

test("empty client key re-prompts until non-empty", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // Blank newline, blank-only, then actual key.
  // Sequence of answers: [initial Enter, "", "   ", "real-key", "real-secret"]
  script(stdin, ["", "", "   ", "real-key", "real-secret"]);

  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    claudeJsonPath: "/nonexistent",
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(runAuthorizationFlow).toHaveBeenCalledWith({
    clientKey: "real-key",
    clientSecret: "real-secret",
  });
});

// ---------- Env-var fast-path ----------

test("env-var fast-path: TTY accept skips Steps 1+2 and authorizes with env creds", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  // Force the TTY branch so the prompt is reachable.
  stdin.isTTY = true;
  // Single line answer for the env-var prompt.
  script(stdin, [""]); // empty = accept default Y

  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {
      BITBUCKET_CLIENT_KEY: "env-key",
      BITBUCKET_CLIENT_SECRET: "env-secret",
    },
    claudeJsonPath: "/nonexistent",
    claudeRunner: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "" })) as ClaudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(runAuthorizationFlow).toHaveBeenCalledWith({
    clientKey: "env-key",
    clientSecret: "env-secret",
  });
  // Step 1's "Add consumer" instructions must NOT appear.
  expect(out.text()).not.toContain("Add consumer");
});

test("env-var fast-path: TTY decline runs the full wizard, ignoring env vars", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  stdin.isTTY = true;
  // First answer = "n" (decline env-var prompt). Then full wizard: Enter, key, secret.
  script(stdin, ["n", "", "typed-key", "typed-secret"]);

  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {
      BITBUCKET_CLIENT_KEY: "env-key",
      BITBUCKET_CLIENT_SECRET: "env-secret",
    },
    claudeJsonPath: "/nonexistent",
    claudeRunner: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "" })) as ClaudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(runAuthorizationFlow).toHaveBeenCalledWith({
    clientKey: "typed-key",
    clientSecret: "typed-secret",
  });
});

test("env-var fast-path: non-TTY uses env creds without prompting", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // No isTTY override → defaults undefined, treated as non-TTY.
  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {
      BITBUCKET_CLIENT_KEY: "scripted-key",
      BITBUCKET_CLIENT_SECRET: "scripted-secret",
    },
    claudeJsonPath: "/nonexistent",
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(runAuthorizationFlow).toHaveBeenCalledWith({
    clientKey: "scripted-key",
    clientSecret: "scripted-secret",
  });
});

test("env-var fast-path: only one of two vars set is ignored", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // No env-var prompt should appear; full wizard runs.
  script(stdin, ["", "typed-key", "typed-secret"]);

  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: { BITBUCKET_CLIENT_KEY: "only-key" }, // missing SECRET
    claudeJsonPath: "/nonexistent",
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(runAuthorizationFlow).toHaveBeenCalledWith({
    clientKey: "typed-key",
    clientSecret: "typed-secret",
  });
});

// ---------- Failure path ----------

test("runAuthorizationFlow throwing causes runSetup to throw and print error", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const errOut = collect(stderr);

  script(stdin, ["", "k", "s"]);

  const runAuthorizationFlow = vi.fn(async () => {
    throw new Error("browser flow failed");
  });

  await expect(
    runSetup({
      stdin,
      stdout,
      stderr,
      claudeJsonPath: "/nonexistent",
      openBrowser: vi.fn(async () => undefined),
      inferRepo: vi.fn(async () => null),
      runAuthorizationFlow:
        runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
    }),
  ).rejects.toThrow("browser flow failed");

  expect(errOut.text()).toContain("Setup failed");
  expect(errOut.text()).toContain("browser flow failed");
});

// Helper: builds a minimal Claude config with a `bitbucket` entry of the
// requested shape, written to a temp file and returns its path.
function writeClaudeConfigFor(status: "absent" | "local-build" | "on-npx" | "unknown"): string {
  let server: unknown = undefined;
  if (status === "local-build") {
    server = { type: "stdio", command: "/abs/dist/bitbucket-mcp.mjs", args: [] };
  } else if (status === "on-npx") {
    server = { type: "stdio", command: "npx", args: ["-y", "@bb-mcp/server"] };
  } else if (status === "unknown") {
    server = { type: "stdio", command: "node", args: ["/some/other.js"] };
  }
  const cfg = server === undefined ? {} : { mcpServers: { bitbucket: server } };
  const p = path.join(tmpDir, ".claude.json");
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

// Helper: writes a valid token blob into the bitbucket-mcp config so the
// wizard sees "valid tokens".
async function seedTokens(): Promise<void> {
  const cfgDir = path.join(tmpDir, "bitbucket-mcp");
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const cfg = {
    clientKey: "k",
    clientSecret: "s",
    tokens: {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 3600_000,
      scopes: ["account"],
    },
  };
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify(cfg), { mode: 0o600 });
}

// ---------- Decision matrix ----------

test("matrix: fresh install (no tokens, no registration) → full wizard", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  script(stdin, ["", "k", "s"]);
  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {},
    claudeJsonPath: writeClaudeConfigFor("absent"),
    claudeRunner: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "" })) as ClaudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(runAuthorizationFlow).toHaveBeenCalled();
  expect(out.text()).toContain("Step 1 of 3");
});

test("matrix: migrate (valid tokens + local-build registration) → re-register only, no OAuth", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  await seedTokens();
  script(stdin, [""]); // accept the migrate prompt with default Y

  const runAuthorizationFlow = vi.fn(async () => sampleTokens());
  const claudeRunner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {},
    claudeJsonPath: writeClaudeConfigFor("local-build"),
    claudeRunner: claudeRunner as ClaudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(runAuthorizationFlow).not.toHaveBeenCalled();
  expect(out.text()).toContain("local build");
  // Should have called claude mcp remove and add-json (plus possibly --version probe).
  const argLists = (claudeRunner.mock.calls as unknown as [string[]][])
    .map((c) => c[0])
    .map((a) => a.join(" "));
  expect(argLists.some((s) => s.startsWith("mcp remove bitbucket"))).toBe(true);
  expect(argLists.some((s) => s.startsWith("mcp add-json bitbucket"))).toBe(true);
});

test("matrix: already on npx → idempotent prompt, default declines", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  await seedTokens();
  script(stdin, [""]); // empty = accept default N (decline re-running OAuth)

  const runAuthorizationFlow = vi.fn(async () => sampleTokens());

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {},
    claudeJsonPath: writeClaudeConfigFor("on-npx"),
    claudeRunner: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) as ClaudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(runAuthorizationFlow).not.toHaveBeenCalled();
  expect(out.text()).toContain("already set up");
});

test("matrix: register-only (valid tokens + no registration) → register without OAuth", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  await seedTokens();
  script(stdin, [""]); // accept default Y

  const runAuthorizationFlow = vi.fn(async () => sampleTokens());
  const claudeRunner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {},
    claudeJsonPath: writeClaudeConfigFor("absent"),
    claudeRunner: claudeRunner as ClaudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow:
      runAuthorizationFlow as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(runAuthorizationFlow).not.toHaveBeenCalled();
  const argLists = (claudeRunner.mock.calls as unknown as [string[]][])
    .map((c) => c[0])
    .map((a) => a.join(" "));
  expect(argLists.some((s) => s.startsWith("mcp add-json bitbucket"))).toBe(true);
});

test("matrix: unknown shape → warn and replace with confirmation", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  await seedTokens();
  script(stdin, [""]); // accept default Y

  const claudeRunner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {},
    claudeJsonPath: writeClaudeConfigFor("unknown"),
    claudeRunner: claudeRunner as ClaudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow: vi.fn(async () =>
      sampleTokens(),
    ) as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(out.text()).toContain("doesn't match a known shape");
});

// ---------- Auto-register at exit ----------

test("auto-register: claude not on PATH prints manual JSON instead", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  script(stdin, ["", "k", "s"]);

  // Simulate claude not on PATH: --version throws ENOENT.
  const claudeRunner: ClaudeRunner = vi.fn(async (args) => {
    if (args.includes("--version")) {
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {},
    claudeJsonPath: "/nonexistent",
    claudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow: vi.fn(async () =>
      sampleTokens(),
    ) as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  // Should print the manual JSON payload, not call claude mcp add-json.
  expect(out.text()).toContain('"command": "npx"');
  expect(out.text()).toContain('"@bb-mcp/server"');
  // Confirm we did NOT call mcp add-json.
  const argLists = (claudeRunner as unknown as { mock: { calls: [string[]][] } }).mock.calls
    .map((c) => c[0])
    .map((a) => a.join(" "));
  expect(argLists.some((s) => s.startsWith("mcp add-json"))).toBe(false);
});

test("auto-register: claude found + TTY accept calls registerBitbucketServer", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // Wizard prompts: Step 1 enter (""), key, secret, then auto-register prompt ("").
  script(stdin, ["", "k", "s", ""]);

  const claudeRunner: ClaudeRunner = vi.fn(async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }));

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {},
    claudeJsonPath: "/nonexistent",
    claudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow: vi.fn(async () =>
      sampleTokens(),
    ) as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  const argLists = (claudeRunner as unknown as { mock: { calls: [string[]][] } }).mock.calls
    .map((c) => c[0])
    .map((a) => a.join(" "));
  expect(argLists.some((s) => s.startsWith("mcp add-json bitbucket"))).toBe(true);
});

test("auto-register: claude found + TTY decline prints manual command", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  script(stdin, ["", "k", "s", "n"]);

  const claudeRunner: ClaudeRunner = vi.fn(async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }));

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {},
    claudeJsonPath: "/nonexistent",
    claudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow: vi.fn(async () =>
      sampleTokens(),
    ) as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  const argLists = (claudeRunner as unknown as { mock: { calls: [string[]][] } }).mock.calls
    .map((c) => c[0])
    .map((a) => a.join(" "));
  expect(argLists.some((s) => s.startsWith("mcp add-json"))).toBe(false);
  expect(out.text()).toContain("@bb-mcp/server");
});

test("auto-register: non-TTY skips prompt, prints manual command", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);

  // Non-TTY (no isTTY override) — wizard sees TTY=false.
  script(stdin, ["", "k", "s"]);

  const claudeRunner: ClaudeRunner = vi.fn(async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }));

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {},
    claudeJsonPath: "/nonexistent",
    claudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow: vi.fn(async () =>
      sampleTokens(),
    ) as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  const argLists = (claudeRunner as unknown as { mock: { calls: [string[]][] } }).mock.calls
    .map((c) => c[0])
    .map((a) => a.join(" "));
  expect(argLists.some((s) => s.startsWith("mcp add-json"))).toBe(false);
  expect(out.text()).toContain("@bb-mcp/server");
});

test("auto-register: registerBitbucketServer failing prints manual command, exits zero", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const errOut = collect(stderr);

  script(stdin, ["", "k", "s", ""]);

  const claudeRunner: ClaudeRunner = vi.fn(async (args) => {
    if (args.includes("--version")) return { exitCode: 0, stdout: "1\n", stderr: "" };
    if (args.includes("add-json")) {
      return { exitCode: 1, stdout: "", stderr: "duplicate name 'bitbucket'" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });

  await runSetup({
    stdin,
    stdout,
    stderr,
    env: {},
    claudeJsonPath: "/nonexistent",
    claudeRunner,
    openBrowser: vi.fn(async () => undefined),
    inferRepo: vi.fn(async () => null),
    runAuthorizationFlow: vi.fn(async () =>
      sampleTokens(),
    ) as unknown as typeof import("../auth/index.ts").runAuthorizationFlow,
  });

  expect(errOut.text()).toContain("duplicate name");
  expect(out.text()).toContain("@bb-mcp/server"); // manual fallback still printed
});
