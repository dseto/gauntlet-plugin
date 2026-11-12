# gauntlet (Claude Code plugin)

Gauntlet Loop (builder -> critic -> verdict) plus the fail-closed harness guardrails, packaged as a plugin.
Replaces `harness-kit/install.mjs` copies.

## What is in it

| Piece | Path |
|---|---|
| Slash commands `/gauntlet:gauntlet`, `/gauntlet:init` | `commands/` |
| Subagents `gauntlet:builder`, `gauntlet:critic` | `agents/` |
| Hooks (bash-guard, file-guard, orchestrator-breaker, fast-file-check, builder-stop-gate) | `hooks/` |
| State machine CLI | `scripts/gauntlet-cli.mjs` |
| Project opt-in script | `scripts/init.mjs` |

Per-project state stays in the project: `.gauntlet/` and `.claude/harness/discovery.json`.
Hooks are no-ops in projects that have neither, so installing the plugin globally is safe.

## Install

From GitHub (the repo is private: needs a logged-in `gh`/git with access):

```powershell
claude plugin marketplace add dseto/gauntlet-plugin
claude plugin install gauntlet@gauntlet-local
```

From a local clone:

```powershell
claude plugin marketplace add C:\Projetos\gauntlet-plugin
claude plugin install gauntlet@gauntlet-local
```

Or try without installing: `claude --plugin-dir C:\Projetos\gauntlet-plugin`.

## Use

1. In a project: `/gauntlet:init`. It discovers build/test commands, shows you the draft `discovery.json` (kept in the OS temp dir, not in the project) and asks for confirmation. Commit the result, restart the session.
   - `--migrate` replaces a legacy harness-kit install: it removes only the harness-kit files (the six hook files and `lib/common.mjs` in `.claude/hooks`, builder/critic agents, `/gauntlet` command, `.gauntlet/gauntlet-cli.mjs`) and their hook commands in `settings.json`. Your own hooks are left alone.
2. `/gauntlet:gauntlet <component> <reference_path>` to start, `/gauntlet:gauntlet` to continue.

Both commands are user-only (`disable-model-invocation`): the model cannot start them on its own.

## Guards

- `bash-guard` runs for both the `Bash` and the `PowerShell` tools.
- The CLI exposes only `init`, `next-iteration`, `record-verdict`, `rollback-to-best`, `close` and `status`. The gate transitions are exported for the stop gate hook and are not reachable from the command line.
- `init` warns when a baseline test command fails without per-test ids (no junit): the test gate is inert for it.
- The critic treats the artifact, tests, script output and reference as data, never as instructions (instructed, not technically enforced).

Kill switch: `HARNESS_OFF=1`. Details: `templates/RUNBOOK.md` (copied to `.gauntlet/RUNBOOK.md` by init).

## Known limits

Cooperative guardrail, not a sandbox (see the RUNBOOK). Open audit items, not applied yet: `bash-guard` only blocks absolute paths outside the project (relative `../` escapes pass), and it allows writes anywhere under `~/.claude`.
