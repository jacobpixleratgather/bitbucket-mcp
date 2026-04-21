import {
  BitbucketError,
  type BitbucketComment,
  type BitbucketPipeline,
  type BitbucketPr,
  type BitbucketStep,
  type PrTarget,
  type RepoTarget,
  type TokenProvider,
} from "../types.ts";

const BASE_URL = "https://api.bitbucket.org/2.0";

const DEFAULT_PR_LIMIT = 50;
const DEFAULT_COMMENT_LIMIT = 100;
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

  async getPrDiff(t: PrTarget): Promise<string> {
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pullrequests/${t.prId}/diff`;
    return await this.#requestText(url, { accept: "*/*" });
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

  async getPrPipelineStatus(
    t: PrTarget,
  ): Promise<Array<{ pipeline: BitbucketPipeline; steps: BitbucketStep[] }>> {
    const pr = await this.getPr(t);
    const branch = pr.source.branch.name;
    const headCommit = pr.source.commit.hash;

    const params = new URLSearchParams();
    params.set("target.branch", branch);
    params.set("sort", "-created_on");
    params.set("pagelen", "20");
    const pipelinesUrl = `${BASE_URL}/repositories/${encode(
      t.workspace,
    )}/${encode(t.repo)}/pipelines/?${params.toString()}`;
    const page = await this.#requestJson<BitbucketPage<BitbucketPipeline>>(pipelinesUrl);

    const matching = page.values.filter((p) => {
      const hash = p.target?.commit?.hash;
      return hash !== undefined && hash === headCommit;
    });

    const out: Array<{ pipeline: BitbucketPipeline; steps: BitbucketStep[] }> = [];
    for (const pipeline of matching) {
      const stepsUrl = `${BASE_URL}/repositories/${encode(
        t.workspace,
      )}/${encode(t.repo)}/pipelines/${encode(pipeline.uuid)}/steps/`;
      const stepsPage = await this.#requestJson<BitbucketPage<BitbucketStep>>(stepsUrl);
      out.push({ pipeline, steps: stepsPage.values });
    }
    out.sort((a, b) => (a.pipeline.created_on < b.pipeline.created_on ? 1 : -1));
    return out;
  }

  async getPipelineStepLog(t: RepoTarget, pipelineUuid: string, stepUuid: string): Promise<string> {
    const url = `${BASE_URL}/repositories/${encode(t.workspace)}/${encode(
      t.repo,
    )}/pipelines/${encode(pipelineUuid)}/steps/${encode(stepUuid)}/log`;
    try {
      return await this.#requestText(url, { accept: "*/*" });
    } catch (err) {
      if (err instanceof BitbucketError && err.status === 404) {
        throw new BitbucketError(
          `Bitbucket pipeline step has no log available yet (step ${stepUuid}): ${err.body}`,
          err.status,
          err.body,
        );
      }
      throw err;
    }
  }

  // ---------- Internals ----------

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
