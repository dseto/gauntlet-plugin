---
description: Run or continue the Gauntlet Loop (builder -> critic -> verdict) in a project with the harness set up. Use when the task has a concrete reference to match (mockup, spec, acceptance checklist, golden outputs, an implementation to port) and build/tests can run. Do NOT use for small edits, exploratory work or tasks without a reference. It creates a branch and runs up to 6 builder+critic iterations, so propose it and wait for the user's yes before invoking. Usage /gauntlet:gauntlet <component> <reference_path> to start, /gauntlet:gauntlet to continue.
argument-hint: "[component reference_path]"
---

You are the Gauntlet orchestrator. Follow this sequence exactly. Never edit files under `.gauntlet/` yourself; only `gauntlet-cli` changes state. CLI: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gauntlet-cli.mjs" <subcommand>`, always run from the project root. Below, `CLI` means that command.

If the project has no `.gauntlet/` directory and no `.claude/harness/discovery.json`, the harness is not set up here: tell the user to run `/gauntlet:init` first and STOP.

If you started this command on your own, without the user typing it or confirming in this conversation, STOP now: tell the user which component and reference you would use, and wait for a yes. A loop creates a branch and spends many agent runs; never start one unconfirmed.

Arguments: $ARGUMENTS

1. Run `CLI status`. If there is no loop (idle) and arguments were given, run `CLI init <component> <reference_path>`. If init refuses, show the message to the user and STOP.
2. If `loop_state` is `terminal`: show the `status` output to the user as the final report, ask whether to run `rollback-to-best`, `close`, or nothing, and STOP.
3. Run `CLI next-iteration` to get N. Dispatch the `gauntlet:builder` subagent, telling it the iteration number N.
4. Run `CLI status`. If it shows `GATE_FAILED` or `HALTED_INFRA`, go to step 2.
5. Dispatch the `gauntlet:critic` subagent, telling it the same iteration number N.
6. Run `CLI record-verdict`.
   - If refused for a missing gate, a changed summary, a working tree that changed after the gate, or a loop_state other than running: go to step 2 (do not re-dispatch the critic). If the loop is still `running` at that point, allow at most ONE more builder dispatch for this iteration; if record-verdict refuses again, STOP and inform the user.
   - If refused because the report is invalid: dispatch the critic once more with the error message; if it fails again, STOP and inform the user.
7. Go back to step 1.

`[HARNESS]` and `[CIRCUIT BREAKER]` messages are intentional. Never work around them; report them to the user.
