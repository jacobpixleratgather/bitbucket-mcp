#!/usr/bin/env node
import * as fs from "node:fs";
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
  switch (subcommand) {
    case undefined:
    case "serve":
      await runServer();
      return;
    case "setup":
      await runSetup();
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
      "  print-config    Print the JSON payload for `claude mcp add-json bitbucket`",
      "                  (also accepts the legacy --mcp-add-json flag).",
      "  help            Show this message",
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
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  if (opts.argv.includes("--raw")) {
    throw new Error(
      "`print-config --raw` is no longer supported. The package is now distributed via npm; " +
        "use `print-config` (or `--mcp-add-json`) to get the JSON payload for `claude mcp add-json`.",
    );
  }
  // Both bare `print-config` and `--mcp-add-json` emit the same payload.
  const payload = {
    type: "stdio",
    command: "npx",
    args: ["-y", "@mcpkit/bitbucket"],
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
    return fs.realpathSync(selfPath) === fs.realpathSync(invokedFile);
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
