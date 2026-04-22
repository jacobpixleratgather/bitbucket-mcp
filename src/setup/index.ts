import * as fs from "node:fs";
import * as readline from "node:readline/promises";
import open from "open";
import {
  CALLBACK_PORT,
  runAuthorizationFlow as defaultRunAuthorizationFlow,
} from "../auth/index.ts";
import {
  classifyBitbucketRegistration,
  defaultClaudeJsonPath,
  defaultClaudeRunner,
  findClaudeBinary,
  registerBitbucketServer,
  removeBitbucketServer,
  type ClaudeConfig,
  type ClaudeRunner,
  type RegistrationStatus,
} from "../claude-cli/index.ts";
import { configPath, writeConfig } from "../config/index.ts";
import { inferBitbucketRepo as defaultInferBitbucketRepo } from "../git/index.ts";
import type { RepoTarget, StoredTokens } from "../types.ts";

export type SetupOptions = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  runAuthorizationFlow?: typeof defaultRunAuthorizationFlow;
  openBrowser?: (url: string) => Promise<unknown>;
  inferRepo?: () => Promise<RepoTarget | null>;
  claudeJsonPath?: string;
  claudeRunner?: ClaudeRunner;
};

const GENERIC_WORKSPACES_URL = "https://bitbucket.org/account/workspaces/";

const REQUIRED_SCOPES: readonly string[] = [
  "account",
  "repository",
  "pullrequest",
  "pullrequest:write",
  "pipeline",
];

function consumerUrlFor(workspace: string): string {
  return `https://bitbucket.org/${workspace}/workspace/settings/oauth-consumers`;
}

function step1Instructions(consumerUrl: string, includePickWorkspaceHint: boolean): string {
  const pickHint = includePickWorkspaceHint
    ? "Pick the workspace you want to use, then go to Workspace Settings → OAuth consumers.\n\n"
    : "";
  return [
    "Step 1 of 3 — Create an OAuth consumer",
    "──────────────────────────────────────",
    "Opening your browser to:",
    `  ${consumerUrl}`,
    "(If it doesn't open, paste that URL into your browser.)",
    "",
    pickHint,
    'Click "Add consumer" and fill in this form exactly:',
    "",
    "  Name:                          bitbucket-mcp",
    `  Callback URL:                  http://127.0.0.1:${CALLBACK_PORT}/callback`,
    "  ✓ This is a private consumer",
    "",
    "  Permissions (tick these five):",
    "    ✓ Account        → Read",
    "    ✓ Pull requests  → Write",
    "    ✓ Pipelines      → Read",
    "    ✓ Repositories   → Read (should be set because of Pull request: Write access)",
    "    ✓ Repositories   → Write (should be set because of Pull request: Write access)",
    "    ✓ Pull requests  → Read (should be set because of Pull request: Write access)",
    "",
    "Click Save. Bitbucket will show you a Key and a Secret.",
    "",
    "When you can see them, come back here and press Enter. ⏎",
    "",
  ].join("\n");
}

const NPX_PAYLOAD_TEXT = JSON.stringify(
  { type: "stdio", command: "npx", args: ["-y", "@bb-mcp/server"], env: {} },
  null,
  2,
);

function printManualRegistration(stdout: NodeJS.WritableStream): void {
  stdout.write(
    [
      "",
      "Add this to your MCP host config (e.g. via `claude mcp add-json bitbucket --scope user`):",
      NPX_PAYLOAD_TEXT,
      "",
    ].join("\n"),
  );
}

function printAuthSuccess(p: { stdout: NodeJS.WritableStream; tokens: StoredTokens }): void {
  const grantedSet = new Set(p.tokens.scopes);
  const missing = REQUIRED_SCOPES.filter((s) => !grantedSet.has(s));
  const scopesText = p.tokens.scopes.length > 0 ? p.tokens.scopes.join(", ") : "(none reported)";
  p.stdout.write(
    `\n✅ Authentication complete. Scopes granted: ${scopesText}\n  Tokens saved to ${configPath()}.\n`,
  );
  if (missing.length > 0) {
    p.stdout.write(
      [
        "",
        `⚠ The consumer is missing scope${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
        "  Some tools will fail until you re-open the consumer in Bitbucket",
        "  and tick the missing permissions.",
        "",
      ].join("\n"),
    );
  }
}

/**
 * Runs the interactive first-run setup wizard.
 *
 * Throws on any failure — callers (e.g. bin entrypoint) are responsible for
 * mapping thrown errors into a non-zero exit code.
 */
export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const runAuthorizationFlow = opts.runAuthorizationFlow ?? defaultRunAuthorizationFlow;
  const openBrowser = opts.openBrowser ?? ((url: string) => open(url));
  const inferRepo = opts.inferRepo ?? (() => defaultInferBitbucketRepo());

  const env = opts.env ?? process.env;
  const claudeJsonPath = opts.claudeJsonPath ?? defaultClaudeJsonPath();
  const claudeRunner = opts.claudeRunner ?? defaultClaudeRunner;

  // Detect team-shared mode: both env vars present and non-empty.
  const envKey = env["BITBUCKET_CLIENT_KEY"];
  const envSecret = env["BITBUCKET_CLIENT_SECRET"];
  const envCredsAvailable =
    envKey !== undefined && envKey.length > 0 && envSecret !== undefined && envSecret.length > 0;

  // --------- State detection (sync reads, before readline!) ---------
  // IMPORTANT: readline fires "line" events immediately when stdin has buffered
  // data. If a "line" event fires while no rl.question() is pending, the line
  // is lost. Test harnesses feed input via setImmediate chains; each `await`
  // here lets a setImmediate callback fire, feeding a line before readline is
  // even created. Using synchronous reads avoids any event-loop yield, so
  // setImmediate callbacks haven't fired when readline is subsequently created,
  // and all test input lines are safely waiting in the PassThrough buffer.
  const hasValidTokens = readHasValidTokensSync();
  const claudeConfig = readClaudeConfigSync(claudeJsonPath);
  const status: RegistrationStatus = classifyBitbucketRegistration(claudeConfig);
  const stdinIsTty = (stdin as { isTTY?: boolean }).isTTY === true;

  // terminal:false keeps readline in pure line-mode: no ANSI, no history, no
  // raw key processing. That matters when stdin/stdout aren't real TTYs (e.g.
  // tests pipe PassThroughs) and is harmless when they are.
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
  try {
    // --------- Env-var fast-path (team-shared mode) ---------
    let envCredsAccepted = false;
    if (envCredsAvailable) {
      if (stdinIsTty) {
        stdout.write(
          [
            "bitbucket-mcp setup",
            "───────────────────",
            "Detected BITBUCKET_CLIENT_KEY and BITBUCKET_CLIENT_SECRET in your",
            "environment. Use them and skip the create-consumer step? [Y/n] ",
          ].join("\n"),
        );
        const answer = (await rl.question("")).trim().toLowerCase();
        envCredsAccepted = answer === "" || answer === "y" || answer === "yes";
      } else {
        envCredsAccepted = true; // non-TTY: scripted run, use silently
      }

      if (envCredsAccepted) {
        // Close the wizard's readline before any async I/O so that if the test
        // harness feeds a line via setImmediate, it lands in stdin's buffer
        // (stdin is paused when rl is closed) rather than being silently
        // consumed by readline with no pending question.
        rl.close();
        await writeConfig({ clientKey: envKey!, clientSecret: envSecret! });
        stdout.write(
          [
            "",
            "Step 1 of 1 — Authorize",
            "───────────────────────",
            "Opening your browser to authorize…",
            "",
          ].join("\n"),
        );
        const tokens = await runAuthorizationFlow({
          clientKey: envKey!,
          clientSecret: envSecret!,
        });
        printAuthSuccess({ stdout, tokens });
        await attemptAutoRegister({ stdin, stdout, stderr, claudeRunner });
        return; // skip the full 3-step wizard entirely
      }
    }

    // Decision matrix — early exits for non-fresh-install flows.
    if (hasValidTokens && status.kind === "local-build") {
      stdout.write(
        [
          "bitbucket-mcp setup",
          "───────────────────",
          "Looks like you've set up bitbucket-mcp before from a local build.",
          `  Existing registration: ${status.command}`,
          "Re-register to use the new npx-based install (no re-auth needed)? [Y/n] ",
        ].join("\n"),
      );
      const answer = stdinIsTty ? (await rl.question("")).trim().toLowerCase() : "y";
      if (answer === "" || answer === "y" || answer === "yes") {
        await reregisterOnly({ stdout, stderr, claudeRunner });
      }
      return;
    }

    if (hasValidTokens && status.kind === "on-npx") {
      stdout.write(
        [
          "bitbucket-mcp setup",
          "───────────────────",
          "You're already set up. Re-run OAuth (e.g. to add a new scope)? [y/N] ",
        ].join("\n"),
      );
      const answer = stdinIsTty ? (await rl.question("")).trim().toLowerCase() : "n";
      if (!(answer === "y" || answer === "yes")) {
        return;
      }
      // Fall through to full wizard if user accepted re-auth.
    }

    if (hasValidTokens && status.kind === "absent") {
      stdout.write(
        [
          "bitbucket-mcp setup",
          "───────────────────",
          "Tokens are saved but bitbucket isn't registered with Claude Code.",
          "Register it now? [Y/n] ",
        ].join("\n"),
      );
      const answer = stdinIsTty ? (await rl.question("")).trim().toLowerCase() : "y";
      if (answer === "" || answer === "y" || answer === "yes") {
        await reregisterOnly({ stdout, stderr, claudeRunner });
      }
      return;
    }

    if (hasValidTokens && status.kind === "unknown-shape") {
      stdout.write(
        [
          "bitbucket-mcp setup",
          "───────────────────",
          `An existing 'bitbucket' MCP server is registered but doesn't match a known shape`,
          `(command: ${status.command}). Replace it with the npx install? [Y/n] `,
        ].join("\n"),
      );
      const answer = stdinIsTty ? (await rl.question("")).trim().toLowerCase() : "y";
      if (answer === "" || answer === "y" || answer === "yes") {
        await reregisterOnly({ stdout, stderr, claudeRunner });
      }
      return;
    }

    // Otherwise: fresh install — fall through to the existing 3-step wizard.

    stdout.write(
      [
        "bitbucket-mcp setup",
        "───────────────────",
        "Three steps, ~2 minutes: (1) create an OAuth consumer in Bitbucket,",
        "(2) paste its key and secret here, (3) authorize in your browser.",
        "",
        "",
      ].join("\n"),
    );

    // ------ Step 1 ------
    const repo = await inferRepo();
    const consumerUrl = repo === null ? GENERIC_WORKSPACES_URL : consumerUrlFor(repo.workspace);
    stdout.write(step1Instructions(consumerUrl, repo === null));
    try {
      await openBrowser(consumerUrl);
    } catch {
      // Non-fatal — the URL is already printed as a fallback.
    }
    await rl.question("");

    // ------ Step 2 ------
    stdout.write(
      ["", "Step 2 of 3 — Paste the credentials", "───────────────────────────────────", ""].join(
        "\n",
      ),
    );
    const clientKey = await promptNonEmpty(rl, "Key:    ");
    const clientSecret = await promptMaskedNonEmpty({
      rl,
      stdin,
      stdout,
      prompt: "Secret: ",
    });

    // Close the wizard's readline before any async I/O so that test-harness
    // input fed via setImmediate lands in stdin's buffer (stdin is paused when
    // rl is closed) rather than being silently consumed with no pending
    // question. attemptAutoRegister creates its own fresh readline.
    rl.close();

    await writeConfig({ clientKey, clientSecret });

    // ------ Step 3 ------
    stdout.write(
      [
        "",
        "Step 3 of 3 — Authorize",
        "───────────────────────",
        "Opening your browser to authorize…",
        "",
      ].join("\n"),
    );
    const tokens = await runAuthorizationFlow({ clientKey, clientSecret });
    printAuthSuccess({ stdout, tokens });
    await attemptAutoRegister({ stdin, stdout, stderr, claudeRunner });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`\nSetup failed: ${msg}\n`);
    throw err;
  } finally {
    rl.close();
  }
}

/**
 * Synchronously reads the bitbucket-mcp config and returns true if valid
 * tokens (non-empty refreshToken) are present. Returns false if the file
 * doesn't exist or tokens are absent.
 *
 * DO NOT REPLACE with the async `readConfig` from ../config/index.ts:
 * doing so introduces an `await` in the state-detection phase, which lets
 * setImmediate-fed test input lines fire as readline `line` events before
 * any `rl.question()` is pending — and those lines are dropped. See the
 * "State detection" comment inside runSetup for the full explanation.
 */
function readHasValidTokensSync(): boolean {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tokens = parsed["tokens"] as Record<string, unknown> | undefined;
    const refreshToken = tokens?.["refreshToken"];
    return typeof refreshToken === "string" && refreshToken.length > 0;
  } catch {
    return false;
  }
}

/**
 * Synchronously reads the Claude Code config at the given path and returns
 * the parsed object, or null if the file doesn't exist or cannot be parsed.
 *
 * DO NOT REPLACE with the async `readClaudeConfig` from ../claude-cli/index.ts:
 * see the "DO NOT REPLACE" note on `readHasValidTokensSync` above and the
 * "State detection" comment inside runSetup.
 */
function readClaudeConfigSync(filePath: string): ClaudeConfig | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as ClaudeConfig;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    // Parse errors fall through to returning null (same as async version's .catch)
    return null;
  }
}

/**
 * Detect claude on PATH, prompt the user (if TTY), then run
 * `claude mcp add-json` for the bitbucket server. Falls back to printing the
 * manual JSON payload on every failure mode (claude not found, user declines,
 * non-TTY, claude exits non-zero). Never throws — the caller's OAuth tokens
 * are already on disk; we don't want a registration hiccup to abort.
 *
 * IMPORTANT: The caller must close its own readline interface BEFORE calling
 * this function. This function creates a fresh readline interface so that any
 * stdin data written by the test harness during the preceding async I/O (e.g.
 * writeConfig) lands in the PassThrough buffer rather than being consumed by
 * the caller's readline — those bytes are then picked up by our fresh reader.
 */
async function attemptAutoRegister(p: {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  claudeRunner: ClaudeRunner;
}): Promise<void> {
  const present = await findClaudeBinary({ run: p.claudeRunner });
  if (!present) {
    printManualRegistration(p.stdout);
    return;
  }
  const stdinIsTty = (p.stdin as { isTTY?: boolean }).isTTY === true;
  if (!stdinIsTty) {
    printManualRegistration(p.stdout);
    return;
  }
  p.stdout.write(`\nRegister with Claude Code as 'bitbucket' MCP server (user scope)? [Y/n] `);
  const rl = readline.createInterface({ input: p.stdin, output: p.stdout, terminal: false });
  let answer: string;
  try {
    answer = (await rl.question("")).trim().toLowerCase();
  } finally {
    rl.close();
  }
  if (!(answer === "" || answer === "y" || answer === "yes")) {
    printManualRegistration(p.stdout);
    return;
  }
  try {
    await registerBitbucketServer({ run: p.claudeRunner });
    p.stdout.write("\n✅ Registered bitbucket MCP server with Claude Code.\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.stderr.write(`\nFailed to register: ${msg}\n`);
    printManualRegistration(p.stdout);
  }
}

/**
 * Removes any existing 'bitbucket' MCP server registration and registers the
 * npx-based one. Used for the migrate / register-only / unknown-shape flows.
 *
 * Spec deviation: the design doc's "Error handling" section says
 * `claude mcp remove fails when migrating — abort the migration with the
 * error`. This implementation instead catches errors from BOTH remove and
 * add, then prints the manual command. Rationale: the user's OAuth tokens
 * are intact, so a working manual command is friendlier than an abort.
 * The plan (Task 6, "Note on a deliberate spec deviation") pre-authorizes
 * this choice.
 */
async function reregisterOnly(p: {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  claudeRunner: ClaudeRunner;
}): Promise<void> {
  const present = await findClaudeBinary({ run: p.claudeRunner });
  if (!present) {
    printManualRegistration(p.stdout);
    return;
  }
  try {
    await removeBitbucketServer({ run: p.claudeRunner });
    await registerBitbucketServer({ run: p.claudeRunner });
    p.stdout.write("\n✅ Re-registered bitbucket MCP server with the npx install.\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.stderr.write(`\nFailed to register: ${msg}\n`);
    printManualRegistration(p.stdout);
  }
}

async function promptMaskedNonEmpty(p: {
  rl: readline.Interface;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  prompt: string;
}): Promise<string> {
  while (true) {
    const answer = await promptMaskedInput(p);
    if (answer.length > 0) return answer;
  }
}

/**
 * Reads a line of input without echoing it to stdout. On a TTY, sets raw mode
 * and consumes bytes until CR/LF. On a non-TTY (tests, pipes), falls back to
 * readline without masking but — crucially — still does not write the value
 * back to stdout, so the value does not appear in captured output.
 */
export async function promptMaskedInput(p: {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  prompt: string;
  rl?: readline.Interface;
}): Promise<string> {
  p.stdout.write(p.prompt);

  const maybeTty = p.stdin as NodeJS.ReadStream;
  if (maybeTty.isTTY === true && typeof maybeTty.setRawMode === "function") {
    return await readRawMasked(maybeTty, p.stdout);
  }

  if (p.rl !== undefined) {
    const answer = await p.rl.question("");
    p.stdout.write("\n");
    return answer.trim();
  }

  const rl = readline.createInterface({ input: p.stdin, output: p.stdout, terminal: false });
  try {
    const answer = await rl.question("");
    p.stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function readRawMasked(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const prevRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const buf: number[] = [];
    const cleanup = (): void => {
      stdin.setRawMode(prevRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          cleanup();
          stdout.write("\n");
          reject(new Error("Input cancelled"));
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          cleanup();
          stdout.write("\n");
          resolve(Buffer.from(buf).toString("utf8").trim());
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          buf.pop();
          continue;
        }
        buf.push(byte);
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}

async function promptNonEmpty(rl: readline.Interface, prompt: string): Promise<string> {
  // Keep prompting until we get non-empty input.
  while (true) {
    const answer = (await rl.question(prompt)).trim();
    if (answer.length > 0) {
      return answer;
    }
    // Empty input — write directly to the readline's output stream so the
    // re-prompt appears in the expected order.
  }
}
