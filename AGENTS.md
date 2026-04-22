AGENTS.md

# Repository guidelines for agents

This file is the source for `CLAUDE.md` and `.cursor/rules/viteplus.mdc` (both symlink here). Edit this file; the symlinks follow automatically.

## What this project is

`bitbucket-mcp` is a stdio [Model Context Protocol](https://modelcontextprotocol.io) server for **Bitbucket Cloud**. It exposes 8 tools to MCP hosts (Claude Code, Claude Desktop) for reading PR diffs, reading/writing PR comments (including inline file+line comments), and reading Bitbucket Pipelines step logs.

It's distributed on npm as `@mcpkits/bitbucket`. Users run `npx -y @mcpkits/bitbucket setup` once for OAuth + Claude Code registration; the server is then loaded transparently by their MCP host on each invocation.

The design doc is at `docs/superpowers/specs/2026-04-20-bitbucket-mcp-design.md` — read it before making architectural changes.

## Toolchain — Vite+ only

This repo uses [Vite+](https://viteplus.dev). The global `vp` CLI wraps Vite, Rolldown, Vitest, tsdown, Oxlint, and Oxfmt.

**Always use `vp` commands, not the underlying tools directly.**

| Task                 | Command                          |
| -------------------- | -------------------------------- |
| Install deps         | `vp install`                     |
| Lint + typecheck     | `vp check`                       |
| Auto-fix             | `vp check --fix`                 |
| Run tests            | `vp test`                        |
| Run tests (one file) | `vp test src/auth/index.test.ts` |
| Build                | `vp pack`                        |
| Add a dep            | `vp add <pkg>`                   |
| Remove a dep         | `vp remove <pkg>`                |

### Do not

- Call `pnpm`, `npm`, or `yarn` directly — `vp` wraps the configured package manager.
- Install `vitest`, `oxlint`, `oxfmt`, or `tsdown` directly — `vp` bundles them.
- Run `vp vitest` or `vp oxlint` — those commands do not exist. Use `vp test` and `vp lint`.
- Import from `vitest` or `vite` directly in source files. Use `import { expect, test, vi } from "vite-plus/test"` and `import { defineConfig } from "vite-plus"`.

### Common pitfall: `vp run` vs `vp <command>`

`vp <command>` always runs Vite+'s builtin for that command. To run a `package.json` script that shares a name with a builtin, use `vp run <script>`.

## Release

The package is published manually from a developer machine. Three commands:

```bash
pnpm exec bumpp        # interactive: pick patch/minor/major; commits + tags
git push --follow-tags # if bumpp didn't push for you
vp pm publish          # runs prepublishOnly (check + test + build) then uploads
```

`prepublishOnly` runs `vp check && vp test && vp run build` so a broken build never reaches the registry. 2FA is required on the npm account; the publish prompts for an OTP.

We do not maintain a `CHANGELOG.md` — use GitHub Releases (auto-generated from PR titles) for the changelog. We do not currently sign npm provenance (would require GitHub Actions OIDC).

## Source layout

```
src/
├── types.ts              # Shared types used by every module. Treat as the
│                         # contract; never import types from sibling modules.
├── config/               # Read/write ~/.config/bitbucket-mcp/config.json,
│                         # mode 0600. Pure filesystem; no auth/http knowledge.
├── git/                  # Parse `origin` remote → { workspace, repo }.
├── claude-cli/           # Read ~/.claude.json + spawn `claude mcp add-json`
│                         # to register/remove the bitbucket server. Pure I/O;
│                         # no auth/http/git dependencies.
├── bitbucket/            # Typed Bitbucket Cloud REST client.
│                         # Takes a token provider callback — no direct auth dep.
├── auth/                 # OAuth 2.0 flow + token refresh. Uses config/.
│                         # Runs a short-lived http server on 127.0.0.1 for the
│                         # OAuth callback during `runAuthorizationFlow`.
├── server/               # McpServer factory with all 8 tools. CWD-infers
│                         # workspace/repo via git/. Resolves pr_id via
│                         # bitbucket/ + current branch.
├── setup/                # Interactive CLI wizard (instructions + prompts).
│                         # Throws on failure; bin/ handles exit code.
└── bin/                  # Dispatcher: `(default)|serve|setup|help`.
```

Module dependency rule: `config → auth → bitbucket → server → bin`; `git` and `claude-cli` are leaves; `setup` depends on `config` + `auth` + `claude-cli`. No cycles. Tests import only from `../types.ts` + the module under test.

## Testing conventions

- Tests are colocated: `src/<mod>/index.test.ts` beside `src/<mod>/index.ts`.
- Use `import { expect, test, vi } from "vite-plus/test"`.
- Mock `fetch` by passing it as a constructor option (see `BitbucketClient`, `runAuthorizationFlow`, `getAccessToken`). Never monkey-patch `globalThis.fetch`.
- For anything touching the config file, set `XDG_CONFIG_HOME` to a `fs.mkdtempSync` directory per test. Never touch the real `~/.config`.
- Keep tests fast and deterministic — use `vi.useFakeTimers()` for expiry/backoff math.
- When a handler needs direct unit testing, export the bare function alongside the tool registration (see `src/server/index.ts`'s `handleGetPr`, etc.). Tests call the handler directly; they do not spin up the MCP transport.

## Adding a new tool

1. Add the underlying method to `BitbucketClient` + unit tests.
2. Add the handler function (`handleFoo`) in `src/server/index.ts` with zod input schema, short clear description, and all four annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
3. Register it in the tool list at the bottom of the file.
4. Add tests for the handler: CWD inference path, explicit args path, error paths.
5. Update the `README.md` tool table.
6. Keep the total tool count ≤15. If it exceeds ~15 we should revisit the tool-design pattern.

## Out of scope (intentionally deferred)

- Bitbucket Server / Data Center (only Cloud).
- PR-lifecycle writes: `create_pr`, `merge_pr`, `decline_pr`, `set_pr_approval`, `set_pr_draft_state`.
- `retry_pr_pipeline`.
- MCPB packaging for non-developer install.
- Hosted OAuth broker (design doc covers why it was deliberately avoided).

## Security-sensitive areas — touch carefully

- `src/auth/index.ts`: the OAuth `state` parameter must be cryptographically random and compared in constant time. The callback server must bind to `127.0.0.1` only, never `0.0.0.0`. Do not log tokens or secrets.
- `src/config/index.ts`: file mode `0o600`, directory mode `0o700`. Writes must be atomic (temp file + rename) so a crash mid-write doesn't corrupt credentials.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ built-in commands (`vp dev`, `vp build`, `vp test`, etc.) always run the Vite+ built-in tool, not any `package.json` script of the same name. To run a custom script that shares a name with a built-in command, use `vp run <script>`. For example, if you have a custom `dev` script that runs multiple services concurrently, run it with `vp run dev`, not `vp dev` (which always starts Vite's dev server).
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## CI Integration

For GitHub Actions, consider using [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp) to replace separate `actions/setup-node`, package-manager setup, cache, and install steps with a single action.

```yaml
- uses: voidzero-dev/setup-vp@v1
  with:
    cache: true
- run: vp check
- run: vp test
```

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.
<!--VITE PLUS END-->
