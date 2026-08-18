// Shared type contracts between modules.
// Each module depends on this; modules do not depend on each other's
// internals. All imports are type-only to preserve tree-shaking.

export type StoredConfig = {
  clientKey?: string;
  clientSecret?: string;
  tokens?: StoredTokens;
};

export type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
};

export type TokenProvider = () => Promise<string>;

export type PrTarget = {
  workspace: string;
  repo: string;
  prId: number;
};

export type RepoTarget = {
  workspace: string;
  repo: string;
};

export type BitbucketPr = {
  id: number;
  title: string;
  state: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
  author: { display_name: string; uuid: string };
  source: { branch: { name: string }; commit: { hash: string } };
  destination: { branch: { name: string }; commit: { hash: string } };
  created_on: string;
  updated_on: string;
  links: { html: { href: string } };
  description?: string;
};

export type BitbucketComment = {
  id: number;
  content: { raw: string };
  user: { display_name: string; uuid: string };
  created_on: string;
  updated_on: string;
  inline?: {
    path: string;
    from?: number | null;
    to?: number | null;
  };
  parent?: { id: number };
  // null when unresolved, object when resolved.
  resolution?: {
    type?: string;
    user?: { display_name?: string; uuid?: string };
    created_on?: string;
  } | null;
};

// Bitbucket reports a handful of terminal results for pipelines and steps.
// NOT_RUN and EXPIRED only ever appear on steps.
export type BitbucketResultName =
  | "SUCCESSFUL"
  | "FAILED"
  | "ERROR"
  | "STOPPED"
  | "NOT_RUN"
  | "EXPIRED";

export type BitbucketPipeline = {
  uuid: string;
  build_number: number;
  state: {
    // PARSING/PAUSED/HALTED are rarer but do occur.
    name: "PENDING" | "PARSING" | "IN_PROGRESS" | "PAUSED" | "HALTED" | "COMPLETED";
    result?: { name: BitbucketResultName };
    stage?: { name?: string };
  };
  created_on: string;
  completed_on?: string;
  build_seconds_used?: number;
  trigger?: { name?: string };
  target?: {
    ref_type?: string;
    ref_name?: string;
    commit?: { hash: string };
    pullrequest?: { id: number };
    // Which section of bitbucket-pipelines.yml matched: default, branches,
    // custom, pull-requests, tags.
    selector?: { type?: string; pattern?: string };
  };
};

export type BitbucketStep = {
  uuid: string;
  name: string;
  state: {
    name: "PENDING" | "READY" | "IN_PROGRESS" | "COMPLETED";
    result?: {
      name: BitbucketResultName;
      // Present when the step failed for a pipeline-level reason (e.g. a
      // config error) rather than a non-zero script exit.
      error?: { key?: string; message?: string };
    };
  };
  started_on?: string;
  completed_on?: string;
  duration_in_seconds?: number;
};

export type PipelineWithSteps = {
  pipeline: BitbucketPipeline;
  // Empty when steps were not requested or the pipeline has not expanded yet.
  steps: BitbucketStep[];
};

/**
 * How a pipeline lookup resolved. The distinction matters: `branch_fallback`
 * means "pipelines exist for the branch but none is attributable to the PR",
 * while `none` means "no pipeline ran at all". Reporting both as an empty list
 * is what made pipelines undiscoverable in repos whose bitbucket-pipelines.yml
 * has no `pull-requests:` trigger.
 */
export type PipelineMatch =
  | "build_number"
  | "commit"
  | "pr_head_commit"
  | "branch_fallback"
  | "branch"
  | "none";

export type PipelineLookup = {
  match: PipelineMatch;
  pipelines: PipelineWithSteps[];
  // Whichever of these the lookup was scoped by.
  branch?: string;
  commit?: string;
  prId?: number;
};

export type BitbucketCommitStatus = {
  key: string;
  name?: string;
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED";
  description?: string;
  url?: string;
  refname?: string;
  created_on?: string;
  updated_on?: string;
};

export type BitbucketDiffstat = {
  status: "added" | "removed" | "modified" | "renamed";
  lines_added?: number;
  lines_removed?: number;
  old?: { path?: string } | null;
  new?: { path?: string } | null;
};

export type PipelineVariable = {
  key: string;
  value: string;
  secured?: boolean;
};

export class BitbucketError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "BitbucketError";
    this.status = status;
    this.body = body;
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
