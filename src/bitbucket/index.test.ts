import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { BitbucketError, type BitbucketPr } from "../types.ts";
import { BitbucketClient } from "./index.ts";

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
    return new Response(r.body ?? "", {
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

// ---------- getPrPipelineStatus ----------

test("getPrPipelineStatus makes the right sequence of calls", async () => {
  const pipelineA = {
    uuid: "{uuid-A}",
    build_number: 101,
    state: { name: "COMPLETED" },
    created_on: "2026-04-20T10:00:00Z",
    target: {
      ref_name: "feature/x",
      commit: { hash: "deadbeef" },
    },
  };
  const pipelineB = {
    uuid: "{uuid-B}",
    build_number: 102,
    state: { name: "IN_PROGRESS" },
    created_on: "2026-04-20T11:00:00Z",
    target: {
      ref_name: "feature/x",
      commit: { hash: "otherhash" }, // should be filtered out
    },
  };
  const stepsA = [
    {
      uuid: "{step-1}",
      name: "build",
      state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
    },
  ];
  const { fetch, calls } = makeScriptedFetch([
    { status: 200, body: JSON.stringify(SAMPLE_PR) },
    {
      status: 200,
      body: JSON.stringify({ values: [pipelineB, pipelineA] }),
    },
    { status: 200, body: JSON.stringify({ values: stepsA }) },
  ]);
  const client = new BitbucketClient({
    getAccessToken: async () => "t",
    fetch,
  });
  const result = await client.getPrPipelineStatus({
    workspace: "ws",
    repo: "repo",
    prId: 42,
  });

  // Call 1: get PR.
  expect(calls[0]?.url).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/42");
  // Call 2: list pipelines for the PR's source branch, newest first.
  const plUrl = new URL(calls[1]?.url ?? "");
  expect(plUrl.pathname).toBe("/2.0/repositories/ws/repo/pipelines/");
  expect(plUrl.searchParams.get("target.branch")).toBe("feature/x");
  expect(plUrl.searchParams.get("sort")).toBe("-created_on");
  // Call 3: steps for pipelineA only (commit matches PR head).
  expect(calls[2]?.url).toBe(
    `https://api.bitbucket.org/2.0/repositories/ws/repo/pipelines/${encodeURIComponent(
      "{uuid-A}",
    )}/steps/`,
  );
  expect(result).toHaveLength(1);
  expect(result[0]?.pipeline.uuid).toBe("{uuid-A}");
  expect(result[0]?.steps).toHaveLength(1);
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
