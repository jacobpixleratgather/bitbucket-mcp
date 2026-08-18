# bitbucket-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Bitbucket Cloud**, optimized for use with [Claude Code](https://docs.claude.com/en/docs/claude-code/overview). Lets the agent read pull request diffs, read and write PR comments (including file + line inline comments), edit the PR Overview (title and description), resolve and unresolve comment threads, find Pipelines builds and read their step logs, check whether a commit is green, and re-run a build.

**Status:** alpha. Distributed on npm as [`@mcpkits/bitbucket`](https://www.npmjs.com/package/@mcpkits/bitbucket).

## Tools

Read-only:

| Tool                    | Description                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `get_pr`                | Fetch a PR's metadata (title, state, author, branches, URL).                                    |
| `list_prs`              | List PRs filtered by state, author, or branch.                                                  |
| `get_pr_diff`           | Unified diff for a PR, with `paths` filtering, `stat_only` mode, and a `max_bytes` cap.         |
| `list_pr_comments`      | All comments on a PR (general + inline).                                                        |
| `list_pipelines`        | Find pipelines by PR, branch, commit, or build number, with each step's UUID and pass/fail.     |
| `get_pipeline_step_log` | Log output for a pipeline step, with `tail_lines` / `max_bytes` and failed-step auto-selection. |
| `get_build_status`      | Commit build statuses rolled up to one verdict — "is this commit green?".                       |

Write:

| Tool                    | Description                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `add_pr_comment`        | Post a general comment on a PR.                                      |
| `add_pr_inline_comment` | Post a comment on a specific file + line in a PR's diff.             |
| `reply_to_pr_comment`   | Post a threaded reply to an existing PR comment (general or inline). |
| `create_pr`             | Open a new PR. Defaults source to the current git branch.            |
| `update_pr`             | Update a PR's title, description (Overview), and/or reviewers list.  |
| `set_pr_draft_state`    | Mark a PR as draft or ready for review.                              |
| `resolve_pr_comment`    | Mark a PR comment resolved or unresolved.                            |
| `run_pipeline`          | Start a build: re-run a branch's pipeline or run a `custom:` one.    |

All tools accept optional `workspace` and `repo`. When you run the server from inside a git checkout, those are inferred from the `origin` remote. PR-scoped tools accept an optional `pr_id`; when omitted, the server resolves it by listing open PRs whose source branch matches the current checked-out branch.

### Finding pipelines

Most repos have no `pull-requests:` section in `bitbucket-pipelines.yml`, so their builds fire on branch push and Bitbucket cannot attribute any pipeline to a PR. `list_pipelines` handles that: when nothing is attributable to the PR it falls back to the most recent pipelines on the PR's source branch and reports what it did.

- `match: "pr_head_commit"` — the pipeline was PR-triggered or built the PR's head commit.
- `match: "branch_fallback"` — these built the source branch, not the PR. Each entry carries `is_requested_commit` so you can tell whether it built the commit you asked about.
- `match: "none"` — no pipeline ran at all. Distinct from the fallback case, and never silently an empty list.

You can also scope it directly with `branch`, `commit` (short or full SHA), or `build_number`. Steps come back with their UUIDs and pass/fail state, which is what `get_pipeline_step_log` needs — and it accepts a plain build number in the `pipeline_uuid` slot, with or without curly braces on UUIDs.

### Output size

Diffs and logs are the two things that can blow a context window, so both are capped and both can be narrowed:

- `get_pr_diff` — `stat_only: true` for a per-file summary, `paths: ["src/foo"]` to fetch part of a diff, `max_bytes` (default 100 KB, keeps the head) otherwise.
- `get_pipeline_step_log` — `tail_lines: 50` for just the end of a failing step, `max_bytes` (default 100 KB, keeps the tail). To learn only whether a step passed, use `list_pipelines` instead: it returns each step's state, result, and duration without fetching any log.

### Deliberately not included

There is no `merge_pr` and no `set_pr_approval`. Merging into a shared branch and approving someone's code are decisions we want a human to keep making, so this server cannot do either.

## Setup

Requires Node 22+.

### Solo (you create your own OAuth consumer)

```bash
npx -y @mcpkits/bitbucket setup
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
npx -y @mcpkits/bitbucket setup
```

You'll be prompted to confirm before the env vars are used.

### Migrating from a previous local-build install

Just run `npx -y @mcpkits/bitbucket setup`. It detects an existing local-dist registration in `~/.claude.json`, skips OAuth (your tokens in `~/.config/bitbucket-mcp/config.json` are reused), and rewrites the registration to use npx. No re-auth needed.

### Other MCP hosts (Claude Desktop, Cursor, etc.)

Add this to your host's MCP config:

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "npx",
      "args": ["-y", "@mcpkits/bitbucket"]
    }
  }
}
```

For the OAuth credentials and tokens, run `npx -y @mcpkits/bitbucket setup` once first; they're stored in `~/.config/bitbucket-mcp/config.json` and used by every invocation regardless of host.

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
    "scopes": [
      "account",
      "repository",
      "pullrequest",
      "pullrequest:write",
      "pipeline",
      "pipeline:write"
    ]
  }
}
```

Never commit this file. Never share it.

## Usage

Once registered and loaded, ask the agent things like:

- "Summarize PR 42 in this repo."
- "What did my latest pipeline fail on?" → the model calls `list_pipelines`, then `get_pipeline_step_log` on the failing step (or with no `step_uuid` at all, which picks the failing step for it).
- "Is this commit green?" → `get_build_status`.
- "Re-run the build, that step is flaky." → `run_pipeline`.
- "Leave a comment on line 17 of `src/foo.ts` in PR 42 saying 'this needs a null check'." → the model calls `add_pr_inline_comment`.

If you're inside a git checkout of the Bitbucket repo, you typically don't need to pass `workspace`, `repo`, or `pr_id` — the server infers them.

## Build

> End users don't need to clone or build — install via `npx -y @mcpkits/bitbucket setup`. This section is for contributors.

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
- Tokens are refreshed transparently. If a refresh fails (e.g. the consumer was revoked), the MCP clears the tokens and asks you to re-run `npx -y @mcpkits/bitbucket setup`.
- `run_pipeline` needs the `pipeline:write` scope. If you set this server up before that scope was requested, re-run `npx -y @mcpkits/bitbucket setup`, tick **Pipelines → Write** on the consumer, and re-authorize. Everything else keeps working without it.
- This is a **Bitbucket Cloud** client — Bitbucket Server / Data Center is not supported.

## License

MIT
