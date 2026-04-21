# bitbucket-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server for **Bitbucket Cloud**, optimized for use with [Claude Code](https://docs.claude.com/en/docs/claude-code/overview). Lets the agent read pull request diffs, read and write PR comments (including file + line inline comments), and read Bitbucket Pipelines step logs so it can debug failing builds.

**Status:** local-use alpha. Not published to npm.

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

| Tool                    | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `add_pr_comment`        | Post a general comment on a PR.                          |
| `add_pr_inline_comment` | Post a comment on a specific file + line in a PR's diff. |

All tools accept optional `workspace` and `repo`. When you run the server from inside a git checkout, those are inferred from the `origin` remote. PR-scoped tools accept an optional `pr_id`; when omitted, the server resolves it by listing open PRs whose source branch matches the current checked-out branch.

## Setup (Claude Code — recommended)

Clone the repo, open Claude Code in the checkout, and run:

```
/setup
```

Claude will install dependencies, build the bundle, guide you through the one-time Bitbucket OAuth consumer creation, run the OAuth authorization flow, and register the server with the Claude Code CLI — all in a single conversation. The only things you do yourself:

1. Click through the Bitbucket OAuth consumer form.
2. Paste the generated Key and Secret back into the chat.
3. Click "Grant access" on the Bitbucket authorization page.

Requires Node 22+ and the `claude` CLI on `$PATH`.

## Setup (manual fallback)

If you're not in Claude Code or prefer the scripted flow:

```bash
vp install
vp pack
./dist/bitbucket-mcp.mjs setup           # interactive OAuth wizard
./dist/bitbucket-mcp.mjs print-config --mcp-add-json \
  | claude mcp add-json bitbucket --scope user -
```

The `setup` subcommand runs a three-step terminal wizard equivalent to what `/setup` does, minus the MCP registration at the end. `print-config --mcp-add-json` emits a JSON blob suitable for `claude mcp add-json`, or for hand-editing into another MCP host's config.

For non-Claude-Code MCP hosts, use the absolute path to `dist/bitbucket-mcp.mjs` directly:

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "/absolute/path/to/bitbucket-mcp/dist/bitbucket-mcp.mjs"
    }
  }
}
```

## Setup (team — shared OAuth consumer)

If your team already has a Bitbucket OAuth consumer registered, you don't need to create another one. Get the **Key** and **Secret** from your team's password manager, then run these four steps:

**1. Clone and build**

```bash
git clone <this-repo-url>
cd bitbucket-mcp
vp install
vp pack
```

**2. Load the shared credentials** (secret piped in to avoid shell history)

```bash
echo "<SECRET>" | ./dist/bitbucket-mcp.mjs credentials --key <KEY>

# Or via env var if your vault can inject it:
BITBUCKET_CLIENT_SECRET=<SECRET> ./dist/bitbucket-mcp.mjs credentials --key <KEY>
```

**3. Authorize with your own Bitbucket account**

```bash
./dist/bitbucket-mcp.mjs authorize
# Opens browser → click "Grant access" → tokens saved to ~/.config/bitbucket-mcp/config.json
```

**4. Register with Claude Code**

```bash
./dist/bitbucket-mcp.mjs print-config --mcp-add-json \
  | claude mcp add-json bitbucket --scope user -
```

Everyone shares the same OAuth consumer (key + secret) but each developer authorizes independently and gets their own personal access/refresh tokens in `~/.config/bitbucket-mcp/config.json`.

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
- `setup` — interactive OAuth wizard (manual fallback).
- `credentials --key <KEY>` — non-interactive: read the secret from stdin (or `$BITBUCKET_CLIENT_SECRET`), persist both to the config file.
- `authorize` — run the OAuth flow using stored credentials; open browser, wait for callback, persist tokens.
- `print-config --mcp-add-json` / `--raw` — emit MCP registration data for piping to `claude mcp add-json` or shell substitution.
- `help` — show usage.

## Security notes

- OAuth tokens and consumer secret live in a `0600` file in your home directory. No env vars, no shell history.
- The OAuth callback listener binds only to `127.0.0.1`. The `state` parameter is a 32-byte cryptographic random and compared in constant time.
- Tokens are refreshed transparently. If a refresh fails (e.g. the consumer was revoked), the MCP clears the tokens and asks you to re-run `/setup` (or `bitbucket-mcp setup`).
- This is a **Bitbucket Cloud** client — Bitbucket Server / Data Center is not supported.

## License

MIT
