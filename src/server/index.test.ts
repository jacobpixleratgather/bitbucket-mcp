import { expect, test, vi } from "vite-plus/test";
import { BitbucketClient } from "../bitbucket/index.ts";
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
import {
  createServer,
  handleAddPrComment,
  handleAddPrInlineComment,
  handleCreatePr,
  handleGetPipelineStepLog,
  handleGetPr,
  handleGetPrDiff,
  handleGetPrPipelineStatus,
  handleListPrComments,
  handleListPrs,
  handleReplyToPrComment,
  handleResolvePrComment,
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
    listPrComments: vi.fn(),
    addPrComment: vi.fn(),
    addPrInlineComment: vi.fn(),
    createPr: vi.fn(),
    getPrPipelineStatus: vi.fn(),
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
    cwd?: string;
  } = {},
): HandlerDeps {
  return {
    client: opts.client ?? makeClientMock(),
    inferRepo: opts.inferRepo ?? vi.fn(async () => ({ workspace: "ws", repo: "r" })),
    getBranch: opts.getBranch ?? vi.fn(async () => "feature/x"),
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

test("createServer registers the 13 expected tools", () => {
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
      "get_pipeline_step_log",
      "get_pr",
      "get_pr_diff",
      "get_pr_pipeline_status",
      "list_pr_comments",
      "list_prs",
      "reply_to_pr_comment",
      "resolve_pr_comment",
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
  const client = makeClientMock({ getPrDiff: vi.fn(async () => diff) });
  const deps = makeDeps({ client });

  const result = await handleGetPrDiff(deps, { pr_id: 7 });

  expect(result.isError).toBeFalsy();
  expect(extractText(result)).toBe(diff);
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

test("get_pr_pipeline_status returns flat structured list", async () => {
  const pipeline: BitbucketPipeline = {
    uuid: "{pipe}",
    build_number: 17,
    state: { name: "COMPLETED", result: { name: "FAILED" } },
    created_on: "2024-01-03T00:00:00Z",
  };
  const step: BitbucketStep = {
    uuid: "{step}",
    name: "Test",
    state: { name: "COMPLETED", result: { name: "FAILED" } },
    started_on: "2024-01-03T00:00:05Z",
    completed_on: "2024-01-03T00:01:00Z",
  };
  const client = makeClientMock({
    getPrPipelineStatus: vi.fn(async () => [{ pipeline, steps: [step] }]),
  });
  const deps = makeDeps({ client });

  const result = await handleGetPrPipelineStatus(deps, { pr_id: 7 });
  const parsed = JSON.parse(extractText(result));

  expect(parsed).toEqual([
    {
      pipeline_uuid: "{pipe}",
      build_number: 17,
      state: "COMPLETED",
      result: "FAILED",
      created_on: "2024-01-03T00:00:00Z",
      steps: [
        {
          uuid: "{step}",
          name: "Test",
          state: "COMPLETED",
          result: "FAILED",
          started_on: "2024-01-03T00:00:05Z",
          completed_on: "2024-01-03T00:01:00Z",
        },
      ],
    },
  ]);
});

test("get_pipeline_step_log calls client with correct args and returns text", async () => {
  const getPipelineStepLog = vi.fn(async () => "log text\n");
  const client = makeClientMock({ getPipelineStepLog });
  const deps = makeDeps({ client });

  const result = await handleGetPipelineStepLog(deps, {
    pipeline_uuid: "{pipe}",
    step_uuid: "{step}",
  });

  expect(result.isError).toBeFalsy();
  expect(extractText(result)).toBe("log text\n");
  expect(getPipelineStepLog).toHaveBeenCalledWith(
    { workspace: "ws", repo: "r" },
    "{pipe}",
    "{step}",
  );
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

test("update_pr requires at least one of title/description", async () => {
  const updatePr = vi.fn();
  const client = makeClientMock({ updatePr });
  const deps = makeDeps({ client });

  const result = await handleUpdatePr(deps, { pr_id: 7 });

  expect(result.isError).toBe(true);
  expect(extractText(result)).toContain("Pass at least one of `title` or `description`");
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
    { title: "New title", description: "Refreshed body" },
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
    { title: undefined, description: "Just the body" },
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
