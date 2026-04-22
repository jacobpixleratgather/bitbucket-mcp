import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { classifyBitbucketRegistration, readClaudeConfig, type ClaudeConfig } from "./index.ts";

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

test("classifyBitbucketRegistration returns 'on-npx' for npx with @bb-mcp/server in args", () => {
  const cfg: ClaudeConfig = {
    mcpServers: {
      bitbucket: { type: "stdio", command: "npx", args: ["-y", "@bb-mcp/server"] },
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
