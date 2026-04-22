import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { classifyBitbucketRegistration, readClaudeConfig, type ClaudeConfig } from "./index.ts";
import {
  type ClaudeRunner,
  findClaudeBinary,
  registerBitbucketServer,
  removeBitbucketServer,
} from "./index.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bbmcp-claude-cli-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeClaudeJson(contents: unknown): string {
  const p = path.join(tmpDir, ".claude.json");
  fs.writeFileSync(p, typeof contents === "string" ? contents : JSON.stringify(contents));
  return p;
}

// --------- readClaudeConfig ---------

test("readClaudeConfig returns null when the file does not exist", async () => {
  const result = await readClaudeConfig(path.join(tmpDir, "nope.json"));
  expect(result).toBeNull();
});

test("readClaudeConfig parses a valid file with mcpServers", async () => {
  const p = writeClaudeJson({
    mcpServers: {
      bitbucket: { type: "stdio", command: "/abs/path/dist/bitbucket-mcp.mjs", args: [] },
    },
  });
  const result = await readClaudeConfig(p);
  expect(result?.mcpServers?.["bitbucket"]).toBeDefined();
});

test("readClaudeConfig returns a ClaudeConfig with no mcpServers when key absent", async () => {
  const p = writeClaudeJson({ unrelated: 42 });
  const result = await readClaudeConfig(p);
  expect(result).not.toBeNull();
  expect(result?.mcpServers).toBeUndefined();
});

test("readClaudeConfig throws on invalid JSON", async () => {
  const p = writeClaudeJson("{ this is not json");
  await expect(readClaudeConfig(p)).rejects.toThrow(/failed to parse/);
});

// --------- classifyBitbucketRegistration ---------

test("classifyBitbucketRegistration returns 'absent' when config is null", () => {
  expect(classifyBitbucketRegistration(null)).toEqual({ kind: "absent" });
});

test("classifyBitbucketRegistration returns 'absent' when bitbucket key missing", () => {
  expect(classifyBitbucketRegistration({ mcpServers: {} })).toEqual({ kind: "absent" });
});

test("classifyBitbucketRegistration returns 'local-build' for absolute path ending in bitbucket-mcp.mjs", () => {
  const cfg: ClaudeConfig = {
    mcpServers: {
      bitbucket: {
        type: "stdio",
        command: "/Users/x/repos/bitbucket-mcp/dist/bitbucket-mcp.mjs",
        args: [],
      },
    },
  };
  expect(classifyBitbucketRegistration(cfg)).toEqual({
    kind: "local-build",
    command: "/Users/x/repos/bitbucket-mcp/dist/bitbucket-mcp.mjs",
  });
});

test("classifyBitbucketRegistration returns 'on-npx' for npx with @mcpkit/bitbucket in args", () => {
  const cfg: ClaudeConfig = {
    mcpServers: {
      bitbucket: { type: "stdio", command: "npx", args: ["-y", "@mcpkit/bitbucket"] },
    },
  };
  expect(classifyBitbucketRegistration(cfg)).toEqual({ kind: "on-npx" });
});

test("classifyBitbucketRegistration returns 'unknown-shape' for anything else", () => {
  const cfg: ClaudeConfig = {
    mcpServers: {
      bitbucket: { type: "stdio", command: "node", args: ["/some/other/server.js"] },
    },
  };
  expect(classifyBitbucketRegistration(cfg)).toEqual({
    kind: "unknown-shape",
    command: "node",
  });
});

// --------- findClaudeBinary ---------

test("findClaudeBinary returns true when 'claude --version' exits 0", async () => {
  const runner: ClaudeRunner = vi.fn(async () => ({ exitCode: 0, stdout: "1.0.0\n", stderr: "" }));
  const result = await findClaudeBinary({ run: runner });
  expect(result).toBe(true);
  expect(runner).toHaveBeenCalledWith(["--version"]);
});

test("findClaudeBinary returns false when binary cannot be spawned", async () => {
  const runner: ClaudeRunner = vi.fn(async () => {
    const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  const result = await findClaudeBinary({ run: runner });
  expect(result).toBe(false);
});

test("findClaudeBinary returns false when 'claude --version' exits non-zero", async () => {
  const runner: ClaudeRunner = vi.fn(async () => ({ exitCode: 127, stdout: "", stderr: "" }));
  expect(await findClaudeBinary({ run: runner })).toBe(false);
});

// --------- registerBitbucketServer ---------

test("registerBitbucketServer invokes 'claude mcp add-json' with the npx payload", async () => {
  const calls: string[][] = [];
  const runner: ClaudeRunner = vi.fn(async (args) => {
    calls.push([...args]);
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  await registerBitbucketServer({ run: runner });
  expect(calls).toHaveLength(1);
  const args = calls[0]!;
  expect(args[0]).toBe("mcp");
  expect(args[1]).toBe("add-json");
  expect(args[2]).toBe("bitbucket");
  // 4th arg is the JSON payload string
  const payload = JSON.parse(args[3]!) as Record<string, unknown>;
  expect(payload).toEqual({
    type: "stdio",
    command: "npx",
    args: ["-y", "@mcpkit/bitbucket"],
    env: {},
  });
  expect(args.slice(4)).toEqual(["--scope", "user"]);
});

test("registerBitbucketServer throws with stderr when claude exits non-zero", async () => {
  const runner: ClaudeRunner = vi.fn(async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "duplicate name\n",
  }));
  await expect(registerBitbucketServer({ run: runner })).rejects.toThrow(/duplicate name/);
});

// --------- removeBitbucketServer ---------

test("removeBitbucketServer invokes 'claude mcp remove' for user scope", async () => {
  const runner: ClaudeRunner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await removeBitbucketServer({ run: runner });
  expect(runner).toHaveBeenCalledWith(["mcp", "remove", "bitbucket", "--scope", "user"]);
});

test("removeBitbucketServer is a no-op when claude returns 'not found' (exit 1)", async () => {
  // claude mcp remove exits non-zero if the entry isn't there. We treat that as
  // success so callers can call remove-then-add unconditionally.
  const runner: ClaudeRunner = vi.fn(async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "MCP server 'bitbucket' not found\n",
  }));
  await expect(removeBitbucketServer({ run: runner })).resolves.toBeUndefined();
});
