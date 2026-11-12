---
description: Opt the current project into the Gauntlet harness (discovers build/test commands, writes .claude/harness/discovery.json, runs init). Use --migrate to replace a legacy harness-kit install.
argument-hint: "[--migrate]"
disable-model-invocation: true
---

Set up the Gauntlet harness for the current project. Arguments: $ARGUMENTS

1. Inspect the project root (git status must be clean, git repo required). Identify: package manager, a fast single-file linter (or `NONE`), build commands (or `NONE`) and test commands. Run each build/test command once to measure `seconds` and confirm it works. Commands are argument arrays without a shell, e.g. `[".venv/Scripts/python.exe", "-m", "pytest", "-q"]`.
2. List `protected_files` (frozen quality/config files such as `pytest.ini`, `pyproject.toml`, lockfiles, the spec) and `secret_files` (e.g. `.env`). Never read secret files.
3. Write the result to a draft file in the OS temp directory (e.g. `<temp dir>/gauntlet-discovery.json`), NOT inside the project: on a re-init or `--migrate` the harness guards would block writes and deletes under `.claude/`. Follow `${CLAUDE_PLUGIN_ROOT}/templates/discovery.example.json` (same keys, `schema_version: 1`, `hook_payload.pretooluse_agent_type: true`). Show it to the user and ask for confirmation before continuing.
4. On confirmation run (the draft in the temp dir needs no cleanup):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" "<project root>" "<temp dir>/gauntlet-discovery.json" $ARGUMENTS
```

5. Tell the user: commit the harness files (the Gauntlet loop needs a clean tree), and restart the Claude session so the plugin hooks apply. `--migrate` removes the old per-project harness-kit copy (its six hook files and `lib/common.mjs` in `.claude/hooks`, builder/critic agents, `/gauntlet` command, `.gauntlet/gauntlet-cli.mjs`, and its hook commands in `settings.json`) so hooks do not run twice. The project's own hooks are left untouched.
