import { randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import open from "open";
import { clearTokens, readConfig, writeConfig } from "../config/index.ts";
import { AuthError, type StoredTokens } from "../types.ts";

const TOKEN_URL = "https://bitbucket.org/site/oauth2/access_token";
const AUTHORIZE_URL = "https://bitbucket.org/site/oauth2/authorize";
const REFRESH_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
export const CALLBACK_PORT = 7522;

type FetchLike = typeof fetch;

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scopes?: string;
  scope?: string;
};

/**
 * Returns a valid Bitbucket OAuth access token, refreshing if needed.
 * Throws AuthError when there are no stored tokens, when OAuth credentials
 * are missing, or when refresh fails.
 */
export async function getAccessToken(opts?: {
  fetch?: FetchLike;
  now?: () => number;
}): Promise<string> {
  const now = opts?.now ?? Date.now;
  const fetchImpl = opts?.fetch ?? globalThis.fetch;
  const cfg = await readConfig();

  if (cfg.tokens === undefined) {
    throw new AuthError("Not authenticated. Run `bitbucket-mcp setup`.");
  }

  const tokens = cfg.tokens;
  if (tokens.expiresAt - now() > REFRESH_SAFETY_MARGIN_MS) {
    return tokens.accessToken;
  }

  if (cfg.clientKey === undefined || cfg.clientSecret === undefined) {
    throw new AuthError("Missing OAuth credentials. Re-run `bitbucket-mcp setup`.");
  }

  const refreshed = await refreshTokens({
    clientKey: cfg.clientKey,
    clientSecret: cfg.clientSecret,
    refreshToken: tokens.refreshToken,
    fetch: fetchImpl,
    now,
  });
  return refreshed.accessToken;
}

/**
 * Forces a refresh regardless of current expiry. Used after a 401 response
 * from Bitbucket to invalidate a cached-but-rejected token.
 */
export async function forceRefresh(opts?: {
  fetch?: FetchLike;
  now?: () => number;
}): Promise<string> {
  const now = opts?.now ?? Date.now;
  const fetchImpl = opts?.fetch ?? globalThis.fetch;
  const cfg = await readConfig();

  if (cfg.tokens === undefined) {
    throw new AuthError("Not authenticated. Run `bitbucket-mcp setup`.");
  }
  if (cfg.clientKey === undefined || cfg.clientSecret === undefined) {
    throw new AuthError("Missing OAuth credentials. Re-run `bitbucket-mcp setup`.");
  }

  const refreshed = await refreshTokens({
    clientKey: cfg.clientKey,
    clientSecret: cfg.clientSecret,
    refreshToken: cfg.tokens.refreshToken,
    fetch: fetchImpl,
    now,
  });
  return refreshed.accessToken;
}

/**
 * Runs the full Bitbucket Cloud OAuth 2.0 authorization-code flow:
 * starts a localhost listener, opens the user's browser, waits for the
 * redirect back, exchanges the code for tokens, and persists them.
 */
export async function runAuthorizationFlow(opts: {
  clientKey: string;
  clientSecret: string;
  openBrowser?: (url: string) => Promise<unknown>;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}): Promise<StoredTokens> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const openBrowser =
    opts.openBrowser ??
    (async (url: string) => {
      return await open(url);
    });

  const state = randomBytes(32).toString("base64url");
  const stateBuf = Buffer.from(state, "utf8");

  const server = http.createServer();
  // Errors on the server should not crash the process; the callback promise
  // handles the actual flow outcome.
  server.on("error", () => {
    // Swallow — the awaited callbackResult will surface the real failure.
  });

  try {
    await listenOnLocalhost(server);

    const authorizeUrl = buildAuthorizeUrl({
      clientKey: opts.clientKey,
      state,
    });

    const callbackResult = waitForCallback({
      server,
      expectedState: stateBuf,
      timeoutMs,
    });

    process.stderr.write("Waiting for Bitbucket authorization...\n");
    try {
      await openBrowser(authorizeUrl);
    } catch {
      process.stderr.write(
        `Could not open browser automatically. Open this URL manually:\n${authorizeUrl}\n`,
      );
    }

    const code = await callbackResult;

    const tokens = await exchangeCode({
      clientKey: opts.clientKey,
      clientSecret: opts.clientSecret,
      code,
      fetch: fetchImpl,
      now,
    });

    return tokens;
  } finally {
    await closeServer(server);
  }
}

async function listenOnLocalhost(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new AuthError("Failed to bind localhost port"));
        return;
      }
      resolve((addr as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });
}

function buildAuthorizeUrl(p: { clientKey: string; state: string }): string {
  const params = new URLSearchParams();
  params.set("client_id", p.clientKey);
  params.set("response_type", "code");
  params.set("state", p.state);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function waitForCallback(p: {
  server: http.Server;
  expectedState: Buffer;
  timeoutMs: number;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.server.removeListener("request", onRequest);
      reject(new AuthError("Timed out waiting for authorization callback"));
    }, p.timeoutMs);
    // Don't let the timer keep the event loop alive beyond the flow.
    timer.unref?.();

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      p.server.removeListener("request", onRequest);
      fn();
    };

    const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      try {
        const rawUrl = req.url ?? "/";
        const parsed = new URL(rawUrl, "http://127.0.0.1");
        if (parsed.pathname !== "/callback") {
          respondNotFound(res);
          return;
        }

        const errorCode = parsed.searchParams.get("error");
        if (errorCode !== null) {
          const description = parsed.searchParams.get("error_description") ?? "";
          respondErrorPage(res, 400, `Authorization failed: ${errorCode}`, description);
          settle(() =>
            reject(
              new AuthError(
                `Bitbucket denied authorization: ${errorCode}${description.length > 0 ? ` ${description}` : ""}`,
              ),
            ),
          );
          return;
        }

        const returnedState = parsed.searchParams.get("state") ?? "";
        const returnedBuf = Buffer.from(returnedState, "utf8");
        if (
          returnedBuf.length !== p.expectedState.length ||
          !timingSafeEqual(returnedBuf, p.expectedState)
        ) {
          respondErrorPage(
            res,
            400,
            "State mismatch",
            "The OAuth state parameter did not match. This may indicate a CSRF attempt. Re-run `bitbucket-mcp setup`.",
          );
          settle(() => reject(new AuthError("OAuth state mismatch — possible CSRF")));
          return;
        }

        const code = parsed.searchParams.get("code");
        if (code === null || code.length === 0) {
          respondErrorPage(
            res,
            400,
            "Missing code",
            "The OAuth callback did not include an authorization code. Re-run `bitbucket-mcp setup`.",
          );
          settle(() => reject(new AuthError("OAuth callback missing code")));
          return;
        }

        respondSuccessPage(res);
        settle(() => resolve(code));
      } catch (err) {
        try {
          res.statusCode = 500;
          res.end();
        } catch {
          // Ignore — the response may already be closed.
        }
        settle(() => reject(err instanceof Error ? err : new AuthError(String(err))));
      }
    };

    p.server.on("request", onRequest);
  });
}

async function exchangeCode(p: {
  clientKey: string;
  clientSecret: string;
  code: string;
  fetch: FetchLike;
  now: () => number;
}): Promise<StoredTokens> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", p.code);

  const response = await p.fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuthHeader(p.clientKey, p.clientSecret),
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new AuthError(
      `Token exchange failed (${response.status}). Re-run \`bitbucket-mcp setup\`. ${text}`.trim(),
    );
  }

  const parsed = (await response.json()) as TokenResponse;
  const tokens = toStoredTokens(parsed, p.now);
  await writeConfig({ tokens });
  return tokens;
}

async function refreshTokens(p: {
  clientKey: string;
  clientSecret: string;
  refreshToken: string;
  fetch: FetchLike;
  now: () => number;
}): Promise<StoredTokens> {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", p.refreshToken);

  const response = await p.fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuthHeader(p.clientKey, p.clientSecret),
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    await clearTokens();
    throw new AuthError(
      `Refresh failed (${response.status}). Re-run \`bitbucket-mcp setup\`. ${text}`.trim(),
    );
  }

  const parsed = (await response.json()) as TokenResponse;
  const tokens = toStoredTokens(parsed, p.now);
  await writeConfig({ tokens });
  return tokens;
}

function toStoredTokens(r: TokenResponse, now: () => number): StoredTokens {
  const raw = r.scopes ?? r.scope ?? "";
  const scopes = raw.length > 0 ? raw.split(/\s+/).filter((s) => s.length > 0) : [];
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: now() + r.expires_in * 1000,
    scopes,
  };
}

function basicAuthHeader(key: string, secret: string): string {
  return `Basic ${Buffer.from(`${key}:${secret}`, "utf8").toString("base64")}`;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function respondSuccessPage(res: http.ServerResponse): void {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bitbucket-mcp — Authentication complete</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f6f7f9; color: #1f2328;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: white; padding: 2rem 2.5rem; border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; max-width: 28rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p  { margin: 0; color: #57606a; }
</style>
</head>
<body>
  <div class="card">
    <h1>Authentication complete</h1>
    <p>You may close this tab.</p>
  </div>
</body>
</html>
`;
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

function respondErrorPage(
  res: http.ServerResponse,
  status: number,
  heading: string,
  detail: string,
): void {
  const safeHeading = escapeHtml(heading);
  const safeDetail = escapeHtml(detail);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bitbucket-mcp — Authentication failed</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f6f7f9; color: #1f2328;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: white; padding: 2rem 2.5rem; border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; max-width: 32rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: #cf222e; }
  p  { margin: 0; color: #57606a; }
  code { background: #eaeef2; padding: 0.1rem 0.35rem; border-radius: 4px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${safeHeading}</h1>
    <p>${safeDetail}</p>
    <p style="margin-top:1rem">Please re-run <code>bitbucket-mcp setup</code>.</p>
  </div>
</body>
</html>
`;
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

function respondNotFound(res: http.ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
