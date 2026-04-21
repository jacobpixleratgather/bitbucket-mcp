import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { readConfig, writeConfig } from "../config/index.ts";
import { AuthError, type StoredTokens } from "../types.ts";
import { CALLBACK_PORT, forceRefresh, getAccessToken, runAuthorizationFlow } from "./index.ts";

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
      serializedBody = JSON.stringify(rawBody);
    }
    calls.push({ url, method: init?.method ?? "GET", headers, body: serializedBody });
    const r = responses[idx] ?? responses[responses.length - 1];
    idx += 1;
    const body = r?.body ?? "";
    const status = r?.status ?? 200;
    return new Response(body, {
      status,
      headers: r?.headers ?? { "content-type": "application/json" },
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

function tokenBody(
  overrides?: Partial<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scopes: string;
  }>,
): string {
  return JSON.stringify({
    access_token: overrides?.access_token ?? "new-access",
    refresh_token: overrides?.refresh_token ?? "new-refresh",
    expires_in: overrides?.expires_in ?? 7200,
    scopes: overrides?.scopes ?? "account repository pullrequest",
  });
}

let tmpDir: string;
let prevXdg: string | undefined;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bbmcp-auth-"));
  prevXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = tmpDir;
  // Silence stderr writes from the authorization flow during tests.
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (prevXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = prevXdg;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -----------------------------
// getAccessToken
// -----------------------------

test("getAccessToken throws when no tokens are stored", async () => {
  await writeConfig({ clientKey: "k", clientSecret: "s" });
  await expect(getAccessToken()).rejects.toBeInstanceOf(AuthError);
  await expect(getAccessToken()).rejects.toThrow(/setup/);
});

test("getAccessToken returns current access token when not expired", async () => {
  const now = 1_700_000_000_000;
  await writeConfig({
    clientKey: "k",
    clientSecret: "s",
    tokens: {
      accessToken: "current-access",
      refreshToken: "r",
      expiresAt: now + 10 * 60 * 1000,
      scopes: ["account"],
    },
  });
  const { fetch: f, calls } = makeScriptedFetch([]);
  const token = await getAccessToken({ fetch: f, now: () => now });
  expect(token).toBe("current-access");
  expect(calls).toHaveLength(0);
});

test("getAccessToken refreshes when expired, persists, returns new token", async () => {
  const now = 2_000_000_000_000;
  await writeConfig({
    clientKey: "key-abc",
    clientSecret: "secret-xyz",
    tokens: {
      accessToken: "old",
      refreshToken: "refresh-1",
      expiresAt: now - 5_000,
      scopes: ["account"],
    },
  });
  const { fetch: f, calls } = makeScriptedFetch([
    {
      status: 200,
      body: tokenBody({
        access_token: "fresh",
        refresh_token: "refresh-2",
        expires_in: 3600,
        scopes: "account repository",
      }),
    },
  ]);
  const token = await getAccessToken({ fetch: f, now: () => now });
  expect(token).toBe("fresh");
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.method).toBe("POST");
  expect(call.url).toBe("https://bitbucket.org/site/oauth2/access_token");
  expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  const expectedBasic = `Basic ${Buffer.from("key-abc:secret-xyz", "utf8").toString("base64")}`;
  expect(call.headers["authorization"]).toBe(expectedBasic);
  expect(call.body).toContain("grant_type=refresh_token");
  expect(call.body).toContain("refresh_token=refresh-1");

  const cfg = await readConfig();
  expect(cfg.tokens?.accessToken).toBe("fresh");
  expect(cfg.tokens?.refreshToken).toBe("refresh-2");
  expect(cfg.tokens?.expiresAt).toBe(now + 3_600_000);
  expect(cfg.tokens?.scopes).toEqual(["account", "repository"]);
});

test("getAccessToken: refresh 4xx clears tokens and throws AuthError including body", async () => {
  const now = 2_100_000_000_000;
  await writeConfig({
    clientKey: "k",
    clientSecret: "s",
    tokens: {
      accessToken: "old",
      refreshToken: "r",
      expiresAt: now - 1000,
      scopes: [],
    },
  });
  const { fetch: f } = makeScriptedFetch([
    { status: 400, body: "invalid_grant: refresh token expired" },
  ]);
  let caught: unknown;
  try {
    await getAccessToken({ fetch: f, now: () => now });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AuthError);
  expect((caught as Error).message).toMatch(/Refresh failed \(400\)/);
  expect((caught as Error).message).toMatch(/invalid_grant/);

  const cfg = await readConfig();
  expect(cfg.tokens).toBeUndefined();
  expect(cfg.clientKey).toBe("k");
  expect(cfg.clientSecret).toBe("s");
});

test("getAccessToken: expiry within 60s safety margin triggers refresh", async () => {
  const now = 3_000_000_000_000;
  await writeConfig({
    clientKey: "k",
    clientSecret: "s",
    tokens: {
      accessToken: "old",
      refreshToken: "r",
      // 30 seconds from now — inside the 60-second safety margin.
      expiresAt: now + 30_000,
      scopes: [],
    },
  });
  const { fetch: f, calls } = makeScriptedFetch([{ status: 200, body: tokenBody() }]);
  await getAccessToken({ fetch: f, now: () => now });
  expect(calls).toHaveLength(1);
});

test("getAccessToken: expiry exactly at safety margin boundary still returns current token", async () => {
  // Strict `>` check: exactly 60_001 ms ahead is still valid.
  const now = 3_100_000_000_000;
  await writeConfig({
    clientKey: "k",
    clientSecret: "s",
    tokens: {
      accessToken: "current",
      refreshToken: "r",
      expiresAt: now + 60_001,
      scopes: [],
    },
  });
  const { fetch: f, calls } = makeScriptedFetch([]);
  const token = await getAccessToken({ fetch: f, now: () => now });
  expect(token).toBe("current");
  expect(calls).toHaveLength(0);
});

test("getAccessToken throws when clientKey missing but tokens present and expired", async () => {
  const now = 4_000_000_000_000;
  await writeConfig({
    clientSecret: "s",
    tokens: {
      accessToken: "old",
      refreshToken: "r",
      expiresAt: now - 1,
      scopes: [],
    },
  });
  await expect(getAccessToken({ now: () => now })).rejects.toThrow(/Missing OAuth credentials/);
});

// -----------------------------
// forceRefresh
// -----------------------------

test("forceRefresh refreshes even when token is not expired", async () => {
  const now = 5_000_000_000_000;
  await writeConfig({
    clientKey: "k",
    clientSecret: "s",
    tokens: {
      accessToken: "still-valid",
      refreshToken: "r1",
      expiresAt: now + 60 * 60 * 1000,
      scopes: [],
    },
  });
  const { fetch: f, calls } = makeScriptedFetch([
    { status: 200, body: tokenBody({ access_token: "rotated", refresh_token: "r2" }) },
  ]);
  const token = await forceRefresh({ fetch: f, now: () => now });
  expect(token).toBe("rotated");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toContain("grant_type=refresh_token");
  expect(calls[0]!.body).toContain("refresh_token=r1");
  const cfg = await readConfig();
  expect(cfg.tokens?.refreshToken).toBe("r2");
});

test("forceRefresh: no tokens throws AuthError", async () => {
  await writeConfig({ clientKey: "k", clientSecret: "s" });
  await expect(forceRefresh()).rejects.toThrow(AuthError);
});

test("forceRefresh: non-2xx clears tokens and throws with body", async () => {
  await writeConfig({
    clientKey: "k",
    clientSecret: "s",
    tokens: {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
    },
  });
  const { fetch: f } = makeScriptedFetch([{ status: 401, body: "unauthorized" }]);
  await expect(forceRefresh({ fetch: f })).rejects.toThrow(/Refresh failed \(401\)/);
  const cfg = await readConfig();
  expect(cfg.tokens).toBeUndefined();
});

// -----------------------------
// runAuthorizationFlow
// -----------------------------

function parseState(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get("state") ?? "";
}

test("runAuthorizationFlow: happy path — exchanges code, persists tokens", async () => {
  const now = 6_000_000_000_000;
  let capturedUrl: string | undefined;

  const { fetch: f, calls } = makeScriptedFetch([
    {
      status: 200,
      body: tokenBody({
        access_token: "auth-access",
        refresh_token: "auth-refresh",
        expires_in: 7200,
        scopes: "account repository pullrequest pullrequest:write pipeline",
      }),
    },
  ]);

  const openBrowser = async (url: string): Promise<undefined> => {
    capturedUrl = url;
    const state = parseState(url);
    // Fire off the callback asynchronously so waitForCallback is installed.
    setImmediate(() => {
      void globalThis
        .fetch(
          `http://127.0.0.1:${CALLBACK_PORT}/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        )
        .catch(() => {
          // Ignored — the server may close between response and body consumption.
        });
    });
    return undefined;
  };

  const tokens: StoredTokens = await runAuthorizationFlow({
    clientKey: "flow-key",
    clientSecret: "flow-secret",
    openBrowser,
    fetch: f,
    now: () => now,
  });

  expect(tokens.accessToken).toBe("auth-access");
  expect(tokens.refreshToken).toBe("auth-refresh");
  expect(tokens.expiresAt).toBe(now + 7_200_000);
  expect(tokens.scopes).toEqual([
    "account",
    "repository",
    "pullrequest",
    "pullrequest:write",
    "pipeline",
  ]);

  expect(capturedUrl).toBeDefined();
  expect(capturedUrl!).toMatch(/^https:\/\/bitbucket\.org\/site\/oauth2\/authorize\?/);
  const u = new URL(capturedUrl!);
  expect(u.searchParams.get("client_id")).toBe("flow-key");
  expect(u.searchParams.get("response_type")).toBe("code");
  expect(u.searchParams.get("state")).toBeTruthy();

  // Token exchange request.
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.url).toBe("https://bitbucket.org/site/oauth2/access_token");
  expect(call.method).toBe("POST");
  expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  const expectedBasic = `Basic ${Buffer.from("flow-key:flow-secret", "utf8").toString("base64")}`;
  expect(call.headers["authorization"]).toBe(expectedBasic);
  expect(call.body).toContain("grant_type=authorization_code");
  expect(call.body).toContain("code=auth-code");
  expect(call.body).not.toContain("redirect_uri");

  // Persisted.
  const cfg = await readConfig();
  expect(cfg.tokens?.accessToken).toBe("auth-access");
});

test("runAuthorizationFlow: authorize URL state matches the state sent back", async () => {
  let statesMatch = false;
  const { fetch: f } = makeScriptedFetch([{ status: 200, body: tokenBody() }]);

  const openBrowser = async (url: string): Promise<undefined> => {
    const state = parseState(url);
    // Confirm we're round-tripping the same state we extracted from the URL.
    setImmediate(() => {
      void globalThis
        .fetch(
          `http://127.0.0.1:${CALLBACK_PORT}/callback?code=c&state=${encodeURIComponent(state)}`,
        )
        .then(() => {
          statesMatch = true;
        })
        .catch(() => {
          // Ignored.
        });
    });
    return undefined;
  };

  await runAuthorizationFlow({
    clientKey: "k",
    clientSecret: "s",
    openBrowser,
    fetch: f,
  });
  expect(statesMatch).toBe(true);
});

test("runAuthorizationFlow: state mismatch rejects and does not exchange", async () => {
  const { fetch: f, calls } = makeScriptedFetch([]);

  const openBrowser = async (): Promise<undefined> => {
    setImmediate(() => {
      void globalThis
        .fetch(`http://127.0.0.1:${CALLBACK_PORT}/callback?code=c&state=WRONG`)
        .catch(() => {
          // Ignored.
        });
    });
    return undefined;
  };

  await expect(
    runAuthorizationFlow({
      clientKey: "k",
      clientSecret: "s",
      openBrowser,
      fetch: f,
    }),
  ).rejects.toThrow(/state mismatch/i);
  expect(calls).toHaveLength(0);
});

test("runAuthorizationFlow: Bitbucket ?error=... rejects with AuthError including error text", async () => {
  const { fetch: f, calls } = makeScriptedFetch([]);

  const openBrowser = async (): Promise<undefined> => {
    setImmediate(() => {
      void globalThis
        .fetch(
          `http://127.0.0.1:${CALLBACK_PORT}/callback?error=access_denied&error_description=${encodeURIComponent("User declined")}`,
        )
        .catch(() => {
          // Ignored.
        });
    });
    return undefined;
  };

  await expect(
    runAuthorizationFlow({
      clientKey: "k",
      clientSecret: "s",
      openBrowser,
      fetch: f,
    }),
  ).rejects.toThrow(/access_denied/);
  expect(calls).toHaveLength(0);
});

test("runAuthorizationFlow: missing code rejects", async () => {
  const { fetch: f, calls } = makeScriptedFetch([]);

  const openBrowser = async (url: string): Promise<undefined> => {
    const state = parseState(url);
    setImmediate(() => {
      void globalThis
        .fetch(`http://127.0.0.1:${CALLBACK_PORT}/callback?state=${encodeURIComponent(state)}`)
        .catch(() => {
          // Ignored.
        });
    });
    return undefined;
  };

  await expect(
    runAuthorizationFlow({
      clientKey: "k",
      clientSecret: "s",
      openBrowser,
      fetch: f,
    }),
  ).rejects.toThrow(/missing code/i);
  expect(calls).toHaveLength(0);
});

test("runAuthorizationFlow: token exchange 4xx rejects with body", async () => {
  const { fetch: f } = makeScriptedFetch([{ status: 400, body: "invalid_grant: bad code" }]);

  const openBrowser = async (url: string): Promise<undefined> => {
    const state = parseState(url);
    setImmediate(() => {
      void globalThis
        .fetch(
          `http://127.0.0.1:${CALLBACK_PORT}/callback?code=c&state=${encodeURIComponent(state)}`,
        )
        .catch(() => {
          // Ignored.
        });
    });
    return undefined;
  };

  await expect(
    runAuthorizationFlow({
      clientKey: "k",
      clientSecret: "s",
      openBrowser,
      fetch: f,
    }),
  ).rejects.toThrow(/Token exchange failed \(400\)/);
});

test("runAuthorizationFlow: times out when no callback arrives", async () => {
  const { fetch: f, calls } = makeScriptedFetch([]);

  const openBrowser = async (): Promise<undefined> => {
    // Intentionally never trigger a callback.
    return undefined;
  };

  await expect(
    runAuthorizationFlow({
      clientKey: "k",
      clientSecret: "s",
      openBrowser,
      fetch: f,
      timeoutMs: 50,
    }),
  ).rejects.toThrow(/Timed out/);
  expect(calls).toHaveLength(0);
});

test("runAuthorizationFlow: openBrowser is called with the authorize URL", async () => {
  const { fetch: f } = makeScriptedFetch([{ status: 200, body: tokenBody() }]);
  const seen: string[] = [];

  const openBrowser = async (url: string): Promise<undefined> => {
    seen.push(url);
    const state = parseState(url);
    setImmediate(() => {
      void globalThis
        .fetch(
          `http://127.0.0.1:${CALLBACK_PORT}/callback?code=c&state=${encodeURIComponent(state)}`,
        )
        .catch(() => {
          // Ignored.
        });
    });
    return undefined;
  };

  await runAuthorizationFlow({
    clientKey: "k",
    clientSecret: "s",
    openBrowser,
    fetch: f,
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]!).toMatch(/^https:\/\/bitbucket\.org\/site\/oauth2\/authorize\?/);
});

test("runAuthorizationFlow: if openBrowser throws, flow still completes (URL logged)", async () => {
  const { fetch: f } = makeScriptedFetch([{ status: 200, body: tokenBody() }]);

  let capturedUrl: string | undefined;
  // Capture from outside openBrowser via closure — we set it before throwing.
  const openBrowser = async (url: string): Promise<undefined> => {
    capturedUrl = url;
    const state = parseState(url);
    setImmediate(() => {
      void globalThis
        .fetch(
          `http://127.0.0.1:${CALLBACK_PORT}/callback?code=c&state=${encodeURIComponent(state)}`,
        )
        .catch(() => {
          // Ignored.
        });
    });
    throw new Error("no display");
  };

  const tokens = await runAuthorizationFlow({
    clientKey: "k",
    clientSecret: "s",
    openBrowser,
    fetch: f,
  });
  expect(tokens.accessToken).toBe("new-access");
  expect(capturedUrl).toBeDefined();

  // Verify a stderr line mentioned the URL after the openBrowser failure.
  const stderrWrites = stderrSpy.mock.calls
    .map((args: unknown[]) => (typeof args[0] === "string" ? args[0] : ""))
    .join("");
  expect(stderrWrites).toContain(capturedUrl!);
});
