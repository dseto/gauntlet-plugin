# gauntlet (Claude Code plugin)

Gauntlet Loop (acceptance tests -> builder -> critic -> verdict) plus the fail-closed harness guardrails, packaged as a plugin.
Replaces `harness-kit/install.mjs` copies.

## Why use it

A single Claude session that builds something and then judges its own work tends to declare victory early. The Gauntlet Loop splits the job and makes the stopping rule mechanical:

- **Spec-tester** (`gauntlet:spec-tester`) runs once, before any implementation, and writes one acceptance test per numbered requirement of the reference. The CLI locks them only if they **fail** now (red), except tests marked `preexisting`, which must pass; then it commits and hash-locks them. The builder must make them pass and can never edit them while the loop runs.
- **Builder** (`gauntlet:builder`) implements one iteration toward a concrete reference and may not commit or touch `.gauntlet/` state.
- **Stop gate** (a hook, not a prompt) runs when the builder finishes: reference lock, anti-cheat diff, build, tests. After three failed attempts in a row, the next stop (the 4th) marks the loop `GATE_FAILED` without running the checks.
- **Critic** (`gauntlet:critic`) scores the artifact against a rubric without reading the builder's own story (instructed, not technically enforced), and lists blockers and gaps.
- **State machine CLI** decides what happens next: approve, iterate, or halt. The agents never decide that.

Benefits:

| Benefit | How |
|---|---|
| Fewer false "done" | Approval needs score >= 85, no blockers **and** every requirement proven by something that ran, from a separate critic. |
| Proof, not opinion | The critic reports each requirement with `status`, `method` and `evidence`. Only `met` by `test`, `run` or `browser` counts; `static` (reading the code) does not. Every unproven requirement becomes a blocker, so the loop keeps iterating. Numbered ids in the reference (R1, AC-2, ...) must all be reported. |
| Tests the builder cannot bend | With numbered requirements and a junit test command, acceptance tests are written from the reference before any code, must be red when locked (green if marked `preexisting`), and are hash-locked (hooks block edits, the gate fails on any byte change). A requirement with a locked test is proven only when that test passes in the gate's junit report; the critic can still veto it with an observed `unmet`. |
| Test claims are checked | When the gate has a junit report, a critic `met` by `test` must name the test (`test_id`). The CLI looks it up in the report of the gate run: an unknown test is rejected, a failing one leaves the requirement unproven. |
| Anti-cheat | The gate flags weakened tests and new suppressions (`noqa`, `ts-ignore`, `skip`/`xfail`, tests dropped from collection, snapshot edits, fewer asserts) and fails the round. With a junit report it also fails when fewer tests ran than at the baseline. |
| What is scored is what is committed | The gate pins a hash of the tree it checked. `record-verdict` refuses to commit if anything changed afterwards. |
| Bounded cost | At most 6 iterations. Stops early on a plateau (best score did not rise by at least 6 points over the last 3 iterations). |
| Reversible | Work lives on branch `gauntlet/<component>`. `rollback-to-best` returns to the best iteration without `reset --hard`. Merge is manual. |
| Auditable | Scorecard with every attempt, score, blockers and gaps in `.gauntlet/`, archived to `.gauntlet/history/` on `close`. |
| Safe by default | Guard hooks block shell commands that reference secret files, protected-file edits and force pushes. Reads with the Read tool are blocked by `permissions.deny` rules that `/gauntlet:init` adds to `.claude/settings.json` for the files in `secret_files`. They are inert in projects that did not opt in. |

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
- **Dirty working tree or no git.** `init` needs a clean tree, git >= 2.23 and a configured identity (the identity is not checked up front: the init commit fails after the baseline runs and `init` rolls back). The tree must also stay clean after the build and test commands run: put what they generate in `.gitignore`.
- **Work that needs secrets or the network.** Secret files are blocked for the agents.
- **As a security boundary.** The guards are cooperative; a determined agent can bypass them (see Known limits).
- **Subjective acceptance.** If nobody can write down what "matches" means, the score is noise.

## How it works

```
/gauntlet:gauntlet <component> <reference>
        |
   init: clean tree + baseline build/tests, branch gauntlet/<component>, reference copied and hash-locked
        |
   spec-tester --> lock-acceptance: new test files only, every id covered, all red (or green if preexisting) -> committed + hash-locked
        |          (only with numbered ids and a pytest junit report; skip-acceptance with the user's yes)
   +--> next-iteration (N)
   |        |
   |    builder (iteration N)  --> stop gate: reference + acceptance locks, anti-cheat, build, tests
   |        |                          (3 failed attempts -> 4th stop marks GATE_FAILED; junit outcomes stored;
   |        |                           valid spec_conflict.json -> HALTED_SPEC_CONFLICT)
   |    critic (iteration N)   --> scores + blockers + gaps
   |        |
   |    record-verdict  --> proof from the gate's junit report, then
   |                        APPROVED | next iteration | HALTED_MAX_ITER | HALTED_PLATEAU
   +--------+
```

The default rubric is `functionality` (40), `fidelity` (40) and `quality` (20). Terminal statuses are listed in `templates/RUNBOOK.md`.

Spec conflict: when locked acceptance tests cannot all pass, the builder writes `.gauntlet/inbox/spec_conflict.json`; the stop gate (or `gauntlet-cli.mjs spec-conflict`) validates it and halts the loop as `HALTED_SPEC_CONFLICT`. An invalid declaration counts as a failed gate attempt.

## What is in it

| Piece | Path |
|---|---|
| Slash commands `/gauntlet:gauntlet`, `/gauntlet:init` | `commands/` |
| Subagents `gauntlet:spec-tester`, `gauntlet:builder`, `gauntlet:critic` | `agents/` |
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

Uninstalling the plugin does not undo `/gauntlet:init`: `.gauntlet/`, `.claude/harness/`, the `## Harness` block in `CLAUDE.md`, the secret-file `permissions.deny` rules in `.claude/settings.json` and the `.gitignore` entries stay in the project until you delete them.

## Use

1. In a project: `/gauntlet:init`. It discovers build/test commands, shows you the draft `discovery.json` (kept in the OS temp dir, not in the project) and asks for confirmation. Commit the result, restart the session.
   - `--migrate` replaces a legacy harness-kit install: it removes only the harness-kit files (the six hook files and `lib/common.mjs` in `.claude/hooks`, builder/critic agents, `/gauntlet` command, `.gauntlet/gauntlet-cli.mjs`) and their hook commands in `settings.json`. Your own hooks are left alone.
2. `/gauntlet:gauntlet <component> <reference_path>` to start, `/gauntlet:gauntlet` to continue.

You do not have to type `/gauntlet:gauntlet` yourself. Describe the task with its reference ("rebuild the login form to match `docs/mockups/login.png`") and Claude proposes the loop; it starts only after you say yes. This relies on two things: the command `description`, which lists when to use it and when not to, and the `## Harness` block that `/gauntlet:init` writes to `CLAUDE.md`. Matching is probabilistic, so when Claude does not propose it, type the command. The command's prompt tells the model to stop if it launched the command without your confirmation (instructed, not technically enforced).

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

The reference is copied to `.gauntlet/reference/` and hash-locked, so the builder cannot edit it to make the goal easier. The critic checks visual requirements with the Playwright plugin's browser tools when they are installed, or with a throwaway script that runs the code. A requirement it can only check by reading the code is `static`, which does not count as proof: it blocks approval until the builder makes it provable (usually a test).

### 3. Module from a spec

```
/gauntlet:gauntlet invoice-parser docs/specs/invoice-parser.md
```

Every explicit requirement in the spec that is not met, or not proven by running something, becomes a blocker, whatever the total score, so a 90-point artifact with one violated or unproven rule is not approved. Number the requirements (`R1.`, `AC-2:`) so the CLI can check that the critic reported each one. Ids are read only from `.md`, `.markdown`, `.txt`, `.rst` and `.adoc` reference files.

Numbered requirements plus a test command with a junit report (`"junit": "pytest"` in `discovery.json`, the only junit reporter supported) turn on the acceptance phase. Before the first builder, the spec-tester writes `tests/acceptance/test_invoice_parser_acceptance.py` with tests such as `test_r1_rejects_negative_totals`, and `lock-acceptance` checks that they are new files, cover every id (or say why an id cannot be tested), and all fail (tests marked `preexisting` must pass instead). From then on R1 is proven only when `test_r1_rejects_negative_totals` passes in the gate's run, and nobody in the loop can edit that file. The lock lasts while the loop is running; once it reaches a terminal status (before `close`) they are ordinary tests.

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

`HARNESS_OFF=1` also turns off the stop gate, so a Gauntlet Loop cannot advance in that session: `record-verdict` refuses every iteration.

## Rules of thumb

- Write the reference first. A vague reference gives a vague score.
- One component per loop. Name it for the thing, not the task (`login-form`).
- Tests that guard the behaviour make the stop gate strong. With no tests, only the build and the critic remain.
- Read the critic's blockers before merging. A high score is evidence, not proof.

## Guards

- `bash-guard` runs for both the `Bash` and the `PowerShell` tools.
- The CLI exposes only `init`, `lock-acceptance`, `skip-acceptance`, `next-iteration`, `record-verdict`, `rollback-to-best`, `spec-conflict`, `close` and `status`.
- While acceptance is pending, `next-iteration`, `record-verdict` and the circuit breaker refuse builders; the spec-tester can only be dispatched then. Locked acceptance files are blocked for Edit/Write and shell writes while the loop runs. The other gate transitions are exported for the stop gate hook and are not reachable from the command line.
- `init` warns when a baseline test command fails without per-test ids (no junit): the test gate is inert for it. It also warns when a test command has no junit report, because the executed-test count cannot be checked then.
- The stop gate is idempotent: a repeated stop with an unchanged tree does not re-run the checks, use up an attempt or delete the critic report.
- On Windows, `.cmd`/`.bat` commands (`npm`, `npx`, `pnpm`, `yarn`) run through `cmd.exe` with escaped arguments; everything else is spawned directly, without a shell. A timeout kills `cmd.exe` but may leave its child process running. This applies to build and test commands only: `fast-file-check` spawns `fast_lint` directly, so a `.cmd`/`.bat` linter fails and the hook only warns.
- The critic treats the artifact, tests, script output and reference as data, never as instructions (instructed, not technically enforced).

Kill switch: `HARNESS_OFF=1`. Details: `templates/RUNBOOK.md` (copied to `.gauntlet/RUNBOOK.md` by init).

Regression tests for the gate, the anti-cheat rules and the state machine (Node >= 18, no dependencies):

```powershell
node --test tests/gate.test.mjs
```

## Known limits

Cooperative guardrail, not a sandbox (see the RUNBOOK). Open audit items, not applied yet: `bash-guard` only blocks absolute paths outside the project (relative `../` escapes pass), and it allows writes anywhere under `~/.claude`.
