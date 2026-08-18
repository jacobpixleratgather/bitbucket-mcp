import {
  BitbucketError,
  type BitbucketComment,
  type BitbucketCommitStatus,
  type BitbucketDiffstat,
  type BitbucketPipeline,
  type BitbucketPr,
  type BitbucketStep,
  type PipelineLookup,
  type PipelineVariable,
  type PipelineWithSteps,
  type PrTarget,
  type RepoTarget,
  type TokenProvider,
} from "../types.ts";

const BASE_URL = "https://api.bitbucket.org/2.0";

const DEFAULT_PR_LIMIT = 50;
const DEFAULT_COMMENT_LIMIT = 100;
const DEFAULT_DIFFSTAT_LIMIT = 300;
const DEFAULT_PIPELINE_LIMIT = 5;
const DEFAULT_STATUS_LIMIT = 50;
// How many recent pipelines on a branch to scan when looking for one that
// matches a specific commit. Bitbucket's `target.commit.hash` filter needs a
// full 40-char hash, so short hashes are matched client-side over this window.
const PIPELINE_SCAN_WINDOW = 50;
const PAGINATION_HARD_CAP = 500;

const MAX_BACKOFF_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;

type FetchLike = typeof fetch;

type RequestOptions = {
  method?: string;
  // Additional headers (Authorization is always set automatically).
  headers?: Record<string, string>;
  // For JSON bodies.
  json?: unknown;
  // Plain-text body (not currently used).
  body?: string;
  // Acceptable response content-type. Defaults to application/json.
  accept?: string;
  // When true, response is returned as text instead of parsed JSON.
  asText?: boolean;
};

type BitbucketPage<T> = {
  values: T[];
  next?: string;
  // Other page fields are unused here.
};

export type BitbucketClientOptions = {
  getAccessToken: TokenProvider;
  onForceRefresh?: () => Promise<void>;
  fetch?: FetchLike;
};

export class BitbucketClient {
  readonly #getAccessToken: TokenProvider;
  readonly #onForceRefresh: (() => Promise<void>) | undefined;
  readonly #fetch: FetchLike;

  constructor(opts: BitbucketClientOptions) {
    this.#getAccessToken = opts.getAccessToken;
    this.#onForceRefresh = opts.onForceRefresh;
    this.#fetch = opts.fetch ?? (globalThis as { fetch: FetchLike }).fetch;
  }

  async getPr(t: PrTarget): Promise<BitbucketPr> {
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}`;
    return await this.#requestJson<BitbucketPr>(url);
  }

  async listPrs(
    t: RepoTarget,
    opts?: {
      state?: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
      author?: string;
      branch?: string;
      limit?: number;
    },
  ): Promise<BitbucketPr[]> {
    const limit = clampLimit(opts?.limit, DEFAULT_PR_LIMIT);
    const params = new URLSearchParams();

    const qParts: string[] = [];
    if (opts?.state !== undefined) {
      qParts.push(`state="${opts.state}"`);
    }
    if (opts?.author !== undefined) {
      qParts.push(`author.uuid="${opts.author}"`);
    }
    if (opts?.branch !== undefined) {
      qParts.push(`source.branch.name="${opts.branch}"`);
    }
    if (qParts.length > 0) {
      params.set("q", qParts.join(" AND "));
    }
    // Use a reasonable page size capped by limit.
    params.set("pagelen", String(Math.min(50, limit)));

    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests?${params.toString()}`;
    return await this.#paginate<BitbucketPr>(url, limit);
  }

  async getPrDiff(t: PrTarget, opts?: { paths?: string[] }): Promise<string> {
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}/diff`;
    const diff = await this.#requestText(url, { accept: "*/*" });
    const paths = opts?.paths ?? [];
    if (paths.length === 0) {
      return diff;
    }
    // Filtering happens here, not via the endpoint's `path` query param: that
    // param only matches whole file paths, so passing a directory returns an
    // empty diff (verified against the live API). Fetching the full diff and
    // filtering locally costs bandwidth, never correctness — and the point of
    // this filter is to spend fewer tokens, not fewer bytes.
    return filterDiffByPaths(diff, paths);
  }

  async getPrDiffStat(t: PrTarget, opts?: { limit?: number }): Promise<BitbucketDiffstat[]> {
    const limit = clampLimit(opts?.limit, DEFAULT_DIFFSTAT_LIMIT);
    const params = new URLSearchParams();
    params.set("pagelen", String(Math.min(100, limit)));
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}/diffstat?${params.toString()}`;
    return await this.#paginate<BitbucketDiffstat>(url, limit);
  }

  async listPrComments(t: PrTarget, opts?: { limit?: number }): Promise<BitbucketComment[]> {
    const limit = clampLimit(opts?.limit, DEFAULT_COMMENT_LIMIT);
    const params = new URLSearchParams();
    params.set("pagelen", String(Math.min(100, limit)));
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}/comments?${params.toString()}`;
    return await this.#paginate<BitbucketComment>(url, limit);
  }

  async addPrComment(t: PrTarget, body: string): Promise<BitbucketComment> {
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}/comments`;
    return await this.#requestJson<BitbucketComment>(url, {
      method: "POST",
      json: { content: { raw: body } },
    });
  }

  async replyToPrComment(t: PrTarget, parentId: number, body: string): Promise<BitbucketComment> {
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}/comments`;
    return await this.#requestJson<BitbucketComment>(url, {
      method: "POST",
      json: { content: { raw: body }, parent: { id: parentId } },
    });
  }

  async createPr(
    t: RepoTarget,
    args: {
      title: string;
      sourceBranch: string;
      destinationBranch?: string;
      description?: string;
      closeSourceBranch?: boolean;
      reviewers?: string[];
    },
  ): Promise<BitbucketPr> {
    const body: {
      title: string;
      source: { branch: { name: string } };
      destination?: { branch: { name: string } };
      description?: string;
      close_source_branch?: boolean;
      reviewers?: Array<{ uuid: string }>;
    } = {
      title: args.title,
      source: { branch: { name: args.sourceBranch } },
    };
    if (args.destinationBranch !== undefined) {
      body.destination = { branch: { name: args.destinationBranch } };
    }
    if (args.description !== undefined) {
      body.description = args.description;
    }
    if (args.closeSourceBranch !== undefined) {
      body.close_source_branch = args.closeSourceBranch;
    }
    if (args.reviewers !== undefined && args.reviewers.length > 0) {
      body.reviewers = args.reviewers.map((uuid) => ({ uuid }));
    }
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(t.repo)}/pullrequests`;
    return await this.#requestJson<BitbucketPr>(url, {
      method: "POST",
      json: body,
    });
  }

  async updatePr(
    t: PrTarget,
    args: { title?: string; description?: string; reviewers?: string[] },
  ): Promise<BitbucketPr> {
    // Bitbucket Cloud's PUT pullrequests endpoint expects `description` as a
    // plain string, not the nested `{ raw }` shape used for comment content.
    // Sending the nested form caused the literal object to be stored as the
    // PR's description text. See BitbucketPr.description: string in types.ts.
    //
    // `reviewers` replaces the entire reviewers list on the PR — pass an
    // empty array to clear all reviewers. Omit the field to leave it
    // unchanged.
    const body: {
      title?: string;
      description?: string;
      reviewers?: Array<{ uuid: string }>;
    } = {};
    if (args.title !== undefined) {
      body.title = args.title;
    }
    if (args.description !== undefined) {
      body.description = args.description;
    }
    if (args.reviewers !== undefined) {
      body.reviewers = args.reviewers.map((uuid) => ({ uuid }));
    }
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}`;
    return await this.#requestJson<BitbucketPr>(url, {
      method: "PUT",
      json: body,
    });
  }

  async setPrDraftState(t: PrTarget, draft: boolean): Promise<BitbucketPr> {
    // Bitbucket Cloud accepts a partial PUT with just `draft` set; the
    // server preserves all other fields. Sending it bare keeps this
    // separate from `updatePr`'s title/description path.
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}`;
    return await this.#requestJson<BitbucketPr>(url, {
      method: "PUT",
      json: { draft },
    });
  }

  async resolvePrComment(
    t: PrTarget,
    commentId: number,
    resolved: boolean,
  ): Promise<BitbucketComment | undefined> {
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}/comments/${commentId}/resolve`;
    if (resolved) {
      return await this.#requestJson<BitbucketComment>(url, { method: "POST" });
    }
    // DELETE returns 204 with no body.
    await this.#requestJson<unknown>(url, { method: "DELETE" });
    return undefined;
  }

  async addPrInlineComment(
    t: PrTarget,
    args: { body: string; path: string; line: number; side?: "new" | "old" },
  ): Promise<BitbucketComment> {
    const side = args.side ?? "new";
    const inline: { path: string; to?: number; from?: number } = {
      path: args.path,
    };
    if (side === "new") {
      inline.to = args.line;
    } else {
      inline.from = args.line;
    }
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}/comments`;
    return await this.#requestJson<BitbucketComment>(url, {
      method: "POST",
      json: { content: { raw: args.body }, inline },
    });
  }

  /**
   * Lists pipelines in the repo, newest first, optionally scoped to a branch
   * and/or a commit. Steps are attached unless `withSteps` is false.
   */
  async listPipelines(
    t: RepoTarget,
    opts?: {
      branch?: string;
      commit?: string;
      limit?: number;
      withSteps?: boolean;
    },
  ): Promise<PipelineWithSteps[]> {
    const limit = clampLimit(opts?.limit, DEFAULT_PIPELINE_LIMIT);
    const pipelines = await this.#fetchPipelines(t, {
      branch: opts?.branch,
      commit: opts?.commit,
      pagelen: limit,
    });
    return await this.#attachSteps(t, pipelines.slice(0, limit), opts?.withSteps ?? true);
  }

  /**
   * Fetches a single pipeline by UUID or by build number. Bitbucket accepts
   * either in the `{pipeline_uuid}` path segment.
   */
  async getPipeline(
    t: RepoTarget,
    pipelineId: string,
    opts?: { withSteps?: boolean },
  ): Promise<PipelineWithSteps> {
    const id = normalizePipelineId(pipelineId);
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pipelines/${encode(id)}`;
    const pipeline = await this.#requestJson<BitbucketPipeline>(url);
    const withSteps = await this.#attachSteps(t, [pipeline], opts?.withSteps ?? true);
    const only = withSteps[0];
    if (only === undefined) {
      // #attachSteps always returns one entry per input pipeline.
      return { pipeline, steps: [] };
    }
    return only;
  }

  async listPipelineSteps(t: RepoTarget, pipelineId: string): Promise<BitbucketStep[]> {
    const id = normalizePipelineId(pipelineId);
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pipelines/${encode(id)}/steps/`;
    const page = await this.#requestJson<BitbucketPage<BitbucketStep>>(url);
    return page.values;
  }

  /**
   * Finds pipelines that built a specific commit. Bitbucket's
   * `target.commit.hash` filter only matches full 40-char hashes, so short
   * hashes fall back to a client-side prefix match over recent pipelines.
   */
  async findPipelinesForCommit(
    t: RepoTarget,
    commit: string,
    opts?: { branch?: string; limit?: number; withSteps?: boolean },
  ): Promise<PipelineLookup> {
    const limit = clampLimit(opts?.limit, DEFAULT_PIPELINE_LIMIT);
    const isFullHash = /^[0-9a-f]{40}$/i.test(commit);

    let matching: BitbucketPipeline[] = [];
    if (isFullHash) {
      matching = await this.#fetchPipelines(t, {
        branch: opts?.branch,
        commit,
        pagelen: limit,
      });
    }
    if (matching.length === 0) {
      const recent = await this.#fetchPipelines(t, {
        branch: opts?.branch,
        pagelen: PIPELINE_SCAN_WINDOW,
      });
      matching = recent.filter((p) => commitMatches(p.target?.commit?.hash, commit));
    }

    return {
      match: matching.length > 0 ? "commit" : "none",
      commit,
      branch: opts?.branch,
      pipelines: await this.#attachSteps(t, matching.slice(0, limit), opts?.withSteps ?? true),
    };
  }

  /**
   * Finds the pipelines relevant to a PR.
   *
   * Prefers pipelines attributable to the PR — either PR-triggered (the repo's
   * bitbucket-pipelines.yml has a `pull-requests:` section) or built from the
   * PR's head commit. When neither exists, falls back to the most recent
   * pipelines on the PR's source branch and reports `branch_fallback`, which is
   * the common case for repos that build only on branch push. `none` means no
   * pipeline ran for the branch at all.
   */
  async findPipelinesForPr(
    t: PrTarget,
    opts?: { limit?: number; withSteps?: boolean },
  ): Promise<PipelineLookup> {
    const limit = clampLimit(opts?.limit, DEFAULT_PIPELINE_LIMIT);
    const pr = await this.getPr(t);
    const branch = pr.source.branch.name;
    const headCommit = pr.source.commit.hash;
    const withSteps = opts?.withSteps ?? true;

    const candidates = await this.#fetchPipelines(t, {
      branch,
      pagelen: Math.max(limit, PIPELINE_SCAN_WINDOW),
    });

    const attributable = candidates.filter(
      (p) =>
        p.target?.pullrequest?.id === t.prId || commitMatches(p.target?.commit?.hash, headCommit),
    );

    if (attributable.length > 0) {
      return {
        match: "pr_head_commit",
        prId: t.prId,
        branch,
        commit: headCommit,
        pipelines: await this.#attachSteps(t, attributable.slice(0, limit), withSteps),
      };
    }
    if (candidates.length > 0) {
      return {
        match: "branch_fallback",
        prId: t.prId,
        branch,
        commit: headCommit,
        pipelines: await this.#attachSteps(t, candidates.slice(0, limit), withSteps),
      };
    }
    return {
      match: "none",
      prId: t.prId,
      branch,
      commit: headCommit,
      pipelines: [],
    };
  }

  /**
   * Triggers a pipeline. Requires the `pipeline:write` OAuth scope.
   *
   * `customPipeline` selects a definition from the `custom:` section of
   * bitbucket-pipelines.yml; without it Bitbucket picks the definition that
   * matches the branch (`branches:` then `default:`), which is what re-running
   * a build means.
   */
  async triggerPipeline(
    t: RepoTarget,
    args: {
      branch: string;
      commit?: string;
      customPipeline?: string;
      variables?: PipelineVariable[];
    },
  ): Promise<BitbucketPipeline> {
    const target: {
      type: string;
      ref_type: string;
      ref_name: string;
      commit?: { type: string; hash: string };
      selector?: { type: string; pattern: string };
    } = {
      type: "pipeline_ref_target",
      ref_type: "branch",
      ref_name: args.branch,
    };
    if (args.commit !== undefined) {
      target.commit = { type: "commit", hash: args.commit };
    }
    if (args.customPipeline !== undefined) {
      target.selector = { type: "custom", pattern: args.customPipeline };
    }
    const body: { target: typeof target; variables?: PipelineVariable[] } = { target };
    if (args.variables !== undefined && args.variables.length > 0) {
      body.variables = args.variables;
    }
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(t.repo)}/pipelines/`;
    return await this.#requestJson<BitbucketPipeline>(url, {
      method: "POST",
      json: body,
    });
  }

  /**
   * Build statuses attached to a commit — Pipelines results plus anything else
   * that posts a status (deploy jobs, external CI, code scanners).
   */
  async getCommitStatuses(
    t: RepoTarget,
    commit: string,
    opts?: { limit?: number },
  ): Promise<BitbucketCommitStatus[]> {
    const limit = clampLimit(opts?.limit, DEFAULT_STATUS_LIMIT);
    const params = new URLSearchParams();
    params.set("pagelen", String(Math.min(100, limit)));
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(t.repo)}/commit/${encode(
      commit,
    )}/statuses?${params.toString()}`;
    return await this.#paginate<BitbucketCommitStatus>(url, limit);
  }

  /** Build statuses for a PR's head commit, as Bitbucket resolves it. */
  async getPrStatuses(t: PrTarget, opts?: { limit?: number }): Promise<BitbucketCommitStatus[]> {
    const limit = clampLimit(opts?.limit, DEFAULT_STATUS_LIMIT);
    const params = new URLSearchParams();
    params.set("pagelen", String(Math.min(100, limit)));
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}/statuses?${params.toString()}`;
    return await this.#paginate<BitbucketCommitStatus>(url, limit);
  }

  async getPipelineStepLog(t: RepoTarget, pipelineUuid: string, stepUuid: string): Promise<string> {
    const pipelineId = normalizePipelineId(pipelineUuid);
    const stepId = normalizeStepUuid(stepUuid);
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pipelines/${encode(pipelineId)}/steps/${encode(stepId)}/log`;
    try {
      return await this.#requestText(url, { accept: "*/*" });
    } catch (err) {
      if (err instanceof BitbucketError && err.status === 404) {
        throw new BitbucketError(
          `Bitbucket pipeline step has no log available yet (step ${stepId}): ${err.body}`,
          err.status,
          err.body,
        );
      }
      throw err;
    }
  }

  // ---------- Internals ----------

  async #fetchPipelines(
    t: RepoTarget,
    opts: { branch?: string; commit?: string; pagelen: number },
  ): Promise<BitbucketPipeline[]> {
    const params = new URLSearchParams();
    if (opts.branch !== undefined) {
      params.set("target.branch", opts.branch);
    }
    if (opts.commit !== undefined) {
      params.set("target.commit.hash", opts.commit);
    }
    params.set("sort", "-created_on");
    params.set("pagelen", String(Math.min(100, Math.max(1, opts.pagelen))));
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pipelines/?${params.toString()}`;
    const page = await this.#requestJson<BitbucketPage<BitbucketPipeline>>(url);
    const values = page.values ?? [];
    // Bitbucket honours `sort` but be explicit: callers rely on newest-first.
    return [...values].sort((a, b) => (a.created_on < b.created_on ? 1 : -1));
  }

  async #attachSteps(
    t: RepoTarget,
    pipelines: BitbucketPipeline[],
    withSteps: boolean,
  ): Promise<PipelineWithSteps[]> {
    const out: PipelineWithSteps[] = [];
    for (const pipeline of pipelines) {
      if (!withSteps) {
        out.push({ pipeline, steps: [] });
        continue;
      }
      out.push({ pipeline, steps: await this.listPipelineSteps(t, pipeline.uuid) });
    }
    return out;
  }

  async #requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
    const text = await this.#requestText(url, {
      ...opts,
      accept: opts.accept ?? "application/json",
    });
    if (text.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new BitbucketError(
        `Bitbucket returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        0,
        text,
      );
    }
  }

  async #requestText(url: string, opts: RequestOptions = {}): Promise<string> {
    const method = opts.method ?? "GET";
    const accept = opts.accept ?? "application/json";

    const buildHeaders = async (): Promise<Record<string, string>> => {
      const token = await this.#getAccessToken();
      const h: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: accept,
      };
      if (opts.json !== undefined) {
        h["Content-Type"] = "application/json";
      }
      if (opts.headers !== undefined) {
        for (const [k, v] of Object.entries(opts.headers)) {
          h[k] = v;
        }
      }
      return h;
    };

    const body =
      opts.json !== undefined
        ? JSON.stringify(opts.json)
        : opts.body !== undefined
          ? opts.body
          : undefined;

    // Send the request with 401→refresh retry and 429/5xx backoff.
    let attempt = 0;
    let didForceRefresh = false;
    // Attempts are limited by MAX_BACKOFF_ATTEMPTS for 429/5xx. 401 is a
    // separate one-shot retry on top of that.
    while (true) {
      const headers = await buildHeaders();
      const res = await this.#fetch(url, { method, headers, body });

      if (res.status === 401) {
        if (!didForceRefresh && this.#onForceRefresh !== undefined) {
          didForceRefresh = true;
          await this.#onForceRefresh();
          // Retry once with freshly obtained token.
          continue;
        }
        // Fall through to error.
        const text = await safeText(res);
        throw new BitbucketError(
          `Bitbucket API returned 401 Unauthorized for ${method} ${url}`,
          401,
          text,
        );
      }

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt + 1 < MAX_BACKOFF_ATTEMPTS) {
          const delayMs = computeBackoffDelay(attempt, res);
          attempt++;
          await sleep(delayMs);
          continue;
        }
        const text = await safeText(res);
        throw new BitbucketError(
          `Bitbucket API returned ${res.status} for ${method} ${url} after ${MAX_BACKOFF_ATTEMPTS} attempts`,
          res.status,
          text,
        );
      }

      if (res.status < 200 || res.status >= 300) {
        const text = await safeText(res);
        throw new BitbucketError(
          `Bitbucket API returned ${res.status} for ${method} ${url}`,
          res.status,
          text,
        );
      }

      return await res.text();
    }
  }

  async #paginate<T>(firstUrl: string, limit: number): Promise<T[]> {
    const out: T[] = [];
    let nextUrl: string | undefined = firstUrl;
    while (nextUrl !== undefined && out.length < limit) {
      const page: BitbucketPage<T> = await this.#requestJson<BitbucketPage<T>>(nextUrl);
      for (const v of page.values) {
        out.push(v);
        if (out.length >= limit) {
          break;
        }
      }
      nextUrl = page.next;
    }
    return out;
  }
}

function encode(s: string): string {
  return encodeURIComponent(s);
}

const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts what people actually have in hand: a braced UUID, a bare UUID, or a
 * build number (which Bitbucket accepts in the `{pipeline_uuid}` slot).
 */
export function normalizePipelineId(id: string): string {
  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  return BARE_UUID.test(trimmed) ? `{${trimmed}}` : trimmed;
}

/** Step UUIDs must carry the curly braces; add them if the caller omitted them. */
export function normalizeStepUuid(uuid: string): string {
  const trimmed = uuid.trim();
  return BARE_UUID.test(trimmed) ? `{${trimmed}}` : trimmed;
}

/** True when two commit hashes refer to the same commit, allowing short hashes. */
function commitMatches(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a.length === 0 || b.length === 0) {
    return false;
  }
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  // Require at least a 7-char prefix so a stray 1-char value can't match.
  if (shorter.length < 7) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return longer.toLowerCase().startsWith(shorter.toLowerCase());
}

/**
 * Keeps only the sections of a unified diff that touch one of `paths`. A path
 * matches a file exactly, or as a directory prefix (`src/foo` matches
 * `src/foo/bar.ts`). Content before the first file header is dropped.
 */
export function filterDiffByPaths(diff: string, paths: string[]): string {
  if (paths.length === 0) {
    return diff;
  }
  const wanted = paths.map((p) => p.replace(/^\.\//, "").replace(/\/+$/, ""));
  const sections: string[] = [];
  let current: string[] | null = null;
  let keep = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current !== null && keep) {
        sections.push(current.join("\n"));
      }
      current = [line];
      keep = diffHeaderPaths(line).some((filePath) =>
        wanted.some((w) => filePath === w || filePath.startsWith(`${w}/`)),
      );
      continue;
    }
    if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null && keep) {
    sections.push(current.join("\n"));
  }
  const joined = sections.join("\n");
  if (joined.length === 0 || joined.endsWith("\n")) {
    return joined;
  }
  return `${joined}\n`;
}

/** Extracts the a/ and b/ paths from a `diff --git a/x b/y` header line. */
function diffHeaderPaths(header: string): string[] {
  const rest = header.slice("diff --git ".length).trim();
  const out: string[] = [];
  // Quoted paths (git quotes paths containing spaces) and plain ones.
  const quoted = rest.match(/"(?:[^"\\]|\\.)*"/g);
  const tokens = quoted !== null && quoted.length === 2 ? quoted : rest.split(/\s+/);
  for (const token of tokens) {
    const unquoted = token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
    out.push(unquoted.replace(/^[ab]\//, ""));
  }
  return out;
}

function clampLimit(requested: number | undefined, def: number): number {
  const n = requested ?? def;
  if (!Number.isFinite(n) || n <= 0) {
    return def;
  }
  return Math.min(Math.floor(n), PAGINATION_HARD_CAP);
}

function computeBackoffDelay(attempt: number, res: Response): number {
  const retryAfterHeader = res.headers.get("Retry-After");
  if (retryAfterHeader !== null) {
    const parsed = parseRetryAfter(retryAfterHeader);
    if (parsed !== null) {
      return parsed;
    }
  }
  // Exponential: base * 2^attempt.
  return BACKOFF_BASE_MS * Math.pow(2, attempt);
}

function parseRetryAfter(header: string): number | null {
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Numeric seconds.
  if (/^\d+$/.test(trimmed)) {
    const secs = Number.parseInt(trimmed, 10);
    return secs * 1000;
  }
  // HTTP-date.
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return null;
  }
  const ms = date - Date.now();
  return ms < 0 ? 0 : ms;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
