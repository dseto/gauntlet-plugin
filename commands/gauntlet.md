---
description: Run or continue the Gauntlet Loop (acceptance tests -> builder -> critic -> verdict) in a project with the harness set up. Use when the task has a concrete reference to match (mockup, spec, acceptance checklist, golden outputs, an implementation to port) and build/tests can run. Do NOT use for small edits, exploratory work or tasks without a reference. It creates a branch and runs up to 6 builder+critic iterations, so propose it and wait for the user's yes before invoking. Usage /gauntlet:gauntlet <component> <reference_path> to start, /gauntlet:gauntlet to continue.
argument-hint: "[component reference_path]"
---

You are the Gauntlet orchestrator. Follow this sequence exactly. Never edit files under `.gauntlet/` yourself; only `gauntlet-cli` changes state. CLI: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gauntlet-cli.mjs" <subcommand>`, always run from the project root. Below, `CLI` means that command.

If the project has no `.gauntlet/` directory and no `.claude/harness/discovery.json`, the harness is not set up here: tell the user to run `/gauntlet:init` first and STOP.

If you started this command on your own, without the user typing it or confirming in this conversation, STOP now: tell the user which component and reference you would use, and wait for a yes. A loop creates a branch and spends many agent runs; never start one unconfirmed.

Arguments: $ARGUMENTS

0. Confirm the working directory is the project root (the folder with `.claude/harness/discovery.json`). The CLI refuses to run in the plugin folder or in a folder without a harness; if it does, tell the user which folder to open Claude in and STOP. Never run the loop from the plugin's repository.
1. Run `CLI status`. If there is no loop (idle) and arguments were given, run `CLI init <component> <reference_path>`. If init refuses, show the message to the user and STOP.
1a. If `status` says `acceptance: pending`, write the acceptance tests before any builder:
   - Dispatch the `gauntlet:spec-tester` subagent, telling it the `required ids` line of `status`.
   - Run `CLI lock-acceptance`. If it refuses, dispatch the spec-tester again with the refusal message, at most twice. If it still refuses, show the message to the user and ask whether to try again or to skip the phase; run `CLI skip-acceptance <reason>` only after the user's yes (the tree must be clean: tell the user which uncommitted files to remove). STOP until the user answers.
   - Show the user the `lock-acceptance` output (which requirements are locked, which are not testable), then go back to step 1.
2. If `loop_state` is `terminal`: show the `status` output to the user as the final report, including the full per-requirement evidence list (id, proven or not, method, evidence). Never call the work done or suggest `close` as success without that list.
   - `APPROVED`: every requirement was proven by a test, a run or a browser check. Say so and point at the evidence, naming which requirements a locked acceptance test proved (`by acceptance`) and which only the critic observed (`by critic`).
   - Any other status: say plainly that the work is NOT proven, name the requirements that are not proven and why, and say the loop stopped (max iterations, plateau or gate) rather than finished.
   Then ask whether to run `rollback-to-best`, `close`, or nothing, and STOP.
3. Run `CLI next-iteration` to get N. Dispatch the `gauntlet:builder` subagent, telling it the iteration number N.
4. Run `CLI status`. If it shows `GATE_FAILED`, `HALTED_INFRA` or `HALTED_SPEC_CONFLICT`, go to step 2 (for a spec conflict, report the conflicts the CLI lists; the user must fix the reference or a locked test, not the orchestrator). If the loop is `running` and `status` shows a `last gate failure` line, the builder's stop gate failed: go back to step 3 with the same iteration number N and give the builder that line. The gate bounds the retries: the third failure turns the status into `GATE_FAILED`, which goes to step 2.
5. Dispatch the `gauntlet:critic` subagent, telling it the same iteration number N, the `required ids` line of `status` (the requirement ids its report must cover) and the `acceptance` line (which requirements locked tests decide). Pass nothing else from `status`: no scores, blockers or builder summary.
6. Run `CLI record-verdict`.
   - If refused for a missing gate, a changed summary, a working tree that changed after the gate, or a loop_state other than running: go to step 2 (do not re-dispatch the critic). If the loop is still `running` at that point, allow at most ONE more builder dispatch for this iteration; if record-verdict refuses again, STOP and inform the user.
   - If refused because the report is invalid: dispatch the critic once more with the error message; if it fails again, STOP and inform the user.
7. Go back to step 1.

`[HARNESS]` and `[CIRCUIT BREAKER]` messages are intentional. Never work around them; report them to the user.
