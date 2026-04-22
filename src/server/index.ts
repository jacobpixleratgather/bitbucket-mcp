import { execFile } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { forceRefresh, getAccessToken } from "../auth/index.ts";
import { BitbucketClient } from "../bitbucket/index.ts";
import { inferBitbucketRepo } from "../git/index.ts";
import {
  AuthError,
  BitbucketError,
  type BitbucketComment,
  type BitbucketPipeline,
  type BitbucketPr,
  type BitbucketStep,
  type PrTarget,
  type RepoTarget,
} from "../types.ts";

// ---------- Public API ----------

export type ServerOptions = {
  client?: BitbucketClient;
  inferRepo?: (cwd?: string) => Promise<RepoTarget | null>;
  getBranch?: (cwd?: string) => Promise<string | null>;
  cwd?: string;
};

export type ToolResult =
  | { isError?: false; content: Array<{ type: "text"; text: string }> }
  | { isError: true; content: Array<{ type: "text"; text: string }> };

/**
 * Builds and returns an McpServer wired with the Bitbucket MCP tool surface.
 */
export function createServer(opts: ServerOptions = {}): McpServer {
  const client =
    opts.client ??
    new BitbucketClient({
      getAccessToken: () => getAccessToken(),
      onForceRefresh: async () => {
        await forceRefresh();
      },
    });
  const inferRepo = opts.inferRepo ?? inferBitbucketRepo;
  const getBranch = opts.getBranch ?? defaultGetBranch;
  const cwd = opts.cwd ?? process.cwd();

  const server = new McpServer({ name: "bitbucket-mcp", version: "0.1.0" });

  const deps: HandlerDeps = { client, inferRepo, getBranch, cwd };

  registerTools(server, deps);

  return server;
}

/**
 * Creates the server, connects it to stdio, and returns.
 */
export async function runServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------- Handler deps ----------

export type HandlerDeps = {
  client: BitbucketClient;
  inferRepo: (cwd?: string) => Promise<RepoTarget | null>;
  getBranch: (cwd?: string) => Promise<string | null>;
  cwd: string;
};

// ---------- Helpers: inference & error formatting ----------

const NO_REPO_MESSAGE =
  "Could not determine workspace/repo. Pass explicit workspace and repo arguments, or run the MCP from inside a Bitbucket git checkout.";

/**
 * Resolve workspace/repo: prefer explicit args, fall back to CWD inference.
 * Returns null if inference fails and no explicit args were provided.
 */
async function resolveRepo(
  deps: HandlerDeps,
  args: { workspace?: string; repo?: string },
): Promise<RepoTarget | null> {
  if (args.workspace !== undefined && args.repo !== undefined) {
    return { workspace: args.workspace, repo: args.repo };
  }
  const inferred = await deps.inferRepo(deps.cwd);
  if (inferred === null) {
    // If one was explicit and the other wasn't, still fall back to inference —
    // but since inference failed, we can't help.
    return null;
  }
  return {
    workspace: args.workspace ?? inferred.workspace,
    repo: args.repo ?? inferred.repo,
  };
}

/**
 * Resolve a PR target: either an explicit `pr_id`, or discover it from the
 * current branch via the Bitbucket API.
 */
async function resolvePrTarget(
  deps: HandlerDeps,
  repo: RepoTarget,
  prId: number | undefined,
): Promise<{ ok: true; target: PrTarget } | { ok: false; error: string }> {
  if (prId !== undefined) {
    return { ok: true, target: { ...repo, prId } };
  }
  const branch = await deps.getBranch(deps.cwd);
  if (branch === null) {
    return {
      ok: false,
      error: "Could not determine current git branch to infer pr_id. Pass pr_id explicitly.",
    };
  }
  const prs = await deps.client.listPrs(repo, { state: "OPEN", branch });
  if (prs.length === 0) {
    return {
      ok: false,
      error: `No open PR found for branch ${branch}. Pass pr_id explicitly.`,
    };
  }
  if (prs.length > 1) {
    const listing = prs.map((p) => `  #${p.id}: ${p.title}`).join("\n");
    return {
      ok: false,
      error: `Multiple open PRs match branch ${branch}:\n${listing}\nPass pr_id explicitly.`,
    };
  }
  const only = prs[0];
  if (only === undefined) {
    return {
      ok: false,
      error: `No open PR found for branch ${branch}. Pass pr_id explicitly.`,
    };
  }
  return { ok: true, target: { ...repo, prId: only.id } };
}

function textResult(text: string, isError = false): ToolResult {
  if (isError) {
    return { isError: true, content: [{ type: "text", text }] };
  }
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return textResult(text, true);
}

/**
 * Maps a thrown error into a tool error result. Never rethrows.
 */
function formatError(err: unknown): ToolResult {
  if (err instanceof AuthError) {
    const msg = err.message;
    const hint = /bitbucket-mcp setup/i.test(msg)
      ? msg
      : `${msg} Run \`bitbucket-mcp setup\` to (re-)authenticate.`;
    return errorResult(hint);
  }
  if (err instanceof BitbucketError) {
    if (err.status === 404) {
      const urlMatch = /for\s+\S+\s+(https?:\/\/\S+)/.exec(err.message);
      const detail = urlMatch?.[1] ?? err.message;
      return errorResult(`Not found (${detail}). Check the IDs and try again.`);
    }
    const body = err.body.length > 0 ? `: ${err.body}` : "";
    return errorResult(`Bitbucket API error (${err.status})${body}`);
  }
  if (err instanceof Error) {
    return errorResult(err.message);
  }
  return errorResult(String(err));
}

/** Wrap a handler body; catch all errors and return as tool errors. */
async function safely(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return formatError(err);
  }
}

// ---------- Tool handlers (exported for testability) ----------

export async function handleGetPr(
  deps: HandlerDeps,
  args: { workspace?: string; repo?: string; pr_id?: number },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);
    const pr = await deps.client.getPr(resolved.target);
    return textResult(JSON.stringify(pr, null, 2));
  });
}

export async function handleListPrs(
  deps: HandlerDeps,
  args: {
    workspace?: string;
    repo?: string;
    state?: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
    author?: string;
    branch?: string;
    limit?: number;
  },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const prs = await deps.client.listPrs(repo, {
      state: args.state ?? "OPEN",
      author: args.author,
      branch: args.branch,
      limit: args.limit ?? 20,
    });
    const stripped = prs.map(stripPr);
    return textResult(JSON.stringify(stripped, null, 2));
  });
}

export async function handleGetPrDiff(
  deps: HandlerDeps,
  args: { workspace?: string; repo?: string; pr_id?: number },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);
    const diff = await deps.client.getPrDiff(resolved.target);
    return textResult(diff);
  });
}

export async function handleListPrComments(
  deps: HandlerDeps,
  args: { workspace?: string; repo?: string; pr_id?: number; limit?: number },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);
    const comments = await deps.client.listPrComments(resolved.target, {
      limit: args.limit ?? 100,
    });
    const stripped = comments.map(stripComment);
    // Sort oldest first, matching the doc.
    stripped.sort((a, b) => (a.created_on < b.created_on ? -1 : 1));
    return textResult(JSON.stringify(stripped, null, 2));
  });
}

export async function handleGetPrPipelineStatus(
  deps: HandlerDeps,
  args: { workspace?: string; repo?: string; pr_id?: number },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);
    const status = await deps.client.getPrPipelineStatus(resolved.target);
    const out = status.map((entry) => ({
      pipeline_uuid: entry.pipeline.uuid,
      build_number: entry.pipeline.build_number,
      state: entry.pipeline.state.name,
      result: entry.pipeline.state.result?.name,
      created_on: entry.pipeline.created_on,
      steps: entry.steps.map(stripStep),
    }));
    return textResult(JSON.stringify(out, null, 2));
  });
}

export async function handleGetPipelineStepLog(
  deps: HandlerDeps,
  args: {
    workspace?: string;
    repo?: string;
    pipeline_uuid: string;
    step_uuid: string;
  },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const log = await deps.client.getPipelineStepLog(repo, args.pipeline_uuid, args.step_uuid);
    return textResult(log);
  });
}

export async function handleAddPrComment(
  deps: HandlerDeps,
  args: { workspace?: string; repo?: string; pr_id?: number; body: string },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);
    const comment = await deps.client.addPrComment(resolved.target, args.body);
    return textResult(`Posted comment #${comment.id}\n${JSON.stringify(comment, null, 2)}`);
  });
}

export async function handleReplyToPrComment(
  deps: HandlerDeps,
  args: { workspace?: string; repo?: string; pr_id?: number; comment_id: number; body: string },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);
    const reply = await deps.client.replyToPrComment(resolved.target, args.comment_id, args.body);
    return textResult(
      `Posted reply #${reply.id} to comment #${args.comment_id}\n${JSON.stringify(reply, null, 2)}`,
    );
  });
}

export async function handleAddPrInlineComment(
  deps: HandlerDeps,
  args: {
    workspace?: string;
    repo?: string;
    pr_id?: number;
    body: string;
    path: string;
    line: number;
    side?: "new" | "old";
  },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);
    const comment = await deps.client.addPrInlineComment(resolved.target, {
      body: args.body,
      path: args.path,
      line: args.line,
      side: args.side ?? "new",
    });
    return textResult(
      `Posted inline comment #${comment.id} on ${args.path}:${args.line}\n${JSON.stringify(comment, null, 2)}`,
    );
  });
}

// ---------- Tool registration ----------

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const workspaceRepoShape = {
  workspace: z.string().optional().describe("Bitbucket workspace (slug)."),
  repo: z.string().optional().describe("Bitbucket repo slug."),
};

const prIdShape = {
  pr_id: z.number().int().positive().optional().describe("Pull request id."),
};

function registerTools(server: McpServer, deps: HandlerDeps): void {
  server.registerTool(
    "get_pr",
    {
      title: "Get PR",
      description:
        "Fetch a Bitbucket pull request's metadata (title, state, author, branches, description, URL).",
      inputSchema: { ...workspaceRepoShape, ...prIdShape },
      annotations: { title: "Get PR", ...READ_ONLY },
    },
    async (args) => handleGetPr(deps, args),
  );

  server.registerTool(
    "list_prs",
    {
      title: "List PRs",
      description:
        "List pull requests in a Bitbucket repository. Filter by state, author UUID, or branch. Returns up to `limit` results sorted newest first.",
      inputSchema: {
        ...workspaceRepoShape,
        state: z
          .enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"])
          .optional()
          .describe("PR state filter. Default OPEN."),
        author: z.string().optional().describe("Author UUID filter."),
        branch: z.string().optional().describe("Source branch filter."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of PRs to return. Default 20."),
      },
      annotations: { title: "List PRs", ...READ_ONLY },
    },
    async (args) => handleListPrs(deps, args),
  );

  server.registerTool(
    "get_pr_diff",
    {
      title: "Get PR diff",
      description:
        "Fetch the unified diff for a pull request. Returns the raw text diff, suitable for reviewing what the PR changes.",
      inputSchema: { ...workspaceRepoShape, ...prIdShape },
      annotations: { title: "Get PR diff", ...READ_ONLY },
    },
    async (args) => handleGetPrDiff(deps, args),
  );

  server.registerTool(
    "list_pr_comments",
    {
      title: "List PR comments",
      description:
        "List all comments on a pull request, including general and inline (file+line) comments. Returns comments sorted oldest-first.",
      inputSchema: {
        ...workspaceRepoShape,
        ...prIdShape,
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum number of comments to return. Default 100."),
      },
      annotations: { title: "List PR comments", ...READ_ONLY },
    },
    async (args) => handleListPrComments(deps, args),
  );

  server.registerTool(
    "get_pr_pipeline_status",
    {
      title: "Get PR pipeline status",
      description:
        "Get the status of pipelines triggered by this PR (most recent first), with each step's pass/fail state. Use this to find failing steps; then use `get_pipeline_step_log` to read logs.",
      inputSchema: { ...workspaceRepoShape, ...prIdShape },
      annotations: { title: "Get PR pipeline status", ...READ_ONLY },
    },
    async (args) => handleGetPrPipelineStatus(deps, args),
  );

  server.registerTool(
    "get_pipeline_step_log",
    {
      title: "Get pipeline step log",
      description:
        "Fetch the log output of a specific pipeline step. Use pipeline_uuid and step_uuid from `get_pr_pipeline_status`. Returns plain text log contents.",
      inputSchema: {
        ...workspaceRepoShape,
        pipeline_uuid: z.string().min(1).describe("Pipeline UUID."),
        step_uuid: z.string().min(1).describe("Pipeline step UUID."),
      },
      annotations: { title: "Get pipeline step log", ...READ_ONLY },
    },
    async (args) => handleGetPipelineStepLog(deps, args),
  );

  server.registerTool(
    "add_pr_comment",
    {
      title: "Add PR comment",
      description:
        "Post a general comment on a pull request (not tied to a specific file or line). For inline file/line comments, use `add_pr_inline_comment`.",
      inputSchema: {
        ...workspaceRepoShape,
        ...prIdShape,
        body: z.string().min(1).describe("Comment body (Markdown)."),
      },
      annotations: { title: "Add PR comment", ...WRITE },
    },
    async (args) => handleAddPrComment(deps, args),
  );

  server.registerTool(
    "reply_to_pr_comment",
    {
      title: "Reply to PR comment",
      description:
        "Reply to an existing PR comment, creating a threaded reply. For inline comments, the path and line are inherited from the parent — do not use `add_pr_inline_comment` to reply, since that posts a sibling comment instead of a threaded reply.",
      inputSchema: {
        ...workspaceRepoShape,
        ...prIdShape,
        comment_id: z.number().int().positive().describe("ID of the comment to reply to."),
        body: z.string().min(1).describe("Reply body (Markdown)."),
      },
      annotations: { title: "Reply to PR comment", ...WRITE },
    },
    async (args) => handleReplyToPrComment(deps, args),
  );

  server.registerTool(
    "add_pr_inline_comment",
    {
      title: "Add PR inline comment",
      description:
        "Post a comment on a specific file and line within a pull request's diff. Use `get_pr_diff` first if you need to confirm line numbers are present in the diff. For general PR comments, use `add_pr_comment`.",
      inputSchema: {
        ...workspaceRepoShape,
        ...prIdShape,
        body: z.string().min(1).describe("Comment body (Markdown)."),
        path: z.string().min(1).describe("Repo-relative file path."),
        line: z.number().int().min(1).describe("Line number (1-based)."),
        side: z
          .enum(["new", "old"])
          .optional()
          .describe("Which side of the diff to anchor to. Default `new` (the PR's version)."),
      },
      annotations: { title: "Add PR inline comment", ...WRITE },
    },
    async (args) => handleAddPrInlineComment(deps, args),
  );
}

// ---------- Shape-strippers ----------

function stripPr(pr: BitbucketPr): {
  id: number;
  title: string;
  state: BitbucketPr["state"];
  author: string;
  source_branch: string;
  destination_branch: string;
  updated_on: string;
  url: string;
} {
  return {
    id: pr.id,
    title: pr.title,
    state: pr.state,
    author: pr.author.display_name,
    source_branch: pr.source.branch.name,
    destination_branch: pr.destination.branch.name,
    updated_on: pr.updated_on,
    url: pr.links.html.href,
  };
}

function stripComment(c: BitbucketComment): {
  id: number;
  author: string;
  body: string;
  created_on: string;
  updated_on: string;
  inline?: { path: string; line_new?: number; line_old?: number };
  parent_id?: number;
} {
  const out: {
    id: number;
    author: string;
    body: string;
    created_on: string;
    updated_on: string;
    inline?: { path: string; line_new?: number; line_old?: number };
    parent_id?: number;
  } = {
    id: c.id,
    author: c.user.display_name,
    body: c.content.raw,
    created_on: c.created_on,
    updated_on: c.updated_on,
  };
  if (c.inline !== undefined) {
    const inline: { path: string; line_new?: number; line_old?: number } = {
      path: c.inline.path,
    };
    if (c.inline.to !== undefined && c.inline.to !== null) {
      inline.line_new = c.inline.to;
    }
    if (c.inline.from !== undefined && c.inline.from !== null) {
      inline.line_old = c.inline.from;
    }
    out.inline = inline;
  }
  if (c.parent !== undefined) {
    out.parent_id = c.parent.id;
  }
  return out;
}

function stripStep(step: BitbucketStep): {
  uuid: string;
  name: string;
  state: BitbucketStep["state"]["name"];
  result?: string;
  started_on?: string;
  completed_on?: string;
} {
  return {
    uuid: step.uuid,
    name: step.name,
    state: step.state.name,
    result: step.state.result?.name,
    started_on: step.started_on,
    completed_on: step.completed_on,
  };
}

// Re-export types so tests in other modules can reference them if needed.
export type { BitbucketPipeline, BitbucketStep };

// ---------- Default branch resolution ----------

/**
 * Returns the current git branch, or null if:
 *   - git is not installed,
 *   - the directory is not a git checkout,
 *   - HEAD is detached.
 */
function defaultGetBranch(cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: cwd ?? process.cwd() },
      (err, stdout) => {
        if (err !== null) {
          resolve(null);
          return;
        }
        const branch = stdout.toString().trim();
        if (branch.length === 0 || branch === "HEAD") {
          resolve(null);
          return;
        }
        resolve(branch);
      },
    );
  });
}
