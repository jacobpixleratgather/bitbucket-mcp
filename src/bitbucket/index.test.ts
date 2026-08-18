import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { BitbucketError, type BitbucketPr } from "../types.ts";
import {
  BitbucketClient,
  filterDiffByPaths,
  normalizePipelineId,
  normalizeStepUuid,
} from "./index.ts";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

type Scripted = {
  status: number;
  body?: string;
  headers?: Record<string, string>;
};

function makeScriptedFetch(responses: Scripted[]): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let idx = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw !== undefined) {
      if (raw instanceof Headers) {
        raw.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(raw)) {
        for (const [k, v] of raw) {
          headers[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(raw)) {
          headers[k.toLowerCase()] = v as string;
        }
      }
    }
    const rawBody = init?.body;
    let serializedBody: string | undefined;
    if (typeof rawBody === "string") {
      serializedBody = rawBody;
    } else if (rawBody === undefined || rawBody === null) {
      serializedBody = undefined;
    } else {
      // Bodies in these tests are always strings; anything else is unexpected.
      serializedBody = JSON.stringify(rawBody);
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: serializedBody,
    });
    const r = responses[idx] ?? responses[responses.length - 1];
    if (r === undefined) {
      throw new Error("fetch mock: no response configured");
    }
    idx++;
    const resHeaders = new Headers(r.headers ?? {});
    // 204/304 responses must have a null body per the Response spec.
    const noBodyStatus = r.status === 204 || r.status === 304;
    const responseBody = noBodyStatus ? null : (r.body ?? "");
    return new Response(responseBody, {
      status: r.status,
      headers: resHeaders,
    });
  };
  const spy = vi.fn(impl);
  return { fetch: spy as unknown as typeof fetch, calls };
}

const SAMPLE_PR: BitbucketPr = {
  id: 42,
  title: "Add feature",
  state: "OPEN",
  author: { display_name: "Jacob", uuid: "{uuid-jacob}" },
  source: {
    branch: { name: "feature/x" },
    commit: { hash: "deadbeef" },
  },
  destination: {
    branch: { name: "main" },
    commit: { hash: "cafef00d" },
  },
  created_on: "2026-04-20T10:00:00Z",
  updated_on: "2026-04-20T11:00:00Z",
  links: { html: { href: "https://bitbucket.org/ws/repo/pull-requests/42" } },
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------- getPr ----------

test("getPr issues correct URL, method, and bearer header", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 200, body: JSON.stringify(SAMPLE_PR) }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "tok1",
    fetch,
  });
  const pr = await client.getPr({ workspace: "ws", repo: "repo", prId: 42 });
  expect(pr.id).toBe(42);
  expect(calls[0]?.url).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/42");
  expect(calls[0]?.method).toBe("GET");
  expect(calls[0]?.headers["authorization"]).toBe("Bearer tok1");
  expect(calls[0]?.headers["accept"]).toBe("application/json");
});

test("getPr URL-encodes workspace and repo with special characters", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 200, body: JSON.stringify(SAMPLE_PR) }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "tok",
    fetch,
  });
  await client.getPr({
    workspace: "my ws",
    repo: "my/repo",
    prId: 1,
  });
  expect(calls[0]?.url).toBe(
    "https://api.bitbucket.org/2.0/repositories/my%20ws/my%2Frepo/pullrequests/1",
  );
});

test("getPr throws BitbucketError for 404", async () => {
  const { fetch } = makeScriptedFetch([
    { status: 404, body: '{"type":"error","error":{"message":"Not found"}}' },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "tok",
    fetch,
  });
  await expect(client.getPr({ workspace: "ws", repo: "repo", prId: 99 })).rejects.toMatchObject({
    name: "BitbucketError",
    status: 404,
  });
});

// ---------- 401 handling ----------

test("401 triggers onForceRefresh exactly once then retries successfully", async () => {
  const { fetch, calls } = makeScriptedFetch([
    { status: 401, body: "unauthorized" },
    { status: 200, body: JSON.stringify(SAMPLE_PR) },
  ]);
  const tokens = ["old-token", "new-token"];
  const tokenFn = vi.fn(async () => tokens.shift() ?? "new-token");
  const refreshFn = vi.fn(async () => {});
  const client = new BitbucketClient({
    getAccessToken: tokenFn,
    onForceRefresh: refreshFn,
    fetch,
  });
  const pr = await client.getPr({ workspace: "ws", repo: "repo", prId: 42 });
  expect(pr.id).toBe(42);
  expect(refreshFn).toHaveBeenCalledTimes(1);
  expect(calls[0]?.headers["authorization"]).toBe("Bearer old-token");
  expect(calls[1]?.headers["authorization"]).toBe("Bearer new-token");
});

test("401 twice throws BitbucketError, onForceRefresh called once", async () => {
  const { fetch } = makeScriptedFetch([
    { status: 401, body: "unauthorized" },
    { status: 401, body: "still unauthorized" },
  ]);
  const refreshFn = vi.fn(async () => {});
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    onForceRefresh: refreshFn,
    fetch,
  });
  await expect(client.getPr({ workspace: "ws", repo: "repo", prId: 42 })).rejects.toMatchObject({
    name: "BitbucketError",
    status: 401,
  });
  expect(refreshFn).toHaveBeenCalledTimes(1);
});

test("401 without onForceRefresh throws BitbucketError immediately", async () => {
  const { fetch } = makeScriptedFetch([{ status: 401, body: "no" }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await expect(client.getPr({ workspace: "ws", repo: "repo", prId: 1 })).rejects.toBeInstanceOf(
    BitbucketError,
  );
});

// ---------- 429 / 5xx retry ----------

test("429 with Retry-After is respected (fake timers)", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 429,
      body: "slow down",
      headers: { "Retry-After": "2" },
    },
    { status: 200, body: JSON.stringify(SAMPLE_PR) },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const resultPromise = client.getPr({
    workspace: "ws",
    repo: "repo",
    prId: 42,
  });
  // Let the first fetch's promise microtasks run.
  await vi.advanceTimersByTimeAsync(0);
  // Still waiting on the 2-second delay.
  expect(calls).toHaveLength(1);
  // Advance past the Retry-After window.
  await vi.advanceTimersByTimeAsync(2000);
  const result = await resultPromise;
  expect(result.id).toBe(42);
  expect(calls).toHaveLength(2);
});

test("5xx retried up to 3 attempts then throws BitbucketError", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = makeScriptedFetch([
    { status: 502, body: "bad gateway" },
    { status: 502, body: "bad gateway" },
    { status: 502, body: "bad gateway" },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const p = client.getPr({ workspace: "ws", repo: "repo", prId: 42 }).catch((e: unknown) => e);
  // Advance through all backoff intervals.
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(500);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(2000);
  const err = await p;
  expect(err).toBeInstanceOf(BitbucketError);
  expect((err as BitbucketError).status).toBe(502);
  expect(calls).toHaveLength(3);
});

test("5xx then 200 succeeds within attempt budget", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = makeScriptedFetch([
    { status: 500, body: "boom" },
    { status: 200, body: JSON.stringify(SAMPLE_PR) },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const p = client.getPr({ workspace: "ws", repo: "repo", prId: 42 });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(500);
  const pr = await p;
  expect(pr.id).toBe(42);
  expect(calls).toHaveLength(2);
});

// ---------- listPrs + pagination ----------

test("listPrs builds q= filter correctly", async () => {
  const { fetch, calls } = makeScriptedFetch([
    { status: 200, body: JSON.stringify({ values: [SAMPLE_PR] }) },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.listPrs(
    { workspace: "ws", repo: "repo" },
    { state: "OPEN", author: "{uuid}", branch: "feat" },
  );
  const url = new URL(calls[0]?.url ?? "");
  const q = url.searchParams.get("q");
  expect(q).toContain('state="OPEN"');
  expect(q).toContain('author.uuid="{uuid}"');
  expect(q).toContain('source.branch.name="feat"');
  expect(q).toContain(" AND ");
});

test("listPrs follows next pagination link up to limit", async () => {
  const prA: BitbucketPr = { ...SAMPLE_PR, id: 1 };
  const prB: BitbucketPr = { ...SAMPLE_PR, id: 2 };
  const prC: BitbucketPr = { ...SAMPLE_PR, id: 3 };
  const prD: BitbucketPr = { ...SAMPLE_PR, id: 4 };
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 200,
      body: JSON.stringify({
        values: [prA, prB],
        next: "https://api.bitbucket.org/2.0/page2",
      }),
    },
    {
      status: 200,
      body: JSON.stringify({
        values: [prC, prD],
      }),
    },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const prs = await client.listPrs({ workspace: "ws", repo: "repo" }, { limit: 10 });
  expect(prs.map((p) => p.id)).toEqual([1, 2, 3, 4]);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.url).toBe("https://api.bitbucket.org/2.0/page2");
});

test("listPrs stops when limit reached across pages", async () => {
  const prA: BitbucketPr = { ...SAMPLE_PR, id: 1 };
  const prB: BitbucketPr = { ...SAMPLE_PR, id: 2 };
  const prC: BitbucketPr = { ...SAMPLE_PR, id: 3 };
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 200,
      body: JSON.stringify({
        values: [prA, prB],
        next: "https://api.bitbucket.org/2.0/page2",
      }),
    },
    {
      status: 200,
      body: JSON.stringify({ values: [prC] }),
    },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const prs = await client.listPrs(
    { workspace: "ws", repo: "repo" },
    {
      limit: 2,
    },
  );
  expect(prs).toHaveLength(2);
  // Second page should not have been fetched.
  expect(calls).toHaveLength(1);
});

// ---------- getPrDiff ----------

test("getPrDiff returns raw text with accept */*", async () => {
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 200,
      body: "diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new\n",
    },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const diff = await client.getPrDiff({
    workspace: "ws",
    repo: "repo",
    prId: 42,
  });
  expect(diff.startsWith("diff --git")).toBe(true);
  expect(calls[0]?.url).toBe(
    "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/42/diff",
  );
  expect(calls[0]?.headers["accept"]).toBe("*/*");
});

// ---------- listPrComments ----------

test("listPrComments paginates correctly", async () => {
  const mk = (id: number) => ({
    id,
    content: { raw: `c${id}` },
    user: { display_name: "u", uuid: "x" },
    created_on: "2026-04-20T00:00:00Z",
    updated_on: "2026-04-20T00:00:00Z",
  });
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 200,
      body: JSON.stringify({
        values: [mk(1), mk(2)],
        next: "https://api.bitbucket.org/2.0/comments/p2",
      }),
    },
    { status: 200, body: JSON.stringify({ values: [mk(3)] }) },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const comments = await client.listPrComments({
    workspace: "ws",
    repo: "repo",
    prId: 42,
  });
  expect(comments.map((c) => c.id)).toEqual([1, 2, 3]);
  expect(calls).toHaveLength(2);
});

// ---------- addPrComment ----------

test("addPrComment posts correct body", async () => {
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 201,
      body: JSON.stringify({
        id: 7,
        content: { raw: "hi" },
        user: { display_name: "u", uuid: "x" },
        created_on: "2026-04-20T00:00:00Z",
        updated_on: "2026-04-20T00:00:00Z",
      }),
    },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const comment = await client.addPrComment({ workspace: "ws", repo: "repo", prId: 42 }, "hi");
  expect(comment.id).toBe(7);
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
    content: { raw: "hi" },
  });
});

// ---------- replyToPrComment ----------

test("replyToPrComment posts body with parent.id", async () => {
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 201,
      body: JSON.stringify({
        id: 21,
        content: { raw: "thanks, fixed" },
        user: { display_name: "u", uuid: "x" },
        created_on: "2026-04-21T00:00:00Z",
        updated_on: "2026-04-21T00:00:00Z",
        parent: { id: 17 },
      }),
    },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const reply = await client.replyToPrComment(
    { workspace: "ws", repo: "repo", prId: 42 },
    17,
    "thanks, fixed",
  );
  expect(reply.id).toBe(21);
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.url).toBe(
    "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/42/comments",
  );
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
    content: { raw: "thanks, fixed" },
    parent: { id: 17 },
  });
});

// ---------- addPrInlineComment ----------

test('addPrInlineComment side="new" uses inline.to', async () => {
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 201,
      body: JSON.stringify({
        id: 8,
        content: { raw: "review" },
        user: { display_name: "u", uuid: "x" },
        created_on: "2026-04-20T00:00:00Z",
        updated_on: "2026-04-20T00:00:00Z",
        inline: { path: "src/foo.ts", to: 10 },
      }),
    },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.addPrInlineComment(
    { workspace: "ws", repo: "repo", prId: 42 },
    { body: "review", path: "src/foo.ts", line: 10 },
  );
  const body = JSON.parse(calls[0]?.body ?? "");
  expect(body).toEqual({
    content: { raw: "review" },
    inline: { path: "src/foo.ts", to: 10 },
  });
});

test('addPrInlineComment side="old" uses inline.from', async () => {
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 201,
      body: JSON.stringify({
        id: 9,
        content: { raw: "review" },
        user: { display_name: "u", uuid: "x" },
        created_on: "2026-04-20T00:00:00Z",
        updated_on: "2026-04-20T00:00:00Z",
        inline: { path: "src/foo.ts", from: 5 },
      }),
    },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.addPrInlineComment(
    { workspace: "ws", repo: "repo", prId: 42 },
    { body: "review", path: "src/foo.ts", line: 5, side: "old" },
  );
  const body = JSON.parse(calls[0]?.body ?? "");
  expect(body).toEqual({
    content: { raw: "review" },
    inline: { path: "src/foo.ts", from: 5 },
  });
});

// ---------- createPr ----------

test("createPr POSTs minimal body with source branch only", async () => {
  const { fetch, calls } = makeScriptedFetch([
    { status: 201, body: JSON.stringify({ ...SAMPLE_PR, id: 99, title: "New PR" }) },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const created = await client.createPr(
    { workspace: "ws", repo: "repo" },
    { title: "New PR", sourceBranch: "feature/x" },
  );
  expect(created.id).toBe(99);
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.url).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests");
  expect(calls[0]?.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
    title: "New PR",
    source: { branch: { name: "feature/x" } },
  });
});

test("createPr forwards destination, description, close_source_branch, reviewers", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 201, body: JSON.stringify(SAMPLE_PR) }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.createPr(
    { workspace: "ws", repo: "repo" },
    {
      title: "Add feature",
      sourceBranch: "feature/x",
      destinationBranch: "develop",
      description: "**why**",
      closeSourceBranch: true,
      reviewers: ["{uuid-a}", "{uuid-b}"],
    },
  );
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
    title: "Add feature",
    source: { branch: { name: "feature/x" } },
    destination: { branch: { name: "develop" } },
    description: "**why**",
    close_source_branch: true,
    reviewers: [{ uuid: "{uuid-a}" }, { uuid: "{uuid-b}" }],
  });
});

test("createPr passes description as a plain string, never wrapped in { raw }", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 201, body: JSON.stringify(SAMPLE_PR) }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.createPr(
    { workspace: "ws", repo: "repo" },
    { title: "T", sourceBranch: "feature/x", description: "**bold** body" },
  );
  const sent = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
  expect(typeof sent.description).toBe("string");
  expect(sent.description).toBe("**bold** body");
});

test("createPr with empty reviewers array omits the reviewers key", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 201, body: JSON.stringify(SAMPLE_PR) }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.createPr(
    { workspace: "ws", repo: "repo" },
    { title: "T", sourceBranch: "feature/x", reviewers: [] },
  );
  const sent = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
  expect(sent).not.toHaveProperty("reviewers");
});

// ---------- updatePr ----------

test("updatePr sends PUT with both title and description as a plain string", async () => {
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 200,
      body: JSON.stringify({ ...SAMPLE_PR, title: "New title" }),
    },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const updated = await client.updatePr(
    { workspace: "ws", repo: "repo", prId: 42 },
    { title: "New title", description: "New body" },
  );
  expect(updated.title).toBe("New title");
  expect(calls[0]?.method).toBe("PUT");
  expect(calls[0]?.url).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/42");
  expect(calls[0]?.headers["content-type"]).toBe("application/json");
  // Bitbucket Cloud's PR PUT endpoint expects `description` as a plain string.
  // Sending the nested `{ raw }` shape (used by the comments API) caused the
  // literal object to leak into the rendered PR description.
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
    title: "New title",
    description: "New body",
  });
});

test("updatePr with title only sends partial body (no description key)", async () => {
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 200,
      body: JSON.stringify({ ...SAMPLE_PR, title: "Only title" }),
    },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.updatePr({ workspace: "ws", repo: "repo", prId: 42 }, { title: "Only title" });
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ title: "Only title" });
});

test("updatePr with description only sends a plain string, no title key", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 200, body: JSON.stringify(SAMPLE_PR) }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.updatePr(
    { workspace: "ws", repo: "repo", prId: 42 },
    { description: "Just markdown" },
  );
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
    description: "Just markdown",
  });
});

test("updatePr passes the description verbatim — never wraps it in { raw }", async () => {
  // Regression: the previous implementation wrapped description as `{ raw }`,
  // which Bitbucket Cloud rejects/serialises as the literal object. Guard the
  // exact wire shape so this can't regress.
  const { fetch, calls } = makeScriptedFetch([{ status: 200, body: JSON.stringify(SAMPLE_PR) }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.updatePr(
    { workspace: "ws", repo: "repo", prId: 42 },
    { description: "**bold** and a paragraph" },
  );
  const sentBody = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
  expect(typeof sentBody.description).toBe("string");
  expect(sentBody.description).toBe("**bold** and a paragraph");
});

test("updatePr with reviewers maps UUIDs to { uuid } objects", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 200, body: JSON.stringify(SAMPLE_PR) }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.updatePr(
    { workspace: "ws", repo: "repo", prId: 42 },
    { reviewers: ["{abc-123}", "{def-456}"] },
  );
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
    reviewers: [{ uuid: "{abc-123}" }, { uuid: "{def-456}" }],
  });
});

test("updatePr with an empty reviewers array still sends [] (clear all)", async () => {
  // Passing an empty array is the documented way to clear reviewers.
  // Distinct from omitting the field, which leaves them unchanged.
  const { fetch, calls } = makeScriptedFetch([{ status: 200, body: JSON.stringify(SAMPLE_PR) }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.updatePr({ workspace: "ws", repo: "repo", prId: 42 }, { reviewers: [] });
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ reviewers: [] });
});

test("updatePr combines title, description, and reviewers in one PUT", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 200, body: JSON.stringify(SAMPLE_PR) }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.updatePr(
    { workspace: "ws", repo: "repo", prId: 42 },
    { title: "T", description: "D", reviewers: ["{u}"] },
  );
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
    title: "T",
    description: "D",
    reviewers: [{ uuid: "{u}" }],
  });
});

// ---------- setPrDraftState ----------

test("setPrDraftState(true) PUTs { draft: true } and nothing else", async () => {
  const { fetch, calls } = makeScriptedFetch([
    { status: 200, body: JSON.stringify({ ...SAMPLE_PR }) },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.setPrDraftState({ workspace: "ws", repo: "repo", prId: 42 }, true);
  expect(calls[0]?.method).toBe("PUT");
  expect(calls[0]?.url).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/42");
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ draft: true });
});

test("setPrDraftState(false) PUTs { draft: false }", async () => {
  const { fetch, calls } = makeScriptedFetch([
    { status: 200, body: JSON.stringify({ ...SAMPLE_PR }) },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await client.setPrDraftState({ workspace: "ws", repo: "repo", prId: 42 }, false);
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ draft: false });
});

// ---------- resolvePrComment ----------

test("resolvePrComment(true) POSTs to /resolve and returns parsed body", async () => {
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 200,
      body: JSON.stringify({
        id: 5,
        content: { raw: "lgtm" },
        user: { display_name: "u", uuid: "x" },
        created_on: "2026-04-20T00:00:00Z",
        updated_on: "2026-04-20T00:00:00Z",
        resolution: {
          type: "pullrequest_comment_resolution",
          user: { display_name: "u" },
          created_on: "2026-04-20T00:01:00Z",
        },
      }),
    },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const out = await client.resolvePrComment({ workspace: "ws", repo: "repo", prId: 42 }, 5, true);
  expect(out?.id).toBe(5);
  expect(out?.resolution).not.toBeNull();
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.url).toBe(
    "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/42/comments/5/resolve",
  );
  expect(calls[0]?.body).toBeUndefined();
});

test("resolvePrComment(false) issues DELETE and returns undefined for 204", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 204, body: "" }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const out = await client.resolvePrComment({ workspace: "ws", repo: "repo", prId: 42 }, 5, false);
  expect(out).toBeUndefined();
  expect(calls[0]?.method).toBe("DELETE");
  expect(calls[0]?.url).toBe(
    "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/42/comments/5/resolve",
  );
});

// ---------- pipeline discovery ----------

function samplePipeline(
  overrides: {
    uuid?: string;
    build_number?: number;
    created_on?: string;
    commit?: string;
    prId?: number;
    result?: string;
  } = {},
): unknown {
  return {
    uuid: overrides.uuid ?? "{uuid-A}",
    build_number: overrides.build_number ?? 101,
    state: {
      name: "COMPLETED",
      result: { name: overrides.result ?? "SUCCESSFUL" },
    },
    created_on: overrides.created_on ?? "2026-04-20T10:00:00Z",
    trigger: { name: "PUSH" },
    target: {
      ref_name: "feature/x",
      commit: { hash: overrides.commit ?? "deadbeef" },
      selector: { type: "branches", pattern: "feature/*" },
      ...(overrides.prId !== undefined ? { pullrequest: { id: overrides.prId } } : {}),
    },
  };
}

const SAMPLE_STEPS = [
  {
    uuid: "{step-1}",
    name: "build",
    state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
    duration_in_seconds: 42,
  },
];

test("findPipelinesForPr matches the PR head commit and attaches steps", async () => {
  const matching = samplePipeline({ uuid: "{uuid-A}", commit: "deadbeef" });
  const other = samplePipeline({
    uuid: "{uuid-B}",
    build_number: 102,
    created_on: "2026-04-20T11:00:00Z",
    commit: "otherhash",
  });
  const { fetch, calls } = makeScriptedFetch([
    { status: 200, body: JSON.stringify(SAMPLE_PR) },
    { status: 200, body: JSON.stringify({ values: [other, matching] }) },
    { status: 200, body: JSON.stringify({ values: SAMPLE_STEPS }) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const lookup = await client.findPipelinesForPr({
    workspace: "ws",
    repo: "repo",
    prId: 42,
  });

  expect(calls[0]?.url).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/42");
  const plUrl = new URL(calls[1]?.url ?? "");
  expect(plUrl.pathname).toBe("/2.0/repositories/ws/repo/pipelines/");
  expect(plUrl.searchParams.get("target.branch")).toBe("feature/x");
  expect(plUrl.searchParams.get("sort")).toBe("-created_on");
  expect(calls[2]?.url).toBe(
    `https://api.bitbucket.org/2.0/repositories/ws/repo/pipelines/${encodeURIComponent(
      "{uuid-A}",
    )}/steps/`,
  );
  expect(lookup.match).toBe("pr_head_commit");
  expect(lookup.branch).toBe("feature/x");
  expect(lookup.commit).toBe("deadbeef");
  expect(lookup.pipelines).toHaveLength(1);
  expect(lookup.pipelines[0]?.pipeline.uuid).toBe("{uuid-A}");
  expect(lookup.pipelines[0]?.steps).toHaveLength(1);
});

test("findPipelinesForPr matches a PR-triggered pipeline even on a different commit", async () => {
  const prTriggered = samplePipeline({ uuid: "{uuid-pr}", commit: "feedface", prId: 42 });
  const { fetch } = makeScriptedFetch([
    { status: 200, body: JSON.stringify(SAMPLE_PR) },
    { status: 200, body: JSON.stringify({ values: [prTriggered] }) },
    { status: 200, body: JSON.stringify({ values: SAMPLE_STEPS }) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const lookup = await client.findPipelinesForPr({ workspace: "ws", repo: "repo", prId: 42 });

  expect(lookup.match).toBe("pr_head_commit");
  expect(lookup.pipelines[0]?.pipeline.uuid).toBe("{uuid-pr}");
});

test("findPipelinesForPr falls back to the branch when no pipeline matches the PR", async () => {
  // The repo builds on branch push only: pipelines exist for the branch but
  // none is PR-attributable and none built the PR's head commit.
  const older = samplePipeline({ uuid: "{uuid-old}", commit: "1111111111", build_number: 100 });
  const newer = samplePipeline({
    uuid: "{uuid-new}",
    commit: "2222222222",
    build_number: 103,
    created_on: "2026-04-20T12:00:00Z",
  });
  const { fetch } = makeScriptedFetch([
    { status: 200, body: JSON.stringify(SAMPLE_PR) },
    { status: 200, body: JSON.stringify({ values: [older, newer] }) },
    { status: 200, body: JSON.stringify({ values: SAMPLE_STEPS }) },
    { status: 200, body: JSON.stringify({ values: SAMPLE_STEPS }) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const lookup = await client.findPipelinesForPr({ workspace: "ws", repo: "repo", prId: 42 });

  expect(lookup.match).toBe("branch_fallback");
  expect(lookup.branch).toBe("feature/x");
  expect(lookup.commit).toBe("deadbeef");
  // Newest first.
  expect(lookup.pipelines.map((e) => e.pipeline.uuid)).toEqual(["{uuid-new}", "{uuid-old}"]);
});

test("findPipelinesForPr reports none when the branch has no pipelines", async () => {
  const { fetch } = makeScriptedFetch([
    { status: 200, body: JSON.stringify(SAMPLE_PR) },
    { status: 200, body: JSON.stringify({ values: [] }) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const lookup = await client.findPipelinesForPr({ workspace: "ws", repo: "repo", prId: 42 });

  expect(lookup.match).toBe("none");
  expect(lookup.pipelines).toEqual([]);
});

test("findPipelinesForCommit filters server-side for a full hash", async () => {
  const full = "a".repeat(40);
  const { fetch, calls } = makeScriptedFetch([
    { status: 200, body: JSON.stringify({ values: [samplePipeline({ commit: full })] }) },
    { status: 200, body: JSON.stringify({ values: SAMPLE_STEPS }) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const lookup = await client.findPipelinesForCommit({ workspace: "ws", repo: "repo" }, full);

  const url = new URL(calls[0]?.url ?? "");
  expect(url.searchParams.get("target.commit.hash")).toBe(full);
  expect(lookup.match).toBe("commit");
  expect(lookup.pipelines).toHaveLength(1);
});

test("findPipelinesForCommit prefix-matches a short hash client-side", async () => {
  const full = "abcdef1234567890abcdef1234567890abcdef12";
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 200,
      body: JSON.stringify({
        values: [samplePipeline({ commit: "999999999999" }), samplePipeline({ commit: full })],
      }),
    },
    { status: 200, body: JSON.stringify({ values: SAMPLE_STEPS }) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const lookup = await client.findPipelinesForCommit(
    { workspace: "ws", repo: "repo" },
    "abcdef12345",
  );

  // Short hashes can't be filtered server-side, so no commit param is sent.
  const url = new URL(calls[0]?.url ?? "");
  expect(url.searchParams.get("target.commit.hash")).toBeNull();
  expect(lookup.match).toBe("commit");
  expect(lookup.pipelines).toHaveLength(1);
  expect(lookup.pipelines[0]?.pipeline.target?.commit?.hash).toBe(full);
});

test("findPipelinesForCommit reports none when nothing built the commit", async () => {
  const { fetch } = makeScriptedFetch([
    // Server-side filter finds nothing, then the client-side scan finds no
    // pipeline whose commit matches either.
    { status: 200, body: JSON.stringify({ values: [] }) },
    { status: 200, body: JSON.stringify({ values: [samplePipeline({ commit: "cafecafecafe" })] }) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const lookup = await client.findPipelinesForCommit(
    { workspace: "ws", repo: "repo" },
    "b".repeat(40),
  );

  expect(lookup.match).toBe("none");
  expect(lookup.pipelines).toEqual([]);
});

test("listPipelines scopes by branch and can skip steps", async () => {
  const { fetch, calls } = makeScriptedFetch([
    { status: 200, body: JSON.stringify({ values: [samplePipeline()] }) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const out = await client.listPipelines(
    { workspace: "ws", repo: "repo" },
    { branch: "main", limit: 3, withSteps: false },
  );

  const url = new URL(calls[0]?.url ?? "");
  expect(url.searchParams.get("target.branch")).toBe("main");
  expect(url.searchParams.get("pagelen")).toBe("3");
  expect(calls).toHaveLength(1);
  expect(out[0]?.steps).toEqual([]);
});

test("getPipeline accepts a build number in the uuid slot", async () => {
  const { fetch, calls } = makeScriptedFetch([
    { status: 200, body: JSON.stringify(samplePipeline({ build_number: 27419 })) },
    { status: 200, body: JSON.stringify({ values: SAMPLE_STEPS }) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const entry = await client.getPipeline({ workspace: "ws", repo: "repo" }, "27419");

  expect(calls[0]?.url).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/pipelines/27419");
  expect(entry.pipeline.build_number).toBe(27419);
  expect(entry.steps).toHaveLength(1);
});

// ---------- triggerPipeline ----------

test("triggerPipeline posts a branch ref target", async () => {
  const { fetch, calls } = makeScriptedFetch([
    { status: 201, body: JSON.stringify(samplePipeline({ build_number: 27420 })) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const pipeline = await client.triggerPipeline(
    { workspace: "ws", repo: "repo" },
    { branch: "feature/x" },
  );

  expect(calls[0]?.url).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/pipelines/");
  expect(calls[0]?.method).toBe("POST");
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
    target: { type: "pipeline_ref_target", ref_type: "branch", ref_name: "feature/x" },
  });
  expect(pipeline.build_number).toBe(27420);
});

test("triggerPipeline posts commit, custom selector, and variables", async () => {
  const { fetch, calls } = makeScriptedFetch([
    { status: 201, body: JSON.stringify(samplePipeline()) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  await client.triggerPipeline(
    { workspace: "ws", repo: "repo" },
    {
      branch: "main",
      commit: "abc1234",
      customPipeline: "Deploy to production",
      variables: [{ key: "K", value: "V", secured: true }],
    },
  );

  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
    target: {
      type: "pipeline_ref_target",
      ref_type: "branch",
      ref_name: "main",
      commit: { type: "commit", hash: "abc1234" },
      selector: { type: "custom", pattern: "Deploy to production" },
    },
    variables: [{ key: "K", value: "V", secured: true }],
  });
});

// ---------- commit statuses ----------

test("getCommitStatuses hits the commit statuses endpoint", async () => {
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 200,
      body: JSON.stringify({
        values: [{ key: "PIPELINE", state: "SUCCESSFUL", name: "Pipeline #1" }],
      }),
    },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const statuses = await client.getCommitStatuses({ workspace: "ws", repo: "repo" }, "abc123");

  const url = new URL(calls[0]?.url ?? "");
  expect(url.pathname).toBe("/2.0/repositories/ws/repo/commit/abc123/statuses");
  expect(statuses[0]?.state).toBe("SUCCESSFUL");
});

test("getPrStatuses hits the PR statuses endpoint", async () => {
  const { fetch, calls } = makeScriptedFetch([
    { status: 200, body: JSON.stringify({ values: [{ key: "PIPELINE", state: "FAILED" }] }) },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const statuses = await client.getPrStatuses({ workspace: "ws", repo: "repo", prId: 42 });

  const url = new URL(calls[0]?.url ?? "");
  expect(url.pathname).toBe("/2.0/repositories/ws/repo/pullrequests/42/statuses");
  expect(statuses[0]?.state).toBe("FAILED");
});

// ---------- getPipelineStepLog ----------

test("getPipelineStepLog returns plain text with correct URL", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 200, body: "build output\nmore lines\n" }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const log = await client.getPipelineStepLog(
    { workspace: "ws", repo: "repo" },
    "{pipeline}",
    "{step}",
  );
  expect(log).toBe("build output\nmore lines\n");
  expect(calls[0]?.url).toBe(
    `https://api.bitbucket.org/2.0/repositories/ws/repo/pipelines/${encodeURIComponent(
      "{pipeline}",
    )}/steps/${encodeURIComponent("{step}")}/log`,
  );
  expect(calls[0]?.headers["accept"]).toBe("*/*");
});

test("getPipelineStepLog 404 throws helpful BitbucketError", async () => {
  const { fetch } = makeScriptedFetch([{ status: 404, body: "log not found" }]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  await expect(
    client.getPipelineStepLog({ workspace: "ws", repo: "repo" }, "{pipe}", "{step}"),
  ).rejects.toMatchObject({
    name: "BitbucketError",
    status: 404,
  });
  await expect(
    client.getPipelineStepLog({ workspace: "ws", repo: "repo" }, "{pipe}", "{step}"),
  ).rejects.toThrow(/no log available/);
});

// ---------- diff path filtering & diffstat ----------

const TWO_FILE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-a",
  "+A",
  "diff --git a/docs/b.md b/docs/b.md",
  "--- a/docs/b.md",
  "+++ b/docs/b.md",
  "@@ -1 +1 @@",
  "-b",
  "+B",
  "",
].join("\n");

test("getPrDiff filters by path client-side, not via the endpoint's path param", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 200, body: TWO_FILE_DIFF }]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const diff = await client.getPrDiff(
    { workspace: "ws", repo: "repo", prId: 42 },
    { paths: ["src", "nope/x.ts"] },
  );

  // Bitbucket's `path` param only matches whole files: sending a directory
  // there returns an empty diff, so we never send it.
  const url = new URL(calls[0]?.url ?? "");
  expect(url.searchParams.getAll("path")).toEqual([]);
  expect(url.pathname).toBe("/2.0/repositories/ws/repo/pullrequests/42/diff");
  expect(diff).toContain("src/a.ts");
  expect(diff).not.toContain("docs/b.md");
});

test("getPrDiffStat paginates the diffstat endpoint", async () => {
  const { fetch, calls } = makeScriptedFetch([
    {
      status: 200,
      body: JSON.stringify({
        values: [
          { status: "modified", lines_added: 3, lines_removed: 1, new: { path: "src/a.ts" } },
        ],
      }),
    },
  ]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  const stat = await client.getPrDiffStat({ workspace: "ws", repo: "repo", prId: 42 });

  const url = new URL(calls[0]?.url ?? "");
  expect(url.pathname).toBe("/2.0/repositories/ws/repo/pullrequests/42/diffstat");
  expect(stat[0]?.lines_added).toBe(3);
});

test("filterDiffByPaths matches exact files, directory prefixes, and quoted paths", () => {
  expect(filterDiffByPaths(TWO_FILE_DIFF, ["docs/b.md"])).toBe(
    [
      "diff --git a/docs/b.md b/docs/b.md",
      "--- a/docs/b.md",
      "+++ b/docs/b.md",
      "@@ -1 +1 @@",
      "-b",
      "+B",
      "",
    ].join("\n"),
  );
  expect(filterDiffByPaths(TWO_FILE_DIFF, ["docs/"])).toContain("docs/b.md");
  expect(filterDiffByPaths(TWO_FILE_DIFF, ["./src"])).toContain("src/a.ts");
  expect(filterDiffByPaths(TWO_FILE_DIFF, ["missing"])).toBe("");
  const quoted = 'diff --git "a/src/my file.ts" "b/src/my file.ts"\n+x\n';
  expect(filterDiffByPaths(quoted, ["src/my file.ts"])).toContain("my file.ts");
});

// ---------- id normalization ----------

test("normalizePipelineId passes build numbers through and braces bare UUIDs", () => {
  expect(normalizePipelineId("27419")).toBe("27419");
  expect(normalizePipelineId(" {a1b2c3d4-1111-2222-3333-444455556666} ")).toBe(
    "{a1b2c3d4-1111-2222-3333-444455556666}",
  );
  expect(normalizePipelineId("a1b2c3d4-1111-2222-3333-444455556666")).toBe(
    "{a1b2c3d4-1111-2222-3333-444455556666}",
  );
});

test("getPipelineStepLog braces a bare step UUID", async () => {
  const { fetch, calls } = makeScriptedFetch([{ status: 200, body: "output" }]);
  const client = new BitbucketClient({ getAccessToken: async () => "t", fetch });

  await client.getPipelineStepLog(
    { workspace: "ws", repo: "repo" },
    "27419",
    "a1b2c3d4-1111-2222-3333-444455556666",
  );

  expect(calls[0]?.url).toBe(
    `https://api.bitbucket.org/2.0/repositories/ws/repo/pipelines/27419/steps/${encodeURIComponent(
      "{a1b2c3d4-1111-2222-3333-444455556666}",
    )}/log`,
  );
  expect(normalizeStepUuid("{x}")).toBe("{x}");
});
