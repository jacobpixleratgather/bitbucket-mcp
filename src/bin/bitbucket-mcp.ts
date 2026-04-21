#!/usr/bin/env node
import * as path from "node:path";
import * as url from "node:url";
import { runAuthorizationFlow as defaultRunAuthorizationFlow } from "../auth/index.ts";
import { configPath, readConfig, writeConfig } from "../config/index.ts";
import { runServer } from "../server/index.ts";
import { runSetup } from "../setup/index.ts";

const REQUIRED_SCOPES: readonly string[] = [
  "account",
  "repository",
  "pullrequest",
  "pullrequest:write",
  "pipeline",
];

async function main(argv: readonly string[]): Promise<void> {
  const [, , subcommand, ...rest] = argv;
  const binPath = resolveBinPath(argv);
  switch (subcommand) {
    case undefined:
    case "serve":
      await runServer();
      return;
    case "setup":
      await runSetup({ binPath });
      return;
    case "credentials":
      await handleCredentials({
        argv: rest,
        stdin: process.stdin,
        env: process.env,
      });
      return;
    case "authorize":
      await handleAuthorize({ stdout: process.stdout });
      return;
    case "print-config":
      await handlePrintConfig({
        argv: rest,
        binPath: binPath ?? "/absolute/path/to/dist/bitbucket-mcp.mjs",
        stdout: process.stdout,
      });
      return;
    case "-h":
    case "--help":
    case "help":
      printUsage(process.stdout);
      return;
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n`);
      printUsage(process.stderr);
      process.exit(2);
  }
}

function resolveBinPath(argv: readonly string[]): string | undefined {
  const argv1 = argv[1];
  return argv1 !== undefined && argv1.length > 0 ? path.resolve(argv1) : undefined;
}

function printUsage(out: NodeJS.WritableStream): void {
  out.write(
    [
      "Usage: bitbucket-mcp [command]",
      "",
      "Commands:",
      "  (default)       Run the MCP server over stdio (use this in your MCP host config)",
      "  serve           Same as default",
      "  setup           Interactive OAuth setup wizard (paste key/secret, authorize)",
      "  credentials     Store an OAuth consumer key + secret. Reads key from --key,",
      "                  secret from stdin (or $BITBUCKET_CLIENT_SECRET). Non-interactive.",
      "  authorize       Run the OAuth authorization flow using stored credentials.",
      "                  Opens the browser, waits for callback, persists tokens.",
      "  print-config    Print MCP registration data.",
      "                    --mcp-add-json  JSON suitable for `claude mcp add-json`",
      "                    --raw           Absolute bin path on one line",
      "  help            Show this message",
      "",
      "Claude Code users: run /setup from inside this repo to automate the full flow.",
      "",
    ].join("\n"),
  );
}

// -----------------------------------------------------------------------------
// Non-interactive subcommand handlers. Exported for unit tests.
// -----------------------------------------------------------------------------

export async function handleCredentials(opts: {
  argv: readonly string[];
  stdin: NodeJS.ReadableStream;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const key = extractFlag(opts.argv, "--key");
  if (key === null || key.length === 0) {
    throw new Error("`credentials` requires --key <KEY>");
  }

  const envSecret = opts.env["BITBUCKET_CLIENT_SECRET"];
  const secret =
    envSecret !== undefined && envSecret.length > 0 ? envSecret : await readAllStdin(opts.stdin);

  if (secret.length === 0) {
    throw new Error(
      "`credentials` requires a secret. Pipe it to stdin or set $BITBUCKET_CLIENT_SECRET.",
    );
  }

  await writeConfig({ clientKey: key, clientSecret: secret });
}

export async function handleAuthorize(opts: {
  stdout: NodeJS.WritableStream;
  runAuthorizationFlow?: typeof defaultRunAuthorizationFlow;
}): Promise<void> {
  const runAuth = opts.runAuthorizationFlow ?? defaultRunAuthorizationFlow;
  const cfg = await readConfig();
  if (
    cfg.clientKey === undefined ||
    cfg.clientKey.length === 0 ||
    cfg.clientSecret === undefined ||
    cfg.clientSecret.length === 0
  ) {
    throw new Error(
      "Missing OAuth credentials. Run `bitbucket-mcp credentials --key <KEY>` first.",
    );
  }

  const tokens = await runAuth({
    clientKey: cfg.clientKey,
    clientSecret: cfg.clientSecret,
  });

  const grantedSet = new Set(tokens.scopes);
  const missing = REQUIRED_SCOPES.filter((s) => !grantedSet.has(s));
  const scopesText = tokens.scopes.length > 0 ? tokens.scopes.join(", ") : "(none reported)";
  opts.stdout.write(
    `Authentication complete. Scopes granted: ${scopesText}\nTokens saved to ${configPath()}.\n`,
  );
  if (missing.length > 0) {
    opts.stdout.write(
      `WARNING: consumer is missing scope${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}\nSome tools will fail until you re-open the consumer in Bitbucket and tick the missing permissions.\n`,
    );
  }
}

export async function handlePrintConfig(opts: {
  argv: readonly string[];
  binPath: string;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const mode = opts.argv.includes("--raw")
    ? "raw"
    : opts.argv.includes("--mcp-add-json")
      ? "mcp-add-json"
      : null;
  if (mode === null) {
    throw new Error("`print-config` requires one of --mcp-add-json or --raw");
  }
  if (mode === "raw") {
    opts.stdout.write(`${opts.binPath}\n`);
    return;
  }
  const payload = {
    type: "stdio",
    command: opts.binPath,
    args: [],
    env: {},
  };
  opts.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// -----------------------------------------------------------------------------
// Small argv / stdin helpers.
// -----------------------------------------------------------------------------

function extractFlag(argv: readonly string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === name) {
      const next = argv[i + 1];
      return next ?? null;
    }
    if (current !== undefined && current.startsWith(`${name}=`)) {
      return current.slice(name.length + 1);
    }
  }
  return null;
}

async function readAllStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  // If stdin is a TTY with no piped input, resolve empty immediately so the
  // caller can report a helpful error rather than hanging forever.
  const maybeTty = stdin as { isTTY?: boolean };
  if (maybeTty.isTTY === true) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

// -----------------------------------------------------------------------------
// Entrypoint. Only runs when this file is invoked directly as a bin script.
// Importing this module (e.g. from tests) does not execute main().
// -----------------------------------------------------------------------------

function isEntrypoint(): boolean {
  const invokedFile = process.argv[1];
  if (invokedFile === undefined || invokedFile.length === 0) {
    return false;
  }
  try {
    const selfPath = url.fileURLToPath(import.meta.url);
    return path.resolve(selfPath) === path.resolve(invokedFile);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
