---
description: Install, authenticate, and register bitbucket-mcp with Claude Code
---

You are setting up `bitbucket-mcp` end-to-end for this user's Claude Code installation.

Do the steps below in order. Stop immediately on any error, report it to the user, suggest a fix, and wait for direction before retrying or skipping. Keep chat output concise — the user wants a 2-minute setup, not a 20-line explanation of every command.

## Step 1 — Prereqs

Run `node --version`. The server requires Node 22+. If the major version is below 22, tell the user to install Node 22+ (via nvm, fnm, or the system installer) and stop the playbook.

## Step 2 — Build

If `dist/bitbucket-mcp.mjs` is missing, run:

```bash
vp install
vp pack
```

If `dist/bitbucket-mcp.mjs` already exists but the `src/` tree is newer, run `vp pack` only. After the build, confirm the file exists (`ls -l dist/bitbucket-mcp.mjs`).

## Step 3 — OAuth consumer (user action required)

Infer the Bitbucket workspace from this repo:

```bash
git remote get-url origin
```

- If the origin parses as `https://bitbucket.org/<WORKSPACE>/<REPO>(.git)?` or `git@bitbucket.org:<WORKSPACE>/<REPO>.git`, the OAuth-consumers URL is `https://bitbucket.org/<WORKSPACE>/workspace/settings/oauth-consumers`.
- Otherwise the user must pick a workspace manually; direct them to `https://bitbucket.org/account/workspaces/` and tell them to navigate to "Workspace Settings → OAuth consumers" for the workspace they want.

Send the user this message verbatim (substituting the URL):

> **Step 3 of 6 — Create the OAuth consumer**
>
> Open: `<URL>`
>
> Click "Add consumer" and fill the form exactly:
>
> ```
> Name:           bitbucket-mcp
> Callback URL:   http://127.0.0.1/*
> [x] This is a private consumer
>
> Permissions (check all five):
>   [x] Account        → Read
>   [x] Repositories   → Read
>   [x] Pull requests  → Read
>   [x] Pull requests  → Write
>   [x] Pipelines      → Read
> ```
>
> Click "Save". Bitbucket shows you a Key and a Secret on the next screen. **Paste both back here:**
>
> ```
> Key:    <paste>
> Secret: <paste>
> ```

Then wait for the user's reply containing the key and secret.

## Step 4 — Store credentials

Extract the key and secret from the user's reply. Trim whitespace. Then run (passing the secret via stdin, never as a command-line argument):

```bash
printf '%s' "$SECRET" | ./dist/bitbucket-mcp.mjs credentials --key "$KEY"
```

Substitute the actual values in place of `$KEY` and `$SECRET` before running. **Do not print the secret** in your chat reply, in subsequent tool calls, or anywhere else. After this succeeds, reply "Credentials stored."

## Step 5 — Authorize

Run the OAuth authorization flow:

```bash
./dist/bitbucket-mcp.mjs authorize
```

Before running, tell the user: "Your browser will open to Bitbucket. Click 'Grant access' to finish authorization." The command blocks until the user clicks through in the browser; a 5-minute timeout is built in.

When the command returns, read its stdout:

- If it prints `Authentication complete. Scopes granted: ...`, setup is authorized.
- If there's a `WARNING:` line about missing scopes, surface that warning to the user verbatim and explain they'll need to re-open the consumer in Bitbucket, tick the missing permissions, and re-run `/setup` from Step 5 onwards.
- If the command errors (timeout, 4xx from Bitbucket, etc.), surface the error and help the user diagnose (common causes: "This is a private consumer" wasn't ticked; callback URL missing the `/*` glob; user clicked Deny).

## Step 6 — Register with Claude Code

Register the built server with the Claude Code CLI, scoped to the user (so it works from any directory):

```bash
./dist/bitbucket-mcp.mjs print-config --mcp-add-json \
  | claude mcp add-json bitbucket --scope user -
```

Then verify:

```bash
claude mcp list
```

Confirm `bitbucket` appears in the output.

## Step 7 — Finish

Tell the user:

> `bitbucket-mcp` is registered as a user-scope MCP server. Restart Claude Code (or open a new session) to load it. Once it's loaded, try: "What bitbucket tools do I have?" — the model should list 8 tools.

## Non-negotiables

1. Never echo the Bitbucket client secret back in chat, in a tool-call argument, or in a log line after receiving it.
2. Never proceed past a failed step. Report, suggest, wait.
3. If any step's output is ambiguous, re-run or ask the user — don't guess.
