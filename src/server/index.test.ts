import { expect, test, vi } from "vite-plus/test";
import { BitbucketClient } from "../bitbucket/index.ts";
import {
  AuthError,
  BitbucketError,
  type BitbucketComment,
  type BitbucketPipeline,
  type BitbucketPr,
  type BitbucketStep,
  type PipelineLookup,
  type PrTarget,
  type RepoTarget,
} from "../types.ts";
import {
  createServer,
  handleAddPrComment,
  handleAddPrInlineComment,
  handleCreatePr,
  handleGetBuildStatus,
  handleGetPipelineStepLog,
  handleGetPr,
  handleGetPrDiff,
  handleListPipelines,
  handleListPrComments,
  handleListPrs,
  handleReplyToPrComment,
  handleResolvePrComment,
  handleRunPipeline,
  handleSetPrDraftState,
  handleUpdatePr,
  type HandlerDeps,
  type ToolResult,
} from "./index.ts";

// ---------- Helpers ----------

function makeClientMock(overrides: Partial<BitbucketClient> = {}): BitbucketClient {
  const base = {
    getPr: vi.fn(),
    listPrs: vi.fn(),
    getPrDiff: vi.fn(),
    getPrDiffStat: vi.fn(),
    listPrComments: vi.fn(),
    addPrComment: vi.fn(),
    addPrInlineComment: vi.fn(),
    createPr: vi.fn(),
    listPipelines: vi.fn(),
    getPipeline: vi.fn(),
    listPipelineSteps: vi.fn(),
    findPipelinesForPr: vi.fn(),
    findPipelinesForCommit: vi.fn(),
    triggerPipeline: vi.fn(),
    getCommitStatuses: vi.fn(),
    getPrStatuses: vi.fn(),
    getPipelineStepLog: vi.fn(),
    replyToPrComment: vi.fn(),
    updatePr: vi.fn(),
    setPrDraftState: vi.fn(),
    resolvePrComment: vi.fn(),
  };
  return Object.assign(base, overrides) as unknown as BitbucketClient;
}

function makeDeps(
  opts: {
    client?: BitbucketClient;
    inferRepo?: () => Promise<RepoTarget | null>;
    getBranch?: () => Promise<string | null>;
    getHeadSha?: () => Promise<string | null>;
    cwd?: string;
  } = {},
): HandlerDeps {
  return {
    client: opts.client ?? makeClientMock(),
    inferRepo: opts.inferRepo ?? vi.fn(async () => ({ workspace: "ws", repo: "r" })),
    getBranch: opts.getBranch ?? vi.fn(async () => "feature/x"),
    getHeadSha: opts.getHeadSha ?? vi.fn(async () => "a".repeat(40)),
    cwd: opts.cwd ?? "/tmp",
  };
}

function samplePr(id = 42, title = "Some PR"): BitbucketPr {
  return {
    id,
    title,
    state: "OPEN",
    author: { display_name: "Ada", uuid: "{ada}" },
    source: { branch: { name: "feature/x" }, commit: { hash: "abc" } },
    destination: { branch: { name: "main" }, commit: { hash: "def" } },
    created_on: "2024-01-01T00:00:00Z",
    updated_on: "2024-01-02T00:00:00Z",
    links: { html: { href: `https://bitbucket.org/ws/r/pull-requests/${id}` } },
  };
}

function sampleComment(id = 1, body = "hi"): BitbucketComment {
  return {
    id,
    content: { raw: body },
    user: { display_name: "Ada", uuid: "{ada}" },
    created_on: "2024-01-01T00:00:00Z",
    updated_on: "2024-01-01T00:00:00Z",
  };
}

function extractText(result: ToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected text content");
  }
  return first.text;
}

// ---------- createServer + server wiring ----------

test("createServer registers the 15 expected tools", () => {
  const server = createServer({
    client: makeClientMock(),
    inferRepo: async () => ({ workspace: "ws", repo: "r" }),
    getBranch: async () => "feature/x",
    cwd: "/tmp",
  });
  // Use the private _registeredTools map as a sanity check on registration.
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  const names = Object.keys(tools).sort();
  expect(names).toEqual(
    [
      "add_pr_comment",
      "add_pr_inline_comment",
      "create_pr",
      "get_build_status",
      "get_pipeline_step_log",
      "get_pr",
      "get_pr_diff",
      "list_pipelines",
      "list_pr_comments",
      "list_prs",
      "reply_to_pr_comment",
      "resolve_pr_comment",
      "run_pipeline",
      "set_pr_draft_state",
      "update_pr",
    ].sort(),
  );
});

// ---------- CWD inference ----------

test("CWD inference fills in missing workspace/repo", async () => {
  const pr = samplePr(7);
  const getPr = vi.fn(async (_t: PrTarget) => pr);
  const client = makeClientMock({ getPr });
  const inferRepo = vi.fn(async () => ({ workspace: "inferred-ws", repo: "inferred-r" }));
  const deps = makeDeps({ client, inferRepo });

  const result = await handleGetPr(deps, { pr_id: 7 });

  expect(result.isError).toBeFalsy();
  expect(inferRepo).toHaveBeenCalledTimes(1);
  expect(getPr).toHaveBeenCalledWith({ workspace: "inferred-ws", repo: "inferred-r", prId: 7 });
});

test("explicit workspace/repo args override CWD inference", async () => {
  const pr = samplePr(7);
  const getPr = vi.fn(async (_t: PrTarget) => pr);
  const client = makeClientMock({ getPr });
  const inferRepo = vi.fn(async () => ({ workspace: "inferred-ws", repo: "inferred-r" }));
  const deps = makeDeps({ client, inferRepo });

  await handleGetPr(deps, { workspace: "explicit-ws", repo: "explicit-r", pr_id: 7 });

  // Both explicit → no inference needed.
  expect(inferRepo).not.toHaveBeenCalled();
  expect(getPr).toHaveBeenCalledWith({
    workspace: "explicit-ws",
    repo: "explicit-r",
    prId: 7,
  });
});

test("no-repo case returns a clear tool error", async () => {
  const deps = makeDeps({
    inferRepo: vi.fn(async () => null),
  });

  const result = await handleGetPr(deps, { pr_id: 7 });

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("Could not determine workspace/repo");
});

// ---------- PR id inference ----------

test("PR id inference: single open PR on branch is used", async () => {
  const pr = samplePr(99);
  const listPrs = vi.fn(async (_t: RepoTarget, _opts?: unknown) => [pr]);
  const getPr = vi.fn(async (_t: PrTarget) => pr);
  const client = makeClientMock({ listPrs, getPr });
  const deps = makeDeps({ client, getBranch: vi.fn(async () => "feature/x") });

  const result = await handleGetPr(deps, {});

  expect(result.isError).toBeFalsy();
  expect(listPrs).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r" },
    { state: "OPEN", branch: "feature/x" },
  );
  expect(getPr).toHaveBeenCalledWith({ workspace: "ws", repo: "r", prId: 99 });
});

test("PR id inference: zero PRs on branch returns helpful error", async () => {
  const client = makeClientMock({
    listPrs: vi.fn(async () => []),
  });
  const deps = makeDeps({ client, getBranch: vi.fn(async () => "feature/x") });

  const result = await handleGetPr(deps, {});

  expect(result.isError).toBe(true);
  expect(extractText(result)).toBe("No open PR found for branch feature/x. Pass pr_id explicitly.");
});

test("PR id inference: multiple PRs returns error listing them", async () => {
  const client = makeClientMock({
    listPrs: vi.fn(async () => [samplePr(1, "First"), samplePr(2, "Second")]),
  });
  const deps = makeDeps({ client, getBranch: vi.fn(async () => "feature/x") });

  const result = await handleGetPr(deps, {});

  expect(result.isError).toBe(true);
  const text = extractText(result);
  expect(text).toContain("Multiple open PRs match branch feature/x");
  expect(text).toContain("#1: First");
  expect(text).toContain("#2: Second");
  expect(text).toContain("Pass pr_id explicitly.");
});

test("PR id inference: detached HEAD returns actionable error", async () => {
  const deps = makeDeps({ getBranch: vi.fn(async () => null) });

  const result = await handleGetPr(deps, {});

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("Pass pr_id explicitly");
});

// ---------- Tool-by-tool behavior ----------

test("get_pr returns JSON-serialized PR", async () => {
  const pr = samplePr(7);
  const client = makeClientMock({ getPr: vi.fn(async () => pr) });
  const deps = makeDeps({ client });

  const result = await handleGetPr(deps, { pr_id: 7 });

  expect(result.isError).toBeFalsy();
  expect(JSON.parse(extractText(result))).toEqual(pr);
});

test("list_prs builds right client call and returns stripped shape", async () => {
  const pr = samplePr(1, "Hello");
  const listPrs = vi.fn(async () => [pr]);
  const client = makeClientMock({ listPrs });
  const deps = makeDeps({ client });

  const result = await handleListPrs(deps, {
    branch: "feature/y",
    limit: 5,
    author: "{uuid}",
  });

  expect(result.isError).toBeFalsy();
  expect(listPrs).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r" },
    { state: "OPEN", author: "{uuid}", branch: "feature/y", limit: 5 },
  );
  const parsed = JSON.parse(extractText(result));
  expect(parsed).toEqual([
    {
      id: 1,
      title: "Hello",
      state: "OPEN",
      author: "Ada",
      source_branch: "feature/x",
      destination_branch: "main",
      updated_on: "2024-01-02T00:00:00Z",
      url: "https://bitbucket.org/ws/r/pull-requests/1",
    },
  ]);
});

test("get_pr_diff returns diff text verbatim", async () => {
  const diff = "diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-x\n+y\n";
  const getPrDiff = vi.fn(async () => diff);
  const client = makeClientMock({ getPrDiff });
  const deps = makeDeps({ client });

  const result = await handleGetPrDiff(deps, { pr_id: 7 });

  expect(result.isError).toBeFalsy();
  expect(extractText(result)).toBe(diff);
  expect(getPrDiff).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r", prId: 7 },
    { paths: undefined },
  );
});

test("get_pr_diff passes paths through to the client", async () => {
  const getPrDiff = vi.fn(async () => "diff --git a/src/a.ts b/src/a.ts\n+x\n");
  const deps = makeDeps({ client: makeClientMock({ getPrDiff }) });

  await handleGetPrDiff(deps, { pr_id: 7, paths: ["src"] });

  expect(getPrDiff).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r", prId: 7 },
    { paths: ["src"] },
  );
});

test("get_pr_diff truncates a huge diff with instructions instead of dumping it", async () => {
  const diff = "x".repeat(5000);
  const deps = makeDeps({ client: makeClientMock({ getPrDiff: vi.fn(async () => diff) }) });

  const text = extractText(await handleGetPrDiff(deps, { pr_id: 7, max_bytes: 1000 }));

  expect(text.startsWith("x".repeat(1000))).toBe(true);
  expect(text).toContain("Diff truncated");
  expect(text).toContain("stat_only");
});

test("get_pr_diff stat_only summarizes files and totals", async () => {
  const getPrDiffStat = vi.fn(async () => [
    { status: "modified" as const, lines_added: 10, lines_removed: 2, new: { path: "src/a.ts" } },
    { status: "added" as const, lines_added: 5, lines_removed: 0, new: { path: "docs/b.md" } },
    {
      status: "renamed" as const,
      lines_added: 1,
      lines_removed: 1,
      old: { path: "src/old.ts" },
      new: { path: "src/newer.ts" },
    },
  ]);
  const deps = makeDeps({ client: makeClientMock({ getPrDiffStat }) });

  const parsed = JSON.parse(
    extractText(await handleGetPrDiff(deps, { pr_id: 7, stat_only: true, paths: ["src"] })),
  );

  expect(parsed.files_changed).toBe(2);
  expect(parsed.lines_added).toBe(11);
  expect(parsed.lines_removed).toBe(3);
  expect(parsed.files.map((f: { path: string }) => f.path)).toEqual(["src/a.ts", "src/newer.ts"]);
  expect(parsed.files[1].old_path).toBe("src/old.ts");
});

test("get_pr_diff explains an empty path-filtered diff", async () => {
  const deps = makeDeps({ client: makeClientMock({ getPrDiff: vi.fn(async () => "") }) });

  const text = extractText(await handleGetPrDiff(deps, { pr_id: 7, paths: ["nope"] }));

  expect(text).toContain("No diff content for paths: nope");
  expect(text).toContain("stat_only");
});

test("list_pr_comments sorts oldest first and strips inline fields", async () => {
  const commentA = sampleComment(1, "second");
  commentA.created_on = "2024-01-02T00:00:00Z";
  commentA.inline = { path: "src/a.ts", to: 42 };
  const commentB = sampleComment(2, "first");
  commentB.created_on = "2024-01-01T00:00:00Z";
  commentB.parent = { id: 99 };
  const client = makeClientMock({
    listPrComments: vi.fn(async () => [commentA, commentB]),
  });
  const deps = makeDeps({ client });

  const result = await handleListPrComments(deps, { pr_id: 7, limit: 50 });
  const parsed = JSON.parse(extractText(result));

  expect(parsed[0].body).toBe("first");
  expect(parsed[0].parent_id).toBe(99);
  expect(parsed[1].body).toBe("second");
  expect(parsed[1].inline).toEqual({ path: "src/a.ts", line_new: 42 });
});

function samplePipeline(overrides: Partial<BitbucketPipeline> = {}): BitbucketPipeline {
  return {
    uuid: "{pipe}",
    build_number: 27419,
    state: { name: "COMPLETED", result: { name: "FAILED" } },
    created_on: "2024-01-03T00:00:00Z",
    completed_on: "2024-01-03T00:10:00Z",
    build_seconds_used: 600,
    trigger: { name: "PUSH" },
    target: {
      ref_name: "feature/x",
      commit: { hash: "deadbeefdeadbeef" },
      selector: { type: "branches", pattern: "feature/*" },
    },
    ...overrides,
  };
}

function sampleStep(overrides: Partial<BitbucketStep> = {}): BitbucketStep {
  return {
    uuid: "{step}",
    name: "Test",
    state: { name: "COMPLETED", result: { name: "FAILED" } },
    started_on: "2024-01-03T00:00:05Z",
    completed_on: "2024-01-03T00:01:00Z",
    duration_in_seconds: 55,
    ...overrides,
  };
}

test("list_pipelines reports a PR-matched pipeline with steps and a build URL", async () => {
  const lookup: PipelineLookup = {
    match: "pr_head_commit",
    prId: 7,
    branch: "feature/x",
    commit: "deadbeefdeadbeef",
    pipelines: [{ pipeline: samplePipeline(), steps: [sampleStep()] }],
  };
  const findPipelinesForPr = vi.fn(async () => lookup);
  const deps = makeDeps({ client: makeClientMock({ findPipelinesForPr }) });

  const result = await handleListPipelines(deps, { pr_id: 7 });
  const parsed = JSON.parse(extractText(result));

  expect(findPipelinesForPr).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r", prId: 7 },
    { limit: 5, withSteps: true },
  );
  expect(parsed.match).toBe("pr_head_commit");
  expect(parsed.note).toBeUndefined();
  expect(parsed.pipelines[0]).toMatchObject({
    build_number: 27419,
    pipeline_uuid: "{pipe}",
    state: "COMPLETED",
    result: "FAILED",
    trigger: "PUSH",
    // Wall clock from created_on/completed_on, not build_seconds_used.
    duration_seconds: 600,
    build_seconds_used: 600,
    url: "https://bitbucket.org/ws/r/pipelines/results/27419",
    is_requested_commit: true,
    target: {
      ref_name: "feature/x",
      commit: "deadbeefdeadbeef",
      selector: "branches:feature/*",
    },
  });
  expect(parsed.pipelines[0].steps[0]).toMatchObject({
    uuid: "{step}",
    name: "Test",
    state: "COMPLETED",
    result: "FAILED",
    duration_seconds: 55,
  });
});

test("list_pipelines explains a branch fallback instead of returning nothing", async () => {
  const lookup: PipelineLookup = {
    match: "branch_fallback",
    prId: 5605,
    branch: "feature/x",
    commit: "cafecafecafe",
    pipelines: [
      { pipeline: samplePipeline({ target: { commit: { hash: "111111111111" } } }), steps: [] },
    ],
  };
  const deps = makeDeps({
    client: makeClientMock({ findPipelinesForPr: vi.fn(async () => lookup) }),
  });

  const parsed = JSON.parse(extractText(await handleListPipelines(deps, { pr_id: 5605 })));

  expect(parsed.match).toBe("branch_fallback");
  expect(parsed.note).toContain("pull-requests:");
  expect(parsed.note).toContain("feature/x");
  expect(parsed.pipelines[0].is_requested_commit).toBe(false);
});

test("list_pipelines distinguishes no-pipeline-at-all from a fallback", async () => {
  const lookup: PipelineLookup = {
    match: "none",
    prId: 5605,
    branch: "feature/x",
    commit: "cafecafecafe",
    pipelines: [],
  };
  const deps = makeDeps({
    client: makeClientMock({ findPipelinesForPr: vi.fn(async () => lookup) }),
  });

  const parsed = JSON.parse(extractText(await handleListPipelines(deps, { pr_id: 5605 })));

  expect(parsed.match).toBe("none");
  expect(parsed.note).toContain("No pipeline has ever run for branch 'feature/x'");
  expect(parsed.pipelines).toEqual([]);
});

test("list_pipelines looks up a build number without touching the PR", async () => {
  const getPipeline = vi.fn(async () => ({
    pipeline: samplePipeline(),
    steps: [sampleStep()],
  }));
  const getBranch = vi.fn(async () => "feature/x");
  const deps = makeDeps({ client: makeClientMock({ getPipeline }), getBranch });

  const parsed = JSON.parse(
    extractText(await handleListPipelines(deps, { build_number: 27419, include_steps: false })),
  );

  expect(getPipeline).toHaveBeenCalledWith({ workspace: "ws", repo: "r" }, "27419", {
    withSteps: false,
  });
  expect(getBranch).not.toHaveBeenCalled();
  expect(parsed.match).toBe("build_number");
});

test("list_pipelines scopes by branch and by commit", async () => {
  const listPipelines = vi.fn(async () => []);
  const findPipelinesForCommit = vi.fn(async () => ({
    match: "commit" as const,
    commit: "abc1234",
    pipelines: [],
  }));
  const client = makeClientMock({ listPipelines, findPipelinesForCommit });
  const deps = makeDeps({ client });

  const byBranch = JSON.parse(extractText(await handleListPipelines(deps, { branch: "main" })));
  expect(listPipelines).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r" },
    { branch: "main", limit: 5, withSteps: true },
  );
  expect(byBranch.match).toBe("none");
  expect(byBranch.note).toContain("No pipeline has ever run for branch 'main'");

  await handleListPipelines(deps, { commit: "abc1234", branch: "main", limit: 2 });
  expect(findPipelinesForCommit).toHaveBeenCalledWith({ workspace: "ws", repo: "r" }, "abc1234", {
    branch: "main",
    limit: 2,
    withSteps: true,
  });
});

test("list_pipelines prefers an explicit pr_id over branch", async () => {
  const listPipelines = vi.fn(async () => []);
  const findPipelinesForPr = vi.fn(async () => ({
    match: "pr_head_commit" as const,
    prId: 7,
    pipelines: [],
  }));
  const deps = makeDeps({ client: makeClientMock({ listPipelines, findPipelinesForPr }) });

  await handleListPipelines(deps, { pr_id: 7, branch: "main" });

  expect(findPipelinesForPr).toHaveBeenCalled();
  expect(listPipelines).not.toHaveBeenCalled();
});

test("get_pipeline_step_log skips steps that have not started", async () => {
  const listPipelineSteps = vi.fn(async () => [
    sampleStep({
      uuid: "{step-done}",
      name: "Build",
      state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
    }),
    sampleStep({
      uuid: "{step-pending}",
      name: "Deploy",
      state: { name: "PENDING" },
      started_on: undefined,
      completed_on: undefined,
    }),
  ]);
  const getPipelineStepLog = vi.fn(async () => "output");
  const deps = makeDeps({ client: makeClientMock({ listPipelineSteps, getPipelineStepLog }) });

  await handleGetPipelineStepLog(deps, { pipeline_uuid: "27419" });

  expect(getPipelineStepLog).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r" },
    "27419",
    "{step-done}",
  );
});

test("list_pipelines suggests branch/commit lookup when no PR can be resolved", async () => {
  const client = makeClientMock({ listPrs: vi.fn(async () => []) });
  const deps = makeDeps({ client, getBranch: vi.fn(async () => "feature/x") });

  const result = await handleListPipelines(deps, {});

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("`branch`");
});

test("get_pipeline_step_log defaults to the first failed step and adds a status header", async () => {
  const listPipelineSteps = vi.fn(async () => [
    sampleStep({
      uuid: "{step-ok}",
      name: "Build",
      state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
    }),
    sampleStep({ uuid: "{step-bad}", name: "Test" }),
  ]);
  const getPipelineStepLog = vi.fn(async () => "line1\nline2\n");
  const client = makeClientMock({ listPipelineSteps, getPipelineStepLog });
  const deps = makeDeps({ client });

  const result = await handleGetPipelineStepLog(deps, { pipeline_uuid: "27419" });
  const text = extractText(result);

  expect(getPipelineStepLog).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r" },
    "27419",
    "{step-bad}",
  );
  expect(text).toContain('step "Test" {step-bad} — COMPLETED/FAILED, 55s');
  expect(text).toContain("line1\nline2");
});

test("get_pipeline_step_log honours tail_lines and notes the trim", async () => {
  const log = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
  const client = makeClientMock({ getPipelineStepLog: vi.fn(async () => log) });
  const deps = makeDeps({ client });

  const text = extractText(
    await handleGetPipelineStepLog(deps, {
      pipeline_uuid: "{pipe}",
      step_uuid: "{step}",
      tail_lines: 3,
    }),
  );

  expect(text).toContain("last 3 of 100 lines");
  expect(text).toContain("line98\nline99\nline100");
  expect(text).not.toContain("line97\n");
});

test("get_pipeline_step_log caps output at max_bytes keeping the end", async () => {
  const log = `${"x".repeat(5000)}TAIL`;
  const client = makeClientMock({ getPipelineStepLog: vi.fn(async () => log) });
  const deps = makeDeps({ client });

  const text = extractText(
    await handleGetPipelineStepLog(deps, {
      pipeline_uuid: "{pipe}",
      step_uuid: "{step}",
      max_bytes: 1000,
    }),
  );

  expect(text).toContain("TAIL");
  expect(text).toContain("last 1000 B of");
  expect(text.length).toBeLessThan(1400);
});

test("get_pipeline_step_log reports a pipeline with no steps", async () => {
  const client = makeClientMock({ listPipelineSteps: vi.fn(async () => []) });
  const deps = makeDeps({ client });

  const result = await handleGetPipelineStepLog(deps, { pipeline_uuid: "27419" });

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("no steps yet");
});

test("get_build_status summarizes commit statuses for the checkout HEAD", async () => {
  const getCommitStatuses = vi.fn(async () => [
    { key: "PIPELINE", name: "Pipeline #27419", state: "SUCCESSFUL" as const },
    { key: "LINT", state: "INPROGRESS" as const },
  ]);
  const client = makeClientMock({ getCommitStatuses });
  const deps = makeDeps({ client, getHeadSha: vi.fn(async () => "b".repeat(40)) });

  const parsed = JSON.parse(extractText(await handleGetBuildStatus(deps, {})));

  expect(getCommitStatuses).toHaveBeenCalledWith({ workspace: "ws", repo: "r" }, "b".repeat(40));
  expect(parsed.verdict).toBe("INPROGRESS");
  expect(parsed.target).toEqual({ type: "commit", commit: "b".repeat(40) });
  expect(parsed.statuses).toHaveLength(2);
});

test("get_build_status uses the PR statuses endpoint when given a pr_id", async () => {
  const getPrStatuses = vi.fn(async () => [{ key: "PIPELINE", state: "FAILED" as const }]);
  const deps = makeDeps({ client: makeClientMock({ getPrStatuses }) });

  const parsed = JSON.parse(extractText(await handleGetBuildStatus(deps, { pr_id: 7 })));

  expect(getPrStatuses).toHaveBeenCalledWith({ workspace: "ws", repo: "r", prId: 7 });
  expect(parsed.verdict).toBe("FAILED");
  expect(parsed.target).toEqual({ type: "pull_request", pr_id: 7 });
});

test("get_build_status flags an empty status list as NO_STATUSES with a caveat", async () => {
  const deps = makeDeps({ client: makeClientMock({ getCommitStatuses: vi.fn(async () => []) }) });

  const parsed = JSON.parse(extractText(await handleGetBuildStatus(deps, { commit: "abc1234" })));

  expect(parsed.verdict).toBe("NO_STATUSES");
  expect(parsed.note).toContain("list_pipelines");
});

test("get_build_status errors when there is no commit to check", async () => {
  const deps = makeDeps({ getHeadSha: vi.fn(async () => null) });

  const result = await handleGetBuildStatus(deps, {});

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("Pass `commit`");
});

test("run_pipeline defaults to the current branch and reports the new build", async () => {
  const triggerPipeline = vi.fn(async () => samplePipeline({ build_number: 27420 }));
  const deps = makeDeps({
    client: makeClientMock({ triggerPipeline }),
    getBranch: vi.fn(async () => "feature/x"),
  });

  const text = extractText(await handleRunPipeline(deps, {}));

  expect(triggerPipeline).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r" },
    { branch: "feature/x", commit: undefined, customPipeline: undefined, variables: undefined },
  );
  expect(text).toContain("Started pipeline #27420 on feature/x");
  expect(text).toContain("https://bitbucket.org/ws/r/pipelines/results/27420");
});

test("run_pipeline passes a custom pipeline and variables through", async () => {
  const triggerPipeline = vi.fn(async () => samplePipeline());
  const deps = makeDeps({ client: makeClientMock({ triggerPipeline }) });

  const text = extractText(
    await handleRunPipeline(deps, {
      branch: "main",
      custom_pipeline: "Deploy",
      variables: [{ key: "K", value: "V" }],
    }),
  );

  expect(triggerPipeline).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r" },
    {
      branch: "main",
      commit: undefined,
      customPipeline: "Deploy",
      variables: [{ key: "K", value: "V" }],
    },
  );
  expect(text).toContain('Started custom pipeline "Deploy"');
});

test("run_pipeline turns a 403 into a scope/permission hint", async () => {
  const triggerPipeline = vi.fn(async () => {
    throw new BitbucketError("forbidden", 403, "no write access");
  });
  const deps = makeDeps({ client: makeClientMock({ triggerPipeline }) });

  const result = await handleRunPipeline(deps, { branch: "main" });

  expect(result.isError).toBe(true);
  const text = extractText(result);
  expect(text).toContain("pipeline:write");
  expect(text).toContain("bitbucket-mcp setup");
});

test("run_pipeline errors when the branch cannot be determined", async () => {
  const deps = makeDeps({ getBranch: vi.fn(async () => null) });

  const result = await handleRunPipeline(deps, {});

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("Pass `branch`");
});

test("add_pr_comment posts and returns confirmation message", async () => {
  const comment = sampleComment(55, "nice");
  const addPrComment = vi.fn(async () => comment);
  const client = makeClientMock({ addPrComment });
  const deps = makeDeps({ client });

  const result = await handleAddPrComment(deps, { pr_id: 7, body: "nice" });

  expect(result.isError).toBeFalsy();
  expect(addPrComment).toHaveBeenCalledWith({ workspace: "ws", repo: "r", prId: 7 }, "nice");
  expect(extractText(result).startsWith("Posted comment #55")).toBe(true);
});

test("add_pr_inline_comment passes side through (old)", async () => {
  const comment = sampleComment(55, "wrong side?");
  const addPrInlineComment = vi.fn(async () => comment);
  const client = makeClientMock({ addPrInlineComment });
  const deps = makeDeps({ client });

  const result = await handleAddPrInlineComment(deps, {
    pr_id: 7,
    body: "wrong side?",
    path: "src/a.ts",
    line: 12,
    side: "old",
  });

  expect(result.isError).toBeFalsy();
  expect(addPrInlineComment).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r", prId: 7 },
    { body: "wrong side?", path: "src/a.ts", line: 12, side: "old" },
  );
  expect(extractText(result).startsWith("Posted inline comment #55 on src/a.ts:12")).toBe(true);
});

test("add_pr_inline_comment defaults side to 'new'", async () => {
  const addPrInlineComment = vi.fn(async () => sampleComment(1, "x"));
  const client = makeClientMock({ addPrInlineComment });
  const deps = makeDeps({ client });

  await handleAddPrInlineComment(deps, {
    pr_id: 7,
    body: "x",
    path: "src/a.ts",
    line: 1,
  });

  const calls = addPrInlineComment.mock.calls as unknown as Array<
    [unknown, { side: "new" | "old" }]
  >;
  const call = calls[0];
  if (call === undefined) {
    throw new Error("expected call");
  }
  expect(call[1].side).toBe("new");
});

test("list_pr_comments surfaces resolved=true when resolution is set", async () => {
  const resolved = sampleComment(1, "resolved one");
  resolved.resolution = {
    type: "pullrequest_comment_resolution",
    user: { display_name: "Ada" },
    created_on: "2024-01-02T00:00:00Z",
  };
  const unresolved = sampleComment(2, "open one");
  unresolved.resolution = null;
  const stillOpen = sampleComment(3, "no resolution key");
  const client = makeClientMock({
    listPrComments: vi.fn(async () => [resolved, unresolved, stillOpen]),
  });
  const deps = makeDeps({ client });

  const result = await handleListPrComments(deps, { pr_id: 7 });
  const parsed = JSON.parse(extractText(result));
  // Sorted oldest-first by created_on; all share the same date here so order
  // is stable as inserted. Index by id to be safe.
  const byId = new Map<number, { resolved: boolean }>(
    parsed.map((c: { id: number; resolved: boolean }) => [c.id, c]),
  );
  expect(byId.get(1)?.resolved).toBe(true);
  expect(byId.get(2)?.resolved).toBe(false);
  expect(byId.get(3)?.resolved).toBe(false);
});

test("update_pr requires at least one of title/description/reviewers", async () => {
  const updatePr = vi.fn();
  const client = makeClientMock({ updatePr });
  const deps = makeDeps({ client });

  const result = await handleUpdatePr(deps, { pr_id: 7 });

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain(
    "Pass at least one of `title`, `description`, or `reviewers`",
  );
  expect(updatePr).not.toHaveBeenCalled();
});

test("update_pr passes title and description through to client", async () => {
  const pr = samplePr(7, "New title");
  const updatePr = vi.fn(async () => pr);
  const client = makeClientMock({ updatePr });
  const deps = makeDeps({ client });

  const result = await handleUpdatePr(deps, {
    pr_id: 7,
    title: "New title",
    description: "Refreshed body",
  });

  expect(result.isError).toBeFalsy();
  expect(updatePr).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r", prId: 7 },
    { title: "New title", description: "Refreshed body", reviewers: undefined },
  );
  expect(extractText(result).startsWith("Updated PR #7")).toBe(true);
});

test("update_pr accepts description-only and forwards undefined title", async () => {
  const pr = samplePr(7);
  const updatePr = vi.fn(async () => pr);
  const client = makeClientMock({ updatePr });
  const deps = makeDeps({ client });

  await handleUpdatePr(deps, { pr_id: 7, description: "Just the body" });

  expect(updatePr).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r", prId: 7 },
    { title: undefined, description: "Just the body", reviewers: undefined },
  );
});

test("update_pr forwards reviewers (UUIDs) to the client", async () => {
  const pr = samplePr(7);
  const updatePr = vi.fn(async () => pr);
  const client = makeClientMock({ updatePr });
  const deps = makeDeps({ client });

  await handleUpdatePr(deps, { pr_id: 7, reviewers: ["{abc}", "{def}"] });

  expect(updatePr).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r", prId: 7 },
    { title: undefined, description: undefined, reviewers: ["{abc}", "{def}"] },
  );
});

test("update_pr accepts an empty reviewers array (clear all)", async () => {
  // Empty array is a valid update — it clears all reviewers. The handler must
  // forward it through (not treat it as "no update specified").
  const pr = samplePr(7);
  const updatePr = vi.fn(async () => pr);
  const client = makeClientMock({ updatePr });
  const deps = makeDeps({ client });

  const result = await handleUpdatePr(deps, { pr_id: 7, reviewers: [] });

  expect(result.isError).toBeFalsy();
  expect(updatePr).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r", prId: 7 },
    { title: undefined, description: undefined, reviewers: [] },
  );
});

test("set_pr_draft_state(true) reports 'draft' and forwards args", async () => {
  const updated = samplePr(7, "Hello");
  const setPrDraftState = vi.fn(async () => updated);
  const client = makeClientMock({ setPrDraftState });
  const deps = makeDeps({ client });

  const result = await handleSetPrDraftState(deps, { pr_id: 7, draft: true });

  expect(result.isError).toBeFalsy();
  expect(setPrDraftState).toHaveBeenCalledWith({ workspace: "ws", repo: "r", prId: 7 }, true);
  expect(extractText(result).startsWith("Marked PR #7 as draft")).toBe(true);
});

test("set_pr_draft_state(false) reports 'ready for review'", async () => {
  const updated = samplePr(7, "Hello");
  const setPrDraftState = vi.fn(async () => updated);
  const client = makeClientMock({ setPrDraftState });
  const deps = makeDeps({ client });

  const result = await handleSetPrDraftState(deps, { pr_id: 7, draft: false });

  expect(result.isError).toBeFalsy();
  expect(setPrDraftState).toHaveBeenCalledWith({ workspace: "ws", repo: "r", prId: 7 }, false);
  expect(extractText(result).startsWith("Marked PR #7 as ready for review")).toBe(true);
});

test("set_pr_draft_state infers pr_id from current branch", async () => {
  const setPrDraftState = vi.fn(async () => samplePr(99));
  const listPrs = vi.fn(async () => [samplePr(99)]);
  const client = makeClientMock({ setPrDraftState, listPrs });
  const deps = makeDeps({ client, getBranch: vi.fn(async () => "feature/x") });

  await handleSetPrDraftState(deps, { draft: true });

  expect(setPrDraftState).toHaveBeenCalledWith({ workspace: "ws", repo: "r", prId: 99 }, true);
});

test("resolve_pr_comment defaults resolved=true and forwards id", async () => {
  const resolvedComment = sampleComment(11, "lgtm");
  resolvedComment.resolution = {
    type: "pullrequest_comment_resolution",
    user: { display_name: "Ada" },
    created_on: "2024-01-02T00:00:00Z",
  };
  const resolvePrComment = vi.fn(async () => resolvedComment);
  const client = makeClientMock({ resolvePrComment });
  const deps = makeDeps({ client });

  const result = await handleResolvePrComment(deps, { pr_id: 7, comment_id: 11 });

  expect(result.isError).toBeFalsy();
  expect(resolvePrComment).toHaveBeenCalledWith({ workspace: "ws", repo: "r", prId: 7 }, 11, true);
  expect(extractText(result).startsWith("Marked comment #11 resolved")).toBe(true);
});

test("resolve_pr_comment with resolved=false sends through and reports unresolved", async () => {
  const resolvePrComment = vi.fn(async () => undefined);
  const client = makeClientMock({ resolvePrComment });
  const deps = makeDeps({ client });

  const result = await handleResolvePrComment(deps, {
    pr_id: 7,
    comment_id: 11,
    resolved: false,
  });

  expect(result.isError).toBeFalsy();
  expect(resolvePrComment).toHaveBeenCalledWith({ workspace: "ws", repo: "r", prId: 7 }, 11, false);
  expect(extractText(result)).toBe("Marked comment #11 unresolved");
});

test("reply_to_pr_comment passes parent id through and reports it", async () => {
  const reply = sampleComment(77, "thanks");
  reply.parent = { id: 17 };
  const replyToPrComment = vi.fn(async () => reply);
  const client = makeClientMock({ replyToPrComment });
  const deps = makeDeps({ client });

  const result = await handleReplyToPrComment(deps, {
    pr_id: 7,
    comment_id: 17,
    body: "thanks",
  });

  expect(result.isError).toBeFalsy();
  expect(replyToPrComment).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r", prId: 7 },
    17,
    "thanks",
  );
  expect(extractText(result).startsWith("Posted reply #77 to comment #17")).toBe(true);
});

// ---------- create_pr ----------

test("create_pr defaults source_branch to current git branch and forwards args", async () => {
  const created = samplePr(101, "Add feature");
  const createPr = vi.fn(async () => created);
  const client = makeClientMock({ createPr });
  const deps = makeDeps({ client, getBranch: vi.fn(async () => "feature/x") });

  const result = await handleCreatePr(deps, {
    title: "Add feature",
    description: "**why**",
    destination_branch: "develop",
    close_source_branch: true,
    reviewers: ["{uuid-a}"],
  });

  expect(result.isError).toBeFalsy();
  expect(createPr).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r" },
    {
      title: "Add feature",
      sourceBranch: "feature/x",
      destinationBranch: "develop",
      description: "**why**",
      closeSourceBranch: true,
      reviewers: ["{uuid-a}"],
    },
  );
  expect(extractText(result).startsWith("Created PR #101")).toBe(true);
});

test("create_pr explicit source_branch overrides current branch", async () => {
  const createPr = vi.fn(async () => samplePr(102));
  const client = makeClientMock({ createPr });
  const getBranch = vi.fn(async () => "feature/x");
  const deps = makeDeps({ client, getBranch });

  await handleCreatePr(deps, {
    title: "T",
    source_branch: "explicit/branch",
  });

  expect(getBranch).not.toHaveBeenCalled();
  expect(createPr).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r" },
    { title: "T", sourceBranch: "explicit/branch" },
  );
});

test("create_pr with no source_branch and detached HEAD returns actionable error", async () => {
  const createPr = vi.fn();
  const client = makeClientMock({ createPr });
  const deps = makeDeps({ client, getBranch: vi.fn(async () => null) });

  const result = await handleCreatePr(deps, { title: "T" });

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("source_branch");
  expect(createPr).not.toHaveBeenCalled();
});

test("create_pr surfaces no-repo error when inference fails", async () => {
  const createPr = vi.fn();
  const client = makeClientMock({ createPr });
  const deps = makeDeps({ client, inferRepo: vi.fn(async () => null) });

  const result = await handleCreatePr(deps, { title: "T", source_branch: "feature/x" });

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("Could not determine workspace/repo");
  expect(createPr).not.toHaveBeenCalled();
});

// ---------- Error handling ----------

test("AuthError in handler becomes isError with setup hint", async () => {
  const client = makeClientMock({
    getPr: vi.fn(async () => {
      throw new AuthError("Not authenticated.");
    }),
  });
  const deps = makeDeps({ client });

  const result = await handleGetPr(deps, { pr_id: 7 });

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("Not authenticated.");
  expect(extractText(result)).toContain("bitbucket-mcp setup");
});

test("AuthError with existing setup hint is passed through unchanged", async () => {
  const client = makeClientMock({
    getPr: vi.fn(async () => {
      throw new AuthError("Missing OAuth credentials. Re-run `bitbucket-mcp setup`.");
    }),
  });
  const deps = makeDeps({ client });

  const result = await handleGetPr(deps, { pr_id: 7 });

  expect(result.isError).toBe(true);
  // Should not double-append the hint.
  const text = extractText(result);
  expect(text).toBe("Missing OAuth credentials. Re-run `bitbucket-mcp setup`.");
});

test("BitbucketError 404 produces friendly not-found message", async () => {
  const client = makeClientMock({
    getPr: vi.fn(async () => {
      throw new BitbucketError(
        "Bitbucket API returned 404 for GET https://api.bitbucket.org/2.0/repositories/ws/r/pullrequests/7",
        404,
        "not found",
      );
    }),
  });
  const deps = makeDeps({ client });

  const result = await handleGetPr(deps, { pr_id: 7 });

  expect(result.isError).toBe(true);
  expect(extractText(result).startsWith("Not found (")).toBe(true);
  expect(extractText(result)).toContain("Check the IDs and try again.");
});

test("BitbucketError non-404 includes status and body", async () => {
  const client = makeClientMock({
    getPr: vi.fn(async () => {
      throw new BitbucketError("boom", 503, "oh no");
    }),
  });
  const deps = makeDeps({ client });

  const result = await handleGetPr(deps, { pr_id: 7 });

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("503");
  expect(extractText(result)).toContain("oh no");
});

test("generic Error becomes tool error with message only", async () => {
  const client = makeClientMock({
    getPr: vi.fn(async () => {
      throw new Error("something broke");
    }),
  });
  const deps = makeDeps({ client });

  const result = await handleGetPr(deps, { pr_id: 7 });

  expect(result.isError).toBe(true);
  expect(extractText(result)).toBe("something broke");
});
