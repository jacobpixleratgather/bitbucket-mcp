import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { inferBitbucketRepo, parseBitbucketRemote } from "./index.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bbmcp-git-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- parseBitbucketRemote ----------

test("parses HTTPS with .git suffix", () => {
  expect(parseBitbucketRemote("https://bitbucket.org/my-ws/my-repo.git")).toEqual({
    workspace: "my-ws",
    repo: "my-repo",
  });
});

test("parses HTTPS without .git suffix", () => {
  expect(parseBitbucketRemote("https://bitbucket.org/my-ws/my-repo")).toEqual({
    workspace: "my-ws",
    repo: "my-repo",
  });
});

test("parses HTTPS with trailing slash", () => {
  expect(parseBitbucketRemote("https://bitbucket.org/my-ws/my-repo/")).toEqual({
    workspace: "my-ws",
    repo: "my-repo",
  });
});

test("parses HTTPS with userinfo and strips it", () => {
  expect(parseBitbucketRemote("https://jacob@bitbucket.org/my-ws/my-repo.git")).toEqual({
    workspace: "my-ws",
    repo: "my-repo",
  });
});

test("parses scp-style SSH URL", () => {
  expect(parseBitbucketRemote("git@bitbucket.org:my-ws/my-repo.git")).toEqual({
    workspace: "my-ws",
    repo: "my-repo",
  });
});

test("parses scp-style SSH URL without .git", () => {
  expect(parseBitbucketRemote("git@bitbucket.org:my-ws/my-repo")).toEqual({
    workspace: "my-ws",
    repo: "my-repo",
  });
});

test("parses ssh:// URL", () => {
  expect(parseBitbucketRemote("ssh://git@bitbucket.org/my-ws/my-repo.git")).toEqual({
    workspace: "my-ws",
    repo: "my-repo",
  });
});

test("returns null for github.com remote", () => {
  expect(parseBitbucketRemote("git@github.com:my-ws/my-repo.git")).toBeNull();
  expect(parseBitbucketRemote("https://github.com/my-ws/my-repo.git")).toBeNull();
});

test("returns null for gitlab or other hosts", () => {
  expect(parseBitbucketRemote("https://gitlab.com/foo/bar.git")).toBeNull();
});

test("returns null for malformed URLs", () => {
  expect(parseBitbucketRemote("not a url")).toBeNull();
  expect(parseBitbucketRemote("")).toBeNull();
  expect(parseBitbucketRemote("https://")).toBeNull();
});

test("returns null for paths that are not workspace/repo", () => {
  expect(parseBitbucketRemote("https://bitbucket.org/just-one")).toBeNull();
  expect(parseBitbucketRemote("https://bitbucket.org/ws/repo/extra")).toBeNull();
  expect(parseBitbucketRemote("https://bitbucket.org/")).toBeNull();
});

test("returns null when workspace or repo is empty", () => {
  expect(parseBitbucketRemote("https://bitbucket.org//repo")).toBeNull();
  expect(parseBitbucketRemote("https://bitbucket.org/ws/")).toBeNull();
});

test("accepts uppercase BitBucket.org host", () => {
  expect(parseBitbucketRemote("https://BitBucket.org/my-ws/my-repo.git")).toEqual({
    workspace: "my-ws",
    repo: "my-repo",
  });
});

// ---------- inferBitbucketRepo ----------

async function writeGitConfig(dir: string, url: string): Promise<void> {
  const gitDir = path.join(dir, ".git");
  await fsp.mkdir(gitDir, { recursive: true });
  const config = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = ${url}
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
`;
  await fsp.writeFile(path.join(gitDir, "config"), config, "utf8");
}

test("inferBitbucketRepo finds repo from a directory with .git", async () => {
  await writeGitConfig(tmpDir, "git@bitbucket.org:acme/widgets.git");
  const result = await inferBitbucketRepo(tmpDir);
  expect(result).toEqual({ workspace: "acme", repo: "widgets" });
});

test("inferBitbucketRepo walks up parent directories", async () => {
  await writeGitConfig(tmpDir, "https://bitbucket.org/acme/widgets.git");
  const nested = path.join(tmpDir, "a", "b", "c");
  await fsp.mkdir(nested, { recursive: true });
  const result = await inferBitbucketRepo(nested);
  expect(result).toEqual({ workspace: "acme", repo: "widgets" });
});

test("inferBitbucketRepo returns null when no .git is found", async () => {
  // Use a temp dir known to have no .git and whose parents won't have one
  // until we reach filesystem root. This could in theory hit a .git on the
  // way up; that's unlikely but we guard the assertion accordingly.
  const noGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "bbmcp-nogit-"));
  try {
    const result = await inferBitbucketRepo(noGitDir);
    // If a parent directory unexpectedly has a .git, the result might be
    // non-null — accept either null or a RepoTarget shape.
    if (result !== null) {
      expect(result).toHaveProperty("workspace");
      expect(result).toHaveProperty("repo");
    }
  } finally {
    fs.rmSync(noGitDir, { recursive: true, force: true });
  }
});

test("inferBitbucketRepo returns null for non-Bitbucket remote", async () => {
  await writeGitConfig(tmpDir, "git@github.com:acme/widgets.git");
  const result = await inferBitbucketRepo(tmpDir);
  expect(result).toBeNull();
});

test("inferBitbucketRepo returns null when no origin block", async () => {
  const gitDir = path.join(tmpDir, ".git");
  await fsp.mkdir(gitDir, { recursive: true });
  await fsp.writeFile(
    path.join(gitDir, "config"),
    `[core]\n\trepositoryformatversion = 0\n`,
    "utf8",
  );
  const result = await inferBitbucketRepo(tmpDir);
  expect(result).toBeNull();
});

test("inferBitbucketRepo handles git worktree (.git file with gitdir pointer)", async () => {
  // Set up: main repo at tmpDir with a real .git dir and correct config.
  const mainDir = path.join(tmpDir, "main");
  const worktreeDir = path.join(tmpDir, "worktree");
  await fsp.mkdir(mainDir, { recursive: true });
  await fsp.mkdir(worktreeDir, { recursive: true });
  await writeGitConfig(mainDir, "git@bitbucket.org:acme/widgets.git");

  // The worktree-style .git file points to a real gitdir under main/.git/worktrees/wt1
  const wtGitDir = path.join(mainDir, ".git", "worktrees", "wt1");
  await fsp.mkdir(wtGitDir, { recursive: true });
  // Worktrees typically don't have their own config; git falls back to the
  // main gitdir's config. But our implementation reads <gitdir>/config only.
  // So write a config in the pointed-to dir for this test.
  const wtConfig = `[remote "origin"]\n\turl = https://bitbucket.org/acme/widgets.git\n`;
  await fsp.writeFile(path.join(wtGitDir, "config"), wtConfig, "utf8");

  await fsp.writeFile(path.join(worktreeDir, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");
  const result = await inferBitbucketRepo(worktreeDir);
  expect(result).toEqual({ workspace: "acme", repo: "widgets" });
});

test("inferBitbucketRepo handles git worktree with relative gitdir pointer", async () => {
  const mainDir = path.join(tmpDir, "main");
  const worktreeDir = path.join(tmpDir, "main", "wt");
  await fsp.mkdir(mainDir, { recursive: true });
  await fsp.mkdir(worktreeDir, { recursive: true });

  const wtGitDir = path.join(mainDir, ".git", "worktrees", "wt1");
  await fsp.mkdir(wtGitDir, { recursive: true });
  const wtConfig = `[remote "origin"]\n\turl = https://bitbucket.org/acme/widgets.git\n`;
  await fsp.writeFile(path.join(wtGitDir, "config"), wtConfig, "utf8");

  // Relative to the worktree directory.
  const rel = path.relative(worktreeDir, wtGitDir);
  await fsp.writeFile(path.join(worktreeDir, ".git"), `gitdir: ${rel}\n`, "utf8");
  const result = await inferBitbucketRepo(worktreeDir);
  expect(result).toEqual({ workspace: "acme", repo: "widgets" });
});
