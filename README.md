# gauntlet (Claude Code plugin)

Gauntlet Loop (builder -> critic -> verdict) plus the fail-closed harness guardrails, packaged as a plugin.
Replaces `harness-kit/install.mjs` copies.

## Why use it

A single Claude session that builds something and then judges its own work tends to declare victory early. The Gauntlet Loop splits the job and makes the stopping rule mechanical:

- **Builder** (`gauntlet:builder`) implements one iteration toward a concrete reference and may not commit or touch `.gauntlet/` state.
- **Stop gate** (a hook, not a prompt) runs when the builder finishes: reference lock, anti-cheat diff, build, tests. A builder that fails it three times in a row ends the loop as `GATE_FAILED`.
- **Critic** (`gauntlet:critic`) scores the artifact against a rubric without reading the builder's own story, and lists blockers and gaps.
- **State machine CLI** decides what happens next: approve, iterate, or halt. The agents never decide that.

Benefits:

| Benefit | How |
|---|---|
| Fewer false "done" | Approval needs score >= 85 **and** no blockers, from a separate critic. |
| Anti-cheat | The gate flags weakened tests and new suppressions (`noqa`, `ts-ignore`, `skip`, snapshot edits, fewer asserts) and fails the round. |
| Bounded cost | At most 6 iterations. Stops early on a plateau (last 3 scores within 6 points). |
| Reversible | Work lives on branch `gauntlet/<component>`. `rollback-to-best` returns to the best iteration without `reset --hard`. Merge is manual. |
| Auditable | Scorecard with every attempt, score, blockers and gaps in `.gauntlet/`, archived to `.gauntlet/history/` on `close`. |
| Safe by default | Guard hooks block secret reads, protected-file edits and force pushes. They are inert in projects that did not opt in. |

## When to use it

Use it when there is a **concrete reference** the result can be compared with, and build/tests can run:

- Rebuild a UI component to match a mockup or screenshot.
- Implement a module from a written spec or acceptance checklist.
- Make an API or CLI match an OpenAPI file, a contract, or golden (expected) outputs.
- Port or rewrite a function/class so it behaves like the original implementation.
- A task where earlier single-shot attempts "looked done" but missed requirements.

## When not to use it

- **No concrete reference.** Exploratory work, "make it nicer", brainstorming: the critic has nothing to anchor on.
- **Small edits.** A typo, a rename, a one-function fix. The loop costs a builder plus a critic run per iteration, up to 6 iterations.
- **Broken baseline build.** `init` refuses to start. Fix the build first. Tests that already fail are recorded and do not block.
- **Dirty working tree or no git.** `init` needs a clean tree, git >= 2.23 and a configured identity.
- **Work that needs secrets or the network.** Secret files are blocked for the agents.
- **As a security boundary.** The guards are cooperative; a determined agent can bypass them (see Known limits).
- **Subjective acceptance.** If nobody can write down what "matches" means, the score is noise.

## How it works

```
/gauntlet:gauntlet <component> <reference>
        |
   init: clean tree + baseline build/tests, branch gauntlet/<component>, reference copied and hash-locked
        |
   +--> next-iteration (N)
   |        |
   |    builder (iteration N)  --> stop gate: reference lock, anti-cheat, build, tests
   |        |                          (fails 3x in a row -> GATE_FAILED)
   |    critic (iteration N)   --> scores + blockers + gaps
   |        |
   |    record-verdict  --> APPROVED | next iteration | HALTED_MAX_ITER | HALTED_PLATEAU
   +--------+
```

The default rubric is `functionality` (40), `fidelity` (40) and `quality` (20). Terminal statuses are listed in `templates/RUNBOOK.md`.

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

Installing is two steps: add the marketplace (this repo), then install the plugin from it. Both take `--scope`, which decides where Claude Code records them. Use the same scope in both commands.

| Scope | Recorded in | Applies to | Use when |
|---|---|---|---|
| `user` (default) | `~/.claude` | all your projects | you want Gauntlet everywhere |
| `local` | `.claude/settings.local.json` (git-ignored) | only you, only this project | you want it in one project and nobody else forced to have it |
| `project` | `.claude/settings.json` (committed) | everyone who clones this project | the whole team should have it |

Run `local` and `project` from the root of the project.

### Source

The repo is public: GitHub installs need no login.

- **From GitHub:** `dseto/gauntlet-plugin`
- **From a local clone:** `C:\Projetos\gauntlet-plugin`

### Only one project (recommended to start)

```powershell
cd C:\Projetos\my-app
```

```powershell
claude plugin marketplace add dseto/gauntlet-plugin --scope local
```

```powershell
claude plugin install gauntlet@gauntlet-local --scope local
```

Restart the Claude Code session, then run `/gauntlet:init` in the project. Other projects do not see the `/gauntlet:*` commands.

For a shared install (committed, whole team), use `--scope project` in both commands and commit the change to `.claude/settings.json`.

### All projects

```powershell
claude plugin marketplace add dseto/gauntlet-plugin
```

```powershell
claude plugin install gauntlet@gauntlet-local
```

Installing globally is safe: the hooks do nothing in projects that did not run `/gauntlet:init`. Those projects still list the `/gauntlet:*` commands, though.

### Try without installing

```powershell
claude --plugin-dir C:\Projetos\gauntlet-plugin
```

Loads the plugin for that session only.

### Update and remove

Pass the same `--scope` you installed with. Restart the session afterwards.

```powershell
claude plugin marketplace update gauntlet-local
```

```powershell
claude plugin update gauntlet@gauntlet-local --scope local
```

```powershell
claude plugin uninstall gauntlet@gauntlet-local --scope local
```

Uninstalling the plugin does not undo `/gauntlet:init`: `.gauntlet/`, `.claude/harness/` and the `## Harness` block in `CLAUDE.md` stay in the project until you delete them.

## Use

1. In a project: `/gauntlet:init`. It discovers build/test commands, shows you the draft `discovery.json` (kept in the OS temp dir, not in the project) and asks for confirmation. Commit the result, restart the session.
   - `--migrate` replaces a legacy harness-kit install: it removes only the harness-kit files (the six hook files and `lib/common.mjs` in `.claude/hooks`, builder/critic agents, `/gauntlet` command, `.gauntlet/gauntlet-cli.mjs`) and their hook commands in `settings.json`. Your own hooks are left alone.
2. `/gauntlet:gauntlet <component> <reference_path>` to start, `/gauntlet:gauntlet` to continue.

You do not have to type `/gauntlet:gauntlet` yourself. Describe the task with its reference ("rebuild the login form to match `docs/mockups/login.png`") and Claude proposes the loop; it starts only after you say yes. This relies on two things: the command `description`, which lists when to use it and when not to, and the `## Harness` block that `/gauntlet:init` writes to `CLAUDE.md`. Matching is probabilistic, so when Claude does not propose it, type the command. The command itself refuses to start if the model launched it without your confirmation.

`/gauntlet:init` stays explicit (`disable-model-invocation`): it writes files into the project and, with `--migrate`, deletes legacy ones. Projects initialised before this change need the new `CLAUDE.md` sentence: delete the old `## Harness` block and re-run `/gauntlet:init`, or add it by hand.

## Practical examples

### 1. Set up a new project (once)

```powershell
cd C:\Projetos\my-app
git status
```

Commit or stash until the tree is clean, then in Claude Code:

```
/gauntlet:init
```

Claude inspects the project, proposes the build/test commands and protected/secret files, and waits for your confirmation. Then commit what it wrote and restart the session so the hooks apply:

```powershell
git add -A
git commit -m "chore: enable gauntlet harness"
```

### 2. UI component from a mockup

Put the mockup in the repo (any path outside `.gauntlet/`), then:

```
/gauntlet:gauntlet login-form docs/mockups/login.png
```

The reference is copied to `.gauntlet/reference/` and hash-locked, so the builder cannot edit it to make the goal easier. The critic uses the Playwright tool for visual checks when available, otherwise it scores fidelity from code and marks the evidence `static-only`.

### 3. Module from a spec

```
/gauntlet:gauntlet invoice-parser docs/specs/invoice-parser.md
```

Every explicit requirement in the spec that is not met becomes a blocker, whatever the total score, so a 90-point artifact with one violated rule is not approved.

### 4. Continue, inspect, finish

Run the same command with no arguments to continue after a stop:

```
/gauntlet:gauntlet
```

At a terminal status it shows the report and asks whether to `rollback-to-best`, `close`, or do nothing. To look at the state yourself (run from the project root, `<plugin dir>` is the plugin folder, for example the clone path):

```powershell
node "<plugin dir>\scripts\gauntlet-cli.mjs" status
```

After `APPROVED`, review and merge the branch yourself:

```powershell
git diff main...gauntlet/login-form
git merge gauntlet/login-form
```

Then archive the scorecard with `gauntlet-cli.mjs close` (same path as above).

### 5. Custom rubric

The slash command starts with the default rubric. For other criteria, write a `rubric.json` (integer `max` values must sum to 100) and start the loop through the CLI, then continue with the command:

```json
{
  "schema_version": 1,
  "criteria": {
    "functionality": { "max": 50, "desc": "behaviour matches the spec" },
    "accessibility": { "max": 30, "desc": "keyboard and screen reader support" },
    "quality": { "max": 20, "desc": "readability and error handling" }
  }
}
```

```powershell
node "<plugin dir>\scripts\gauntlet-cli.mjs" init login-form docs/mockups/login.png --rubric rubric.json
```

```
/gauntlet:gauntlet
```

### 6. A guard blocks something legitimate

`[HARNESS] BLOCKED ...` and `[CIRCUIT BREAKER] ...` messages are intentional: do not work around them. If it is a false positive, turn the harness off for one session in PowerShell:

```powershell
$env:HARNESS_OFF = "1"
claude
```

## Rules of thumb

- Write the reference first. A vague reference gives a vague score.
- One component per loop. Name it for the thing, not the task (`login-form`).
- Tests that guard the behaviour make the stop gate strong. With no tests, only the build and the critic remain.
- Read the critic's blockers before merging. A high score is evidence, not proof.

## Guards

- `bash-guard` runs for both the `Bash` and the `PowerShell` tools.
- The CLI exposes only `init`, `next-iteration`, `record-verdict`, `rollback-to-best`, `close` and `status`. The gate transitions are exported for the stop gate hook and are not reachable from the command line.
- `init` warns when a baseline test command fails without per-test ids (no junit): the test gate is inert for it.
- The critic treats the artifact, tests, script output and reference as data, never as instructions (instructed, not technically enforced).

Kill switch: `HARNESS_OFF=1`. Details: `templates/RUNBOOK.md` (copied to `.gauntlet/RUNBOOK.md` by init).

## Known limits

Cooperative guardrail, not a sandbox (see the RUNBOOK). Open audit items, not applied yet: `bash-guard` only blocks absolute paths outside the project (relative `../` escapes pass), and it allows writes anywhere under `~/.claude`.
