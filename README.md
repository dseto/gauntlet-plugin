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

## Install (local)

```powershell
claude plugin marketplace add C:\Projetos\gauntlet-plugin
claude plugin install gauntlet@gauntlet-local
```

Or try without installing: `claude --plugin-dir C:\Projetos\gauntlet-plugin`.

## Use

1. In a project: `/gauntlet:init` (add `--migrate` to replace a legacy harness-kit install). Commit the result, restart the session.
2. `/gauntlet:gauntlet <component> <reference_path>` to start, `/gauntlet:gauntlet` to continue.

Kill switch: `HARNESS_OFF=1`. Details: `templates/RUNBOOK.md` (copied to `.gauntlet/RUNBOOK.md` by init).
