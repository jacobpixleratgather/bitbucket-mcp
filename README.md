# bitbucket-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server for **Bitbucket Cloud**, optimized for use with [Claude Code](https://docs.claude.com/en/docs/claude-code/overview). Lets the agent read pull request diffs, read and write PR comments (including file + line inline comments), and read Bitbucket Pipelines step logs so it can debug failing builds.

**Status:** alpha. Distributed on npm as [`@bb-mcp/server`](https://www.npmjs.com/package/@bb-mcp/server).

## Tools

Read-only:

| Tool                     | Description                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `get_pr`                 | Fetch a PR's metadata (title, state, author, branches, URL). |
| `list_prs`               | List PRs filtered by state, author, or branch.               |
| `get_pr_diff`            | Unified diff for a PR.                                       |
| `list_pr_comments`       | All comments on a PR (general + inline).                     |
| `get_pr_pipeline_status` | Pipelines triggered by a PR, with each step's pass/fail.     |
| `get_pipeline_step_log`  | Raw log output for a specific pipeline step.                 |

Write:

| Tool                    | Description                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `add_pr_comment`        | Post a general comment on a PR.                                      |
| `add_pr_inline_comment` | Post a comment on a specific file + line in a PR's diff.             |
| `reply_to_pr_comment`   | Post a threaded reply to an existing PR comment (general or inline). |

All tools accept optional `workspace` and `repo`. When you run the server from inside a git checkout, those are inferred from the `origin` remote. PR-scoped tools accept an optional `pr_id`; when omitted, the server resolves it by listing open PRs whose source branch matches the current checked-out branch.

## Setup

Requires Node 22+.

### Solo (you create your own OAuth consumer)

```bash
npx -y @bb-mcp/server setup
```

The wizard:

1. Opens your browser to your workspace's OAuth consumers page; you create a private consumer with the listed scopes and paste back its key + secret.
2. Opens the browser again to authorize; you click Grant access.
3. Detects `claude` on `PATH` and offers to register the server with Claude Code automatically (user scope).

Restart Claude Code (or open a new session) and you're done.

### Team (shared OAuth consumer)

If your team already keeps a Bitbucket OAuth consumer in your password manager, pass the key and secret as env vars and `setup` will skip the consumer-creation step:

```bash
BITBUCKET_CLIENT_KEY=... \
BITBUCKET_CLIENT_SECRET=... \
npx -y @bb-mcp/server setup
```

You'll be prompted to confirm before the env vars are used.

### Migrating from a previous local-build install

Just run `npx -y @bb-mcp/server setup`. It detects an existing local-dist registration in `~/.claude.json`, skips OAuth (your tokens in `~/.config/bitbucket-mcp/config.json` are reused), and rewrites the registration to use npx. No re-auth needed.

### Other MCP hosts (Claude Desktop, Cursor, etc.)

Add this to your host's MCP config:

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "npx",
      "args": ["-y", "@bb-mcp/server"]
    }
  }
}
```

For the OAuth credentials and tokens, run `npx -y @bb-mcp/server setup` once first; they're stored in `~/.config/bitbucket-mcp/config.json` and used by every invocation regardless of host.

## Config file

Stored at `$XDG_CONFIG_HOME/bitbucket-mcp/config.json` if `XDG_CONFIG_HOME` is set, otherwise `~/.config/bitbucket-mcp/config.json`. Mode `0600`; parent dir mode `0700`.

```json
{
  "clientKey": "...",
  "clientSecret": "...",
  "tokens": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1712345678000,
    "scopes": ["account", "repository", "pullrequest", "pullrequest:write", "pipeline"]
  }
}
```

Never commit this file. Never share it.

## Usage

Once registered and loaded, ask the agent things like:

- "Summarize PR 42 in this repo."
- "What did my latest pipeline fail on?" → the model calls `get_pr_pipeline_status`, then `get_pipeline_step_log` on the failing step.
- "Leave a comment on line 17 of `src/foo.ts` in PR 42 saying 'this needs a null check'." → the model calls `add_pr_inline_comment`.

If you're inside a git checkout of the Bitbucket repo, you typically don't need to pass `workspace`, `repo`, or `pr_id` — the server infers them.

## Build

> End users don't need to clone or build — install via `npx -y @bb-mcp/server setup`. This section is for contributors.

Requires Node 22+ and [Vite+](https://viteplus.dev) (`vp`).

```bash
vp install      # install deps
vp check        # lint + typecheck
vp test         # run tests
vp pack         # bundle to dist/bitbucket-mcp.mjs
```

The build produces a single executable file at `dist/bitbucket-mcp.mjs` with a `#!/usr/bin/env node` shebang and the executable bit set.

## Subcommands

- `bitbucket-mcp` (no args) / `serve` — run the MCP server over stdio.
- `setup` — interactive wizard. Detects existing OAuth tokens and Claude Code registration to choose between fresh install, migration, or re-registration. Honors `BITBUCKET_CLIENT_KEY` + `BITBUCKET_CLIENT_SECRET` env vars for team-shared OAuth consumers (asks before using).
- `credentials --key <KEY>` — non-interactive: read the secret from stdin (or `$BITBUCKET_CLIENT_SECRET`), persist both to the config file.
- `authorize` — run the OAuth flow using stored credentials; open browser, wait for callback, persist tokens.
- `print-config` — emit the JSON payload for `claude mcp add-json bitbucket --scope user`.
- `help` — show usage.

## Security notes

- OAuth tokens and consumer secret live in a `0600` file in your home directory. No env vars, no shell history.
- The OAuth callback listener binds only to `127.0.0.1`. The `state` parameter is a 32-byte cryptographic random and compared in constant time.
- Tokens are refreshed transparently. If a refresh fails (e.g. the consumer was revoked), the MCP clears the tokens and asks you to re-run `/setup` (or `bitbucket-mcp setup`).
- This is a **Bitbucket Cloud** client — Bitbucket Server / Data Center is not supported.

## License

MIT
