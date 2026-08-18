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
  type BitbucketCommitStatus,
  type BitbucketDiffstat,
  type BitbucketPipeline,
  type BitbucketPr,
  type BitbucketStep,
  type PipelineLookup,
  type PipelineWithSteps,
  type PrTarget,
  type RepoTarget,
} from "../types.ts";

// Output caps. Both default to roughly 25k tokens of text, which is what an
// MCP host will accept in one tool result before spilling it to a file.
const DEFAULT_DIFF_MAX_BYTES = 100_000;
const DEFAULT_LOG_MAX_BYTES = 100_000;
const MAX_OUTPUT_BYTES = 5_000_000;

// Step results that mean "this is the step you want the log for".
const FAILING_RESULTS = new Set(["FAILED", "ERROR", "STOPPED"]);

// ---------- Public API ----------

export type ServerOptions = {
  client?: BitbucketClient;
  inferRepo?: (cwd?: string) => Promise<RepoTarget | null>;
  getBranch?: (cwd?: string) => Promise<string | null>;
  getHeadSha?: (cwd?: string) => Promise<string | null>;
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
  const getHeadSha = opts.getHeadSha ?? defaultGetHeadSha;
  const cwd = opts.cwd ?? process.cwd();

  const server = new McpServer({ name: "bitbucket-mcp", version: "0.1.0" });

  const deps: HandlerDeps = { client, inferRepo, getBranch, getHeadSha, cwd };

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
  getHeadSha: (cwd?: string) => Promise<string | null>;
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
  args: {
    workspace?: string;
    repo?: string;
    pr_id?: number;
    paths?: string[];
    stat_only?: boolean;
    max_bytes?: number;
  },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);

    if (args.stat_only === true) {
      const stat = await deps.client.getPrDiffStat(resolved.target);
      return textResult(JSON.stringify(summarizeDiffStat(stat, args.paths), null, 2));
    }

    const paths = args.paths ?? [];
    const diff = await deps.client.getPrDiff(resolved.target, {
      paths: paths.length > 0 ? paths : undefined,
    });
    if (diff.length === 0) {
      const scope = paths.length > 0 ? ` for paths: ${paths.join(", ")}` : "";
      return textResult(
        `No diff content${scope}. Use \`stat_only: true\` to list the files this PR changes.`,
      );
    }
    const maxBytes = clampBytes(args.max_bytes, DEFAULT_DIFF_MAX_BYTES);
    if (diff.length <= maxBytes) {
      return textResult(diff);
    }
    const note =
      `\n[bitbucket-mcp] Diff truncated: showing the first ${formatBytes(maxBytes)} of ` +
      `${formatBytes(diff.length)}. Narrow it with \`paths\`, summarize it with ` +
      `\`stat_only: true\`, or raise \`max_bytes\`.\n`;
    return textResult(`${diff.slice(0, maxBytes)}${note}`);
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

export async function handleListPipelines(
  deps: HandlerDeps,
  args: {
    workspace?: string;
    repo?: string;
    pr_id?: number;
    branch?: string;
    commit?: string;
    build_number?: number;
    limit?: number;
    include_steps?: boolean;
  },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const withSteps = args.include_steps ?? true;
    const limit = args.limit ?? 5;

    const lookup = await resolvePipelineLookup(deps, repo, args, { limit, withSteps });
    if (!lookup.ok) return errorResult(lookup.error);

    return textResult(JSON.stringify(formatLookup(repo, lookup.value), null, 2));
  });
}

/** Picks the lookup strategy from whichever scoping argument was supplied. */
async function resolvePipelineLookup(
  deps: HandlerDeps,
  repo: RepoTarget,
  args: { pr_id?: number; branch?: string; commit?: string; build_number?: number },
  opts: { limit: number; withSteps: boolean },
): Promise<{ ok: true; value: PipelineLookup } | { ok: false; error: string }> {
  if (args.build_number !== undefined) {
    const entry = await deps.client.getPipeline(repo, String(args.build_number), {
      withSteps: opts.withSteps,
    });
    return { ok: true, value: { match: "build_number", pipelines: [entry] } };
  }
  if (args.commit !== undefined) {
    return {
      ok: true,
      value: await deps.client.findPipelinesForCommit(repo, args.commit, {
        branch: args.branch,
        limit: opts.limit,
        withSteps: opts.withSteps,
      }),
    };
  }
  // An explicit pr_id beats branch: it is the more specific request, and the PR
  // route derives the branch itself.
  if (args.branch !== undefined && args.pr_id === undefined) {
    const pipelines = await deps.client.listPipelines(repo, {
      branch: args.branch,
      limit: opts.limit,
      withSteps: opts.withSteps,
    });
    return {
      ok: true,
      value: {
        match: pipelines.length > 0 ? "branch" : "none",
        branch: args.branch,
        pipelines,
      },
    };
  }
  const resolved = await resolvePrTarget(deps, repo, args.pr_id);
  if (!resolved.ok) {
    return {
      ok: false,
      error: `${resolved.error} Or pass \`branch\`, \`commit\`, or \`build_number\` to look up pipelines without a PR.`,
    };
  }
  return {
    ok: true,
    value: await deps.client.findPipelinesForPr(resolved.target, {
      limit: opts.limit,
      withSteps: opts.withSteps,
    }),
  };
}

export async function handleGetPipelineStepLog(
  deps: HandlerDeps,
  args: {
    workspace?: string;
    repo?: string;
    pipeline_uuid: string;
    step_uuid?: string;
    tail_lines?: number;
    max_bytes?: number;
  },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);

    let stepUuid = args.step_uuid;
    let step: BitbucketStep | undefined;
    if (stepUuid === undefined) {
      const steps = await deps.client.listPipelineSteps(repo, args.pipeline_uuid);
      step = pickInterestingStep(steps);
      if (step === undefined) {
        return errorResult(
          `Pipeline ${args.pipeline_uuid} has no steps yet, so there is no log to read. Use \`list_pipelines\` with \`build_number\` to check its state.`,
        );
      }
      stepUuid = step.uuid;
    }

    const log = await deps.client.getPipelineStepLog(repo, args.pipeline_uuid, stepUuid);
    const trimmed = trimLog(log, {
      tailLines: args.tail_lines,
      maxBytes: clampBytes(args.max_bytes, DEFAULT_LOG_MAX_BYTES),
    });

    const header = [
      `[bitbucket-mcp] pipeline ${args.pipeline_uuid} step ${describeStep(step, stepUuid)}`,
      trimmed.note,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
    return textResult(`${header}\n${trimmed.text}`);
  });
}

export async function handleGetBuildStatus(
  deps: HandlerDeps,
  args: { workspace?: string; repo?: string; commit?: string; pr_id?: number },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);

    let statuses: BitbucketCommitStatus[];
    let target: { type: "commit" | "pull_request"; commit?: string; pr_id?: number };
    if (args.commit !== undefined) {
      statuses = await deps.client.getCommitStatuses(repo, args.commit);
      target = { type: "commit", commit: args.commit };
    } else if (args.pr_id !== undefined) {
      statuses = await deps.client.getPrStatuses({ ...repo, prId: args.pr_id });
      target = { type: "pull_request", pr_id: args.pr_id };
    } else {
      const head = await deps.getHeadSha(deps.cwd);
      if (head === null) {
        return errorResult(
          "Could not determine a commit to check. Pass `commit` (a SHA) or `pr_id`, or run the MCP from inside a git checkout.",
        );
      }
      statuses = await deps.client.getCommitStatuses(repo, head);
      target = { type: "commit", commit: head };
    }

    const verdict = overallVerdict(statuses);
    const out: {
      target: typeof target;
      verdict: string;
      note?: string;
      statuses: ReturnType<typeof stripCommitStatus>[];
    } = {
      target,
      verdict,
      statuses: statuses.map(stripCommitStatus),
    };
    if (verdict === "NO_STATUSES") {
      out.note =
        "Nothing has posted a build status for this commit. That is not the same as a failed build — a pipeline may have run without publishing a status, so check `list_pipelines` before concluding anything.";
    }
    return textResult(JSON.stringify(out, null, 2));
  });
}

export async function handleRunPipeline(
  deps: HandlerDeps,
  args: {
    workspace?: string;
    repo?: string;
    branch?: string;
    commit?: string;
    custom_pipeline?: string;
    variables?: Array<{ key: string; value: string; secured?: boolean }>;
  },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);

    let branch = args.branch;
    if (branch === undefined) {
      const current = await deps.getBranch(deps.cwd);
      if (current === null) {
        return errorResult(
          "Could not determine which branch to build. Pass `branch` explicitly, or run the MCP from inside a git checkout.",
        );
      }
      branch = current;
    }

    let pipeline: BitbucketPipeline;
    try {
      pipeline = await deps.client.triggerPipeline(repo, {
        branch,
        commit: args.commit,
        customPipeline: args.custom_pipeline,
        variables: args.variables,
      });
    } catch (err) {
      if (err instanceof BitbucketError && err.status === 403) {
        return errorResult(
          "Bitbucket refused to start the pipeline (403). Triggering pipelines needs the `pipeline:write` OAuth scope — " +
            "if you set this MCP up before that scope was requested, re-run `bitbucket-mcp setup` to re-authorize. " +
            `It can also mean you lack write permission on ${branch} (branch restrictions). Bitbucket said: ${err.body}`,
        );
      }
      throw err;
    }

    const what =
      args.custom_pipeline !== undefined ? `custom pipeline "${args.custom_pipeline}"` : "pipeline";
    return textResult(
      `Started ${what} #${pipeline.build_number} on ${branch}\n${JSON.stringify(
        stripPipeline(repo, { pipeline, steps: [] }),
        null,
        2,
      )}`,
    );
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

export async function handleUpdatePr(
  deps: HandlerDeps,
  args: {
    workspace?: string;
    repo?: string;
    pr_id?: number;
    title?: string;
    description?: string;
    reviewers?: string[];
  },
): Promise<ToolResult> {
  return safely(async () => {
    if (
      args.title === undefined &&
      args.description === undefined &&
      args.reviewers === undefined
    ) {
      return errorResult("Pass at least one of `title`, `description`, or `reviewers` to update.");
    }
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);
    const updated = await deps.client.updatePr(resolved.target, {
      title: args.title,
      description: args.description,
      reviewers: args.reviewers,
    });
    return textResult(`Updated PR #${updated.id}\n${JSON.stringify(updated, null, 2)}`);
  });
}

export async function handleSetPrDraftState(
  deps: HandlerDeps,
  args: { workspace?: string; repo?: string; pr_id?: number; draft: boolean },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);
    const updated = await deps.client.setPrDraftState(resolved.target, args.draft);
    const verb = args.draft ? "draft" : "ready for review";
    return textResult(`Marked PR #${updated.id} as ${verb}\n${JSON.stringify(updated, null, 2)}`);
  });
}

export async function handleResolvePrComment(
  deps: HandlerDeps,
  args: {
    workspace?: string;
    repo?: string;
    pr_id?: number;
    comment_id: number;
    resolved?: boolean;
  },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    const resolved = await resolvePrTarget(deps, repo, args.pr_id);
    if (!resolved.ok) return errorResult(resolved.error);
    const wantResolved = args.resolved ?? true;
    const out = await deps.client.resolvePrComment(resolved.target, args.comment_id, wantResolved);
    const verb = wantResolved ? "resolved" : "unresolved";
    const tail = out !== undefined ? `\n${JSON.stringify(out, null, 2)}` : "";
    return textResult(`Marked comment #${args.comment_id} ${verb}${tail}`);
  });
}

export async function handleCreatePr(
  deps: HandlerDeps,
  args: {
    workspace?: string;
    repo?: string;
    title: string;
    source_branch?: string;
    destination_branch?: string;
    description?: string;
    close_source_branch?: boolean;
    reviewers?: string[];
  },
): Promise<ToolResult> {
  return safely(async () => {
    const repo = await resolveRepo(deps, args);
    if (repo === null) return errorResult(NO_REPO_MESSAGE);
    let sourceBranch = args.source_branch;
    if (sourceBranch === undefined) {
      const branch = await deps.getBranch(deps.cwd);
      if (branch === null) {
        return errorResult(
          "Could not determine current git branch to use as the PR source. Pass `source_branch` explicitly.",
        );
      }
      sourceBranch = branch;
    }
    const created = await deps.client.createPr(repo, {
      title: args.title,
      sourceBranch,
      destinationBranch: args.destination_branch,
      description: args.description,
      closeSourceBranch: args.close_source_branch,
      reviewers: args.reviewers,
    });
    return textResult(`Created PR #${created.id}\n${JSON.stringify(created, null, 2)}`);
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
        "Fetch the unified diff for a pull request. For a large PR, start with `stat_only: true` to see which files changed and how big the diff is, then pass `paths` to fetch only the parts you need. Output is capped at `max_bytes` (default 100 KB) and the tail is dropped with a note when it overflows.",
      inputSchema: {
        ...workspaceRepoShape,
        ...prIdShape,
        paths: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Limit the diff to these files or directories (repo-relative; a directory matches everything under it).",
          ),
        stat_only: z
          .boolean()
          .optional()
          .describe(
            "Return a per-file summary (status, lines added/removed) plus totals instead of the diff text.",
          ),
        max_bytes: z
          .number()
          .int()
          .min(1000)
          .max(MAX_OUTPUT_BYTES)
          .optional()
          .describe("Maximum diff bytes to return. Default 100000."),
      },
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
    "list_pipelines",
    {
      title: "List pipelines",
      description:
        "Find Bitbucket Pipelines builds and their per-step pass/fail state. Scope it with `build_number` (exact build), `commit` (SHA, short or full), `branch`, or `pr_id` — with none of those it uses the PR for the current branch. " +
        "PR lookups do not require the repo to have a `pull-requests:` trigger: when no pipeline is attributable to the PR, this falls back to the most recent pipelines on the PR's source branch and says so in `match` and `note`. " +
        '`match: "none"` means no pipeline ran at all — distinct from a fallback. Steps include their UUIDs, so this is where you get the arguments for `get_pipeline_step_log`.',
      inputSchema: {
        ...workspaceRepoShape,
        ...prIdShape,
        branch: z.string().min(1).optional().describe("Branch name to list pipelines for."),
        commit: z
          .string()
          .min(4)
          .optional()
          .describe("Commit SHA (short or full) to find pipelines for."),
        build_number: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Fetch one specific build by its build number (e.g. 27419)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of pipelines to return, newest first. Default 5."),
        include_steps: z
          .boolean()
          .optional()
          .describe("Include each pipeline's steps. Default true; set false for a cheaper answer."),
      },
      annotations: { title: "List pipelines", ...READ_ONLY },
    },
    async (args) => handleListPipelines(deps, args),
  );

  server.registerTool(
    "get_pipeline_step_log",
    {
      title: "Get pipeline step log",
      description:
        "Fetch the log output of a pipeline step. `pipeline_uuid` accepts either a pipeline UUID or a plain build number (e.g. 27419); UUIDs work with or without curly braces. " +
        "Omit `step_uuid` to get the first failed step's log (or the last step when everything passed). Use `tail_lines` when you only need the end of the log — that is where failures are. " +
        "Output is capped at `max_bytes` (default 100 KB), keeping the end of the log. If you only need whether a step passed, use `list_pipelines` instead — it returns step state without any log.",
      inputSchema: {
        ...workspaceRepoShape,
        pipeline_uuid: z.string().min(1).describe("Pipeline UUID or build number."),
        step_uuid: z
          .string()
          .min(1)
          .optional()
          .describe("Step UUID. Defaults to the first failed step, else the last step."),
        tail_lines: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .optional()
          .describe("Return only the last N lines of the log."),
        max_bytes: z
          .number()
          .int()
          .min(1000)
          .max(MAX_OUTPUT_BYTES)
          .optional()
          .describe("Maximum log bytes to return, keeping the end. Default 100000."),
      },
      annotations: { title: "Get pipeline step log", ...READ_ONLY },
    },
    async (args) => handleGetPipelineStepLog(deps, args),
  );

  server.registerTool(
    "get_build_status",
    {
      title: "Get build status",
      description:
        "Answer \"is this commit green?\" in one call, using Bitbucket's commit build statuses (Pipelines results plus anything else that posts a status). Pass `commit` (a SHA) or `pr_id`; with neither, it uses the current checkout's HEAD. " +
        "`verdict` is FAILED / INPROGRESS / STOPPED / SUCCESSFUL / NO_STATUSES. NO_STATUSES means nothing posted a status — check `list_pipelines` before concluding a build did not run.",
      inputSchema: {
        ...workspaceRepoShape,
        ...prIdShape,
        commit: z
          .string()
          .min(4)
          .optional()
          .describe("Commit SHA. Defaults to the checkout's HEAD."),
      },
      annotations: { title: "Get build status", ...READ_ONLY },
    },
    async (args) => handleGetBuildStatus(deps, args),
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
    "update_pr",
    {
      title: "Update PR",
      description:
        "Update a pull request's title, description (the PR Overview), and/or reviewers. Pass any combination — fields you omit are left unchanged. The description is interpreted as Markdown. `reviewers` replaces the full reviewer list with the given Bitbucket account UUIDs (including the curly braces); pass an empty array to clear all reviewers.",
      inputSchema: {
        ...workspaceRepoShape,
        ...prIdShape,
        title: z.string().min(1).optional().describe("New PR title."),
        description: z
          .string()
          .optional()
          .describe("New PR description (Markdown). Pass an empty string to clear it."),
        reviewers: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Reviewer account UUIDs (e.g. `{abcd-...}`). Replaces the entire reviewer list. Pass `[]` to clear all reviewers.",
          ),
      },
      annotations: { title: "Update PR", ...WRITE },
    },
    async (args) => handleUpdatePr(deps, args),
  );

  server.registerTool(
    "set_pr_draft_state",
    {
      title: "Set PR draft state",
      description:
        "Mark a pull request as draft or ready for review. Pass `draft: true` to convert to draft, or `draft: false` to mark ready.",
      inputSchema: {
        ...workspaceRepoShape,
        ...prIdShape,
        draft: z.boolean().describe("True to mark as draft, false to mark ready for review."),
      },
      annotations: {
        title: "Set PR draft state",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => handleSetPrDraftState(deps, args),
  );

  server.registerTool(
    "resolve_pr_comment",
    {
      title: "Resolve PR comment",
      description:
        "Mark a PR comment as resolved or unresolved. Defaults to resolved=true. Use `list_pr_comments` to see current resolution state.",
      inputSchema: {
        ...workspaceRepoShape,
        ...prIdShape,
        comment_id: z.number().int().positive().describe("ID of the comment to (un)resolve."),
        resolved: z
          .boolean()
          .optional()
          .describe("True to mark resolved (default), false to unresolve."),
      },
      annotations: {
        title: "Resolve PR comment",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => handleResolvePrComment(deps, args),
  );

  server.registerTool(
    "create_pr",
    {
      title: "Create PR",
      description:
        "Open a new pull request. `source_branch` defaults to the current git branch when run from inside a checkout. `destination_branch` defaults to the repository's configured main branch on Bitbucket. `description` is interpreted as Markdown. `reviewers` is a list of Bitbucket account UUIDs (including the curly braces).",
      inputSchema: {
        ...workspaceRepoShape,
        title: z.string().min(1).describe("PR title."),
        source_branch: z
          .string()
          .min(1)
          .optional()
          .describe("Source branch name. Defaults to the current git branch."),
        destination_branch: z
          .string()
          .min(1)
          .optional()
          .describe("Destination branch name. Defaults to the repo's main branch."),
        description: z.string().optional().describe("PR description (Markdown)."),
        close_source_branch: z
          .boolean()
          .optional()
          .describe("If true, the source branch is deleted on merge."),
        reviewers: z
          .array(z.string().min(1))
          .optional()
          .describe("Reviewer account UUIDs (e.g. `{abcd-...}`)."),
      },
      annotations: { title: "Create PR", ...WRITE },
    },
    async (args) => handleCreatePr(deps, args),
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

  server.registerTool(
    "run_pipeline",
    {
      title: "Run pipeline",
      description:
        "Start a Bitbucket pipeline — a re-run of a branch's build, or a definition from the `custom:` section of bitbucket-pipelines.yml. " +
        "`branch` defaults to the current git branch; `commit` pins the build to a specific SHA instead of the branch tip. Consumes build minutes and can deploy, so confirm with the user before running a custom pipeline you did not pick out together. " +
        "Requires the `pipeline:write` OAuth scope (re-run `bitbucket-mcp setup` if the server was set up before that scope existed).",
      inputSchema: {
        ...workspaceRepoShape,
        branch: z
          .string()
          .min(1)
          .optional()
          .describe("Branch to build. Defaults to the current git branch."),
        commit: z
          .string()
          .min(7)
          .optional()
          .describe("Commit SHA to build. Defaults to the branch tip."),
        custom_pipeline: z
          .string()
          .min(1)
          .optional()
          .describe("Name of a definition under `custom:` in bitbucket-pipelines.yml."),
        variables: z
          .array(
            z.object({
              key: z.string().min(1).describe("Variable name."),
              value: z.string().describe("Variable value."),
              secured: z
                .boolean()
                .optional()
                .describe("If true, the value is masked in the build log."),
            }),
          )
          .optional()
          .describe("Variables to pass to the build."),
      },
      annotations: {
        title: "Run pipeline",
        readOnlyHint: false,
        // Starting a build consumes minutes and a custom pipeline may deploy.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => handleRunPipeline(deps, args),
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
  resolved: boolean;
  inline?: { path: string; line_new?: number; line_old?: number };
  parent_id?: number;
} {
  const out: {
    id: number;
    author: string;
    body: string;
    created_on: string;
    updated_on: string;
    resolved: boolean;
    inline?: { path: string; line_new?: number; line_old?: number };
    parent_id?: number;
  } = {
    id: c.id,
    author: c.user.display_name,
    body: c.content.raw,
    created_on: c.created_on,
    updated_on: c.updated_on,
    resolved: c.resolution !== undefined && c.resolution !== null,
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

type StrippedStep = {
  uuid: string;
  name: string;
  state: BitbucketStep["state"]["name"];
  result?: string;
  duration_seconds?: number;
  started_on?: string;
  completed_on?: string;
  error?: string;
};

function stripStep(step: BitbucketStep): StrippedStep {
  const out: StrippedStep = {
    uuid: step.uuid,
    name: step.name,
    state: step.state.name,
    result: step.state.result?.name,
    duration_seconds: step.duration_in_seconds,
    started_on: step.started_on,
    completed_on: step.completed_on,
  };
  const error = step.state.result?.error;
  if (error !== undefined) {
    out.error = [error.key, error.message].filter((v) => v !== undefined).join(": ");
  }
  return out;
}

type StrippedPipeline = {
  build_number: number;
  pipeline_uuid: string;
  state: BitbucketPipeline["state"]["name"];
  result?: string;
  trigger?: string;
  target?: {
    ref_name?: string;
    commit?: string;
    selector?: string;
    pull_request_id?: number;
  };
  created_on: string;
  completed_on?: string;
  // Wall-clock, derived from the timestamps. Distinct from build_seconds_used,
  // which sums every step and so exceeds wall-clock when steps run in parallel.
  duration_seconds?: number;
  build_seconds_used?: number;
  url: string;
  steps?: StrippedStep[];
};

function stripPipeline(repo: RepoTarget, entry: PipelineWithSteps): StrippedPipeline {
  const p = entry.pipeline;
  const out: StrippedPipeline = {
    build_number: p.build_number,
    pipeline_uuid: p.uuid,
    state: p.state.name,
    result: p.state.result?.name,
    trigger: p.trigger?.name,
    created_on: p.created_on,
    completed_on: p.completed_on,
    duration_seconds: wallClockSeconds(p.created_on, p.completed_on),
    build_seconds_used: p.build_seconds_used,
    url: `https://bitbucket.org/${repo.workspace}/${repo.repo}/pipelines/results/${p.build_number}`,
  };
  if (p.target !== undefined) {
    const selector = p.target.selector;
    out.target = {
      ref_name: p.target.ref_name,
      commit: p.target.commit?.hash,
      selector:
        selector === undefined
          ? undefined
          : [selector.type, selector.pattern].filter((v) => v !== undefined).join(":"),
      pull_request_id: p.target.pullrequest?.id,
    };
  }
  if (entry.steps.length > 0) {
    out.steps = entry.steps.map(stripStep);
  }
  return out;
}

/** Seconds between two ISO timestamps, or undefined if either is unusable. */
function wallClockSeconds(from: string, to: string | undefined): number | undefined {
  if (to === undefined) {
    return undefined;
  }
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  return Math.round((end - start) / 1000);
}

function stripCommitStatus(status: BitbucketCommitStatus): {
  key: string;
  name?: string;
  state: BitbucketCommitStatus["state"];
  description?: string;
  refname?: string;
  url?: string;
  updated_on?: string;
} {
  return {
    key: status.key,
    name: status.name,
    state: status.state,
    description: status.description,
    refname: status.refname,
    url: status.url,
    updated_on: status.updated_on,
  };
}

// ---------- Pipeline lookup presentation ----------

/**
 * Renders a lookup as the tool payload. `match` and `note` exist so a caller can
 * tell "the pipelines below built the branch, not the PR" from "a pipeline ran
 * for exactly this PR" from "nothing ran at all" — collapsing those into an
 * empty list is what made pipelines undiscoverable.
 */
function formatLookup(
  repo: RepoTarget,
  lookup: PipelineLookup,
): {
  match: PipelineLookup["match"];
  note?: string;
  pr_id?: number;
  branch?: string;
  commit?: string;
  pipelines: Array<StrippedPipeline & { is_requested_commit?: boolean }>;
} {
  const wanted = lookup.commit;
  return {
    match: lookup.match,
    note: lookupNote(lookup),
    pr_id: lookup.prId,
    branch: lookup.branch,
    commit: wanted,
    pipelines: lookup.pipelines.map((entry) => {
      const stripped = stripPipeline(repo, entry);
      if (wanted === undefined) {
        return stripped;
      }
      return {
        ...stripped,
        is_requested_commit: sameCommit(entry.pipeline.target?.commit?.hash, wanted),
      };
    }),
  };
}

function lookupNote(lookup: PipelineLookup): string | undefined {
  const prRef = lookup.prId !== undefined ? `PR #${lookup.prId}` : "the PR";
  switch (lookup.match) {
    case "branch_fallback":
      return (
        `No pipeline is attributable to ${prRef} (nothing was PR-triggered and nothing built its head commit ` +
        `${shortSha(lookup.commit)}). These are the most recent pipelines on its source branch ` +
        `'${lookup.branch ?? "?"}' instead — the usual cause is a bitbucket-pipelines.yml with no ` +
        "`pull-requests:` section, so every build fires on branch push. Check `is_requested_commit` " +
        "before treating one of these as this PR's build."
      );
    case "none":
      if (lookup.branch !== undefined) {
        return (
          `No pipeline has ever run for branch '${lookup.branch}'` +
          `${lookup.prId !== undefined ? ` (${prRef})` : ""}. This is not a missing PR trigger — ` +
          "Bitbucket has no build for this branch at all. Check that Pipelines is enabled for the repo " +
          "and that the branch matches a section of bitbucket-pipelines.yml."
        );
      }
      return (
        `No pipeline built commit ${shortSha(lookup.commit)}. Nothing ran for this commit — ` +
        "try the branch instead, since the pipeline may have run for a different commit on it."
      );
    default:
      return undefined;
  }
}

function sameCommit(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 7 && longer.toLowerCase().startsWith(shorter.toLowerCase());
}

function shortSha(sha: string | undefined): string {
  return sha === undefined ? "(unknown)" : sha.slice(0, 12);
}

/**
 * The step whose log a caller almost certainly wants: the first failure, else
 * the last step that actually started — a step still PENDING has no log yet.
 */
function pickInterestingStep(steps: BitbucketStep[]): BitbucketStep | undefined {
  const failed = steps.find((step) => {
    const result = step.state.result?.name;
    return result !== undefined && FAILING_RESULTS.has(result);
  });
  if (failed !== undefined) {
    return failed;
  }
  const started = steps.filter((step) => step.started_on !== undefined);
  return started[started.length - 1] ?? steps[steps.length - 1];
}

function describeStep(step: BitbucketStep | undefined, stepUuid: string): string {
  if (step === undefined) {
    return stepUuid;
  }
  const result = step.state.result?.name;
  const state = result !== undefined ? `${step.state.name}/${result}` : step.state.name;
  const duration = step.duration_in_seconds !== undefined ? `, ${step.duration_in_seconds}s` : "";
  return `"${step.name}" ${step.uuid} — ${state}${duration}`;
}

// ---------- Output size control ----------

/**
 * Applies `tailLines` then `maxBytes`, keeping the END of the log: a failing
 * step's useful output is the last few dozen lines, not the dependency install.
 */
function trimLog(
  log: string,
  opts: { tailLines?: number; maxBytes: number },
): { text: string; note?: string } {
  const notes: string[] = [];
  let text = log;

  if (opts.tailLines !== undefined) {
    const lines = text.split("\n");
    // A trailing newline yields a final empty element; don't count it as a line.
    const hasTrailingNewline = lines[lines.length - 1] === "";
    const content = hasTrailingNewline ? lines.slice(0, -1) : lines;
    if (content.length > opts.tailLines) {
      const kept = content.slice(-opts.tailLines);
      text = `${kept.join("\n")}${hasTrailingNewline ? "\n" : ""}`;
      notes.push(`last ${opts.tailLines} of ${content.length} lines`);
    }
  }

  if (text.length > opts.maxBytes) {
    text = text.slice(text.length - opts.maxBytes);
    notes.push(`last ${formatBytes(opts.maxBytes)} of ${formatBytes(log.length)}`);
  }

  if (notes.length === 0) {
    return { text };
  }
  return {
    text,
    note: `[bitbucket-mcp] Showing ${notes.join("; ")} (raise tail_lines / max_bytes for more).`,
  };
}

function summarizeDiffStat(
  stat: BitbucketDiffstat[],
  paths?: string[],
): {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  files: Array<{
    path: string;
    status: BitbucketDiffstat["status"];
    lines_added: number;
    lines_removed: number;
    old_path?: string;
  }>;
} {
  const files = stat
    .map((entry) => {
      const newPath = entry.new?.path;
      const oldPath = entry.old?.path;
      const path = newPath ?? oldPath ?? "(unknown)";
      const out: {
        path: string;
        status: BitbucketDiffstat["status"];
        lines_added: number;
        lines_removed: number;
        old_path?: string;
      } = {
        path,
        status: entry.status,
        lines_added: entry.lines_added ?? 0,
        lines_removed: entry.lines_removed ?? 0,
      };
      if (oldPath !== undefined && oldPath !== newPath) {
        out.old_path = oldPath;
      }
      return out;
    })
    .filter((file) => matchesPaths(file.path, paths) || matchesPaths(file.old_path, paths));

  return {
    files_changed: files.length,
    lines_added: files.reduce((sum, f) => sum + f.lines_added, 0),
    lines_removed: files.reduce((sum, f) => sum + f.lines_removed, 0),
    files,
  };
}

function matchesPaths(path: string | undefined, paths?: string[]): boolean {
  if (paths === undefined || paths.length === 0) {
    return true;
  }
  if (path === undefined) {
    return false;
  }
  return paths.some((raw) => {
    const wanted = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    return path === wanted || path.startsWith(`${wanted}/`);
  });
}

function overallVerdict(
  statuses: BitbucketCommitStatus[],
): "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED" | "NO_STATUSES" {
  if (statuses.length === 0) {
    return "NO_STATUSES";
  }
  const states = new Set(statuses.map((s) => s.state));
  if (states.has("FAILED")) return "FAILED";
  if (states.has("INPROGRESS")) return "INPROGRESS";
  if (states.has("STOPPED")) return "STOPPED";
  return "SUCCESSFUL";
}

function clampBytes(requested: number | undefined, def: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return def;
  }
  return Math.min(Math.floor(requested), MAX_OUTPUT_BYTES);
}

function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  return `${(n / 1024).toFixed(1)} KB`;
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

/** Returns the current HEAD commit SHA, or null when there is no checkout. */
function defaultGetHeadSha(cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: cwd ?? process.cwd() }, (err, stdout) => {
      if (err !== null) {
        resolve(null);
        return;
      }
      const sha = stdout.toString().trim();
      resolve(sha.length > 0 ? sha : null);
    });
  });
}
