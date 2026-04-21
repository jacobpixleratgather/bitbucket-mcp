import * as nodePath from "node:path";
import * as readline from "node:readline/promises";
import open from "open";
import {
  CALLBACK_PORT,
  runAuthorizationFlow as defaultRunAuthorizationFlow,
} from "../auth/index.ts";
import { configPath, writeConfig } from "../config/index.ts";
import { inferBitbucketRepo as defaultInferBitbucketRepo } from "../git/index.ts";
import type { RepoTarget } from "../types.ts";

export type SetupOptions = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  runAuthorizationFlow?: typeof defaultRunAuthorizationFlow;
  openBrowser?: (url: string) => Promise<unknown>;
  inferRepo?: () => Promise<RepoTarget | null>;
  binPath?: string;
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
    "    ✓ Repositories   → Read",
    "    ✓ Pull requests  → Read",
    "    ✓ Pull requests  → Write",
    "    ✓ Pipelines      → Read",
    "",
    "Click Save. Bitbucket will show you a Key and a Secret.",
    "",
    "When you can see them, come back here and press Enter. ⏎",
    "",
  ].join("\n");
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
  const binPath =
    opts.binPath ??
    (process.argv[1] !== undefined && process.argv[1].length > 0
      ? nodePath.resolve(process.argv[1])
      : "/absolute/path/to/dist/bitbucket-mcp.mjs");

  // terminal:false keeps readline in pure line-mode: no ANSI, no history, no
  // raw key processing. That matters when stdin/stdout aren't real TTYs (e.g.
  // tests pipe PassThroughs) and is harmless when they are.
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
  try {
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

    const grantedSet = new Set(tokens.scopes);
    const missing = REQUIRED_SCOPES.filter((s) => !grantedSet.has(s));
    const scopesText = tokens.scopes.length > 0 ? tokens.scopes.join(", ") : "(none reported)";
    stdout.write(
      `\n\u2705 Authentication complete. Scopes granted: ${scopesText}\n  Tokens saved to ${configPath()}.\n`,
    );
    if (missing.length > 0) {
      stdout.write(
        [
          "",
          `\u26a0 The consumer is missing scope${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
          "  Some tools will fail until you re-open the consumer in Bitbucket",
          "  and tick the missing permissions.",
          "",
        ].join("\n"),
      );
    }
    stdout.write(`\nNext: add this to your MCP host config:\n  { "command": "${binPath}" }\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`\nSetup failed: ${msg}\n`);
    throw err;
  } finally {
    rl.close();
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
