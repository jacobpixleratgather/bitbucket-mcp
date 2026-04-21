import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RepoTarget } from "../types.ts";

/**
 * Parses a git remote URL and returns the Bitbucket workspace/repo if it is
 * a Bitbucket Cloud URL. Returns null for non-bitbucket.org hosts or malformed
 * URLs.
 *
 * Supported forms:
 *   https://bitbucket.org/workspace/repo(.git)?
 *   https://user@bitbucket.org/workspace/repo(.git)?
 *   ssh://git@bitbucket.org/workspace/repo(.git)?
 *   git@bitbucket.org:workspace/repo(.git)?
 */
export function parseBitbucketRemote(url: string): RepoTarget | null {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // scp-like SSH form: git@bitbucket.org:workspace/repo.git
  // Note: this form has no `//` after the colon.
  const scpMatch = /^([^\s@]+)@([^\s:]+):(.+)$/.exec(trimmed);
  if (scpMatch && !trimmed.includes("://")) {
    const host = scpMatch[2];
    const p = scpMatch[3];
    if (host === undefined || p === undefined) {
      return null;
    }
    return buildTargetFromHostAndPath(host, p);
  }

  // URL form (https:// or ssh://). Use WHATWG URL parser.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = parsed.protocol;
  if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") {
    return null;
  }

  // URL parser already strips userinfo from `host`.
  return buildTargetFromHostAndPath(parsed.hostname, parsed.pathname);
}

function buildTargetFromHostAndPath(host: string, rawPath: string): RepoTarget | null {
  if (host.toLowerCase() !== "bitbucket.org") {
    return null;
  }
  // Strip leading slashes and a trailing .git suffix, plus any trailing slash.
  let p = rawPath.replace(/^\/+/, "");
  p = p.replace(/\/+$/, "");
  if (p.endsWith(".git")) {
    p = p.slice(0, -".git".length);
  }
  if (p.length === 0) {
    return null;
  }
  const parts = p.split("/");
  if (parts.length !== 2) {
    return null;
  }
  const [workspace, repo] = parts;
  if (
    workspace === undefined ||
    repo === undefined ||
    workspace.length === 0 ||
    repo.length === 0
  ) {
    return null;
  }
  return { workspace, repo };
}

/**
 * Walks upward from `cwd` (defaulting to process.cwd()) looking for a `.git`
 * directory or file. Reads the resulting git dir's `config` and extracts the
 * `origin` remote URL. Returns the parsed RepoTarget, or null if the repo is
 * not a Bitbucket Cloud remote (or no .git is present).
 */
export async function inferBitbucketRepo(cwd?: string): Promise<RepoTarget | null> {
  const start = cwd ?? process.cwd();
  const gitDir = await findGitDir(start);
  if (gitDir === null) {
    return null;
  }
  const configFile = path.join(gitDir, "config");
  let text: string;
  try {
    text = await fs.readFile(configFile, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const url = extractOriginUrl(text);
  if (url === null) {
    return null;
  }
  return parseBitbucketRemote(url);
}

async function findGitDir(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  // Guard against infinite loops on exotic filesystems.
  for (let i = 0; i < 256; i++) {
    const candidate = path.join(dir, ".git");
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(candidate);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        const parent = path.dirname(dir);
        if (parent === dir) {
          return null;
        }
        dir = parent;
        continue;
      }
      throw err;
    }
    if (stat.isDirectory()) {
      return candidate;
    }
    if (stat.isFile()) {
      // Git worktree / submodule pointer file: "gitdir: <path>"
      const content = await fs.readFile(candidate, "utf8");
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
      if (m === null || m[1] === undefined) {
        return null;
      }
      const pointed = m[1];
      return path.isAbsolute(pointed) ? pointed : path.resolve(dir, pointed);
    }
    return null;
  }
  return null;
}

/**
 * Extracts the `url` line from the `[remote "origin"]` block of a git config
 * file. Returns null if no such block or url is found.
 */
function extractOriginUrl(configText: string): string | null {
  const lines = configText.split(/\r?\n/);
  let inOrigin = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch !== null && sectionMatch[1] !== undefined) {
      const header = sectionMatch[1].trim();
      // Accept: [remote "origin"]  or  [remote.origin] or variations.
      inOrigin = /^remote\s+"origin"$/.test(header);
      continue;
    }
    if (!inOrigin) {
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv !== null && kv[1] === "url" && kv[2] !== undefined) {
      return kv[2].trim();
    }
  }
  return null;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
