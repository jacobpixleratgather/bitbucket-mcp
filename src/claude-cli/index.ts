import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Subset of Claude Code's ~/.claude.json that we care about. We deliberately
 * keep the shape loose (no zod) — Claude Code may add fields over time and we
 * want to read past them without crashing.
 */
export type ClaudeConfig = {
  mcpServers?: Record<string, ClaudeMcpServer>;
};

export type ClaudeMcpServer = {
  type?: string;
  command?: string;
  args?: readonly string[];
  env?: Record<string, string>;
  url?: string;
};

export type RegistrationStatus =
  | { kind: "absent" }
  | { kind: "on-npx" }
  | { kind: "local-build"; command: string }
  | { kind: "unknown-shape"; command: string };

/** Default location of Claude Code's user-scope config. */
export function defaultClaudeJsonPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

/**
 * Reads `~/.claude.json` (or the path provided). Returns null if the file does
 * not exist. Throws if the file exists but cannot be parsed as JSON; the error
 * message includes the file path so the user knows where to look.
 *
 * Note: we intentionally do NOT shell out to `claude mcp list`, because that
 * command spawns every stdio MCP server in the user's config to do health
 * checks (per its own help text). Reading the file directly avoids the side
 * effect of launching the very server we may be about to (re-)register.
 */
export async function readClaudeConfig(filePath: string): Promise<ClaudeConfig | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as ClaudeConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`bitbucket-mcp: failed to parse ${filePath}: ${msg}`);
  }
}

const BITBUCKET_KEY = "bitbucket";
const NPX_PACKAGE = "@mcpkit/bitbucket";

/**
 * Classifies the bitbucket entry in the user's Claude Code MCP config.
 * - `absent`        — no entry, or no mcpServers, or null config
 * - `on-npx`        — already invoking us via `npx ... @mcpkit/bitbucket`
 * - `local-build`   — invoking an absolute path ending in `bitbucket-mcp.mjs` (the old install)
 * - `unknown-shape` — entry exists but doesn't match either expected shape
 */
export function classifyBitbucketRegistration(cfg: ClaudeConfig | null): RegistrationStatus {
  const entry = cfg?.mcpServers?.[BITBUCKET_KEY];
  if (entry === undefined) {
    return { kind: "absent" };
  }
  const cmd = entry.command;
  const args = entry.args ?? [];
  if (cmd === undefined) {
    return { kind: "unknown-shape", command: "" };
  }
  if (cmd === "npx" && args.includes(NPX_PACKAGE)) {
    return { kind: "on-npx" };
  }
  if (path.isAbsolute(cmd) && cmd.endsWith("bitbucket-mcp.mjs")) {
    return { kind: "local-build", command: cmd };
  }
  return { kind: "unknown-shape", command: cmd };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Abstraction over `spawn('claude', args)`. Tests inject a fake; the real
 * runner uses node:child_process. All callers go through this so behavior is
 * easy to verify without actually launching processes.
 */
export type ClaudeRunner = (args: readonly string[]) => Promise<ClaudeResult>;

export type ClaudeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Spawns `claude` with the given args and collects its output. */
export const defaultClaudeRunner: ClaudeRunner = async (args) => {
  return await new Promise<ClaudeResult>((resolve, reject) => {
    const child = spawn("claude", [...args], { shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
};

/**
 * Returns true if `claude --version` exits 0. Returns false on ENOENT (binary
 * not on PATH) or any non-zero exit. Never throws.
 */
export async function findClaudeBinary(opts: { run: ClaudeRunner }): Promise<boolean> {
  try {
    const result = await opts.run(["--version"]);
    return result.exitCode === 0;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return false;
    }
    return false;
  }
}

/**
 * Runs `claude mcp add-json bitbucket <payload> --scope user` with the
 * hardcoded npx invocation payload. Throws (with stderr in the message) if
 * claude exits non-zero — caller is responsible for printing the manual
 * fallback command.
 */
export async function registerBitbucketServer(opts: { run: ClaudeRunner }): Promise<void> {
  const payload = JSON.stringify({
    type: "stdio",
    command: "npx",
    // Must match classifyBitbucketRegistration's NPX_PACKAGE check exactly —
    // do NOT pin a version, or `setup` will re-migrate every run.
    args: ["-y", NPX_PACKAGE],
    env: {},
  });
  const result = await opts.run(["mcp", "add-json", "bitbucket", payload, "--scope", "user"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `claude mcp add-json failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}

/**
 * Runs `claude mcp remove bitbucket --scope user`. Treats "not found" as
 * success so callers can call remove-then-add unconditionally during a
 * migration. Other non-zero exits throw.
 */
export async function removeBitbucketServer(opts: { run: ClaudeRunner }): Promise<void> {
  const result = await opts.run(["mcp", "remove", "bitbucket", "--scope", "user"]);
  if (result.exitCode === 0) return;
  if (/not found/i.test(result.stderr)) return;
  throw new Error(`claude mcp remove failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
}
