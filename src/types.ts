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
};

export type BitbucketPipeline = {
  uuid: string;
  build_number: number;
  state: {
    name: "PENDING" | "IN_PROGRESS" | "COMPLETED";
    result?: { name: "SUCCESSFUL" | "FAILED" | "ERROR" | "STOPPED" };
  };
  created_on: string;
  target?: {
    ref_name?: string;
    commit?: { hash: string };
    pullrequest?: { id: number };
  };
};

export type BitbucketStep = {
  uuid: string;
  name: string;
  state: {
    name: "PENDING" | "READY" | "IN_PROGRESS" | "COMPLETED";
    result?: { name: "SUCCESSFUL" | "FAILED" | "ERROR" | "STOPPED" };
  };
  started_on?: string;
  completed_on?: string;
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
