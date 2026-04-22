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
const NPX_PACKAGE = "@bb-mcp/server";

/**
 * Classifies the bitbucket entry in the user's Claude Code MCP config.
 * - `absent`        — no entry, or no mcpServers, or null config
 * - `on-npx`        — already invoking us via `npx ... @bb-mcp/server`
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
