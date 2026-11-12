// @ts-check
/**
 * SubagentStop hook (matcher: builder) - quality gate for the Gauntlet builder.
 *
 * Checks, in order: reference lock, anti-cheat diff, build, tests (only failures outside the baseline
 * count), builder_summary.json. exit 2 keeps the builder working, bounded by gate_max_attempts.
 * Infra problems (timeouts, missing executables) mark HALTED_INFRA instead of blaming the builder.
 * Unlike the guards, a crash here exits 0 (fail-closed would trap the builder in a loop); safety
 * comes from record-verdict refusing any iteration whose gate did not pass.
 */
import fs from 'node:fs';
import { isOff, isEnabled, isBuilderAgent, readInput, truncate, debugLog } from './lib/common.mjs';
import { antiCheat } from './anti-cheat-diff.mjs';
import {
  ROOT, P, loadScorecard, loadConfig, readJson, verifyRefLock, runChecks, validateSummary,
  cmdGateAttempt, cmdBuilderPassed, cmdMark,
} from '../scripts/gauntlet-cli.mjs';

/**
 * Marks HALTED_INFRA (best-effort) and releases the builder.
 * @param {string} msg reason
 * @returns {never}
 */
function infra(msg) {
  try { cmdMark('HALTED_INFRA', msg); } catch { /* best-effort: record-verdict still refuses */ }
  process.stderr.write(`[HARNESS] WARN gate infra failure: ${truncate(msg, 20)}\n`);
  process.exit(0);
}

/**
 * Fails this gate attempt: the builder keeps working.
 * @param {string} attempt "k/max"
 * @param {string} check failed check name
 * @param {string} log details
 * @returns {never}
 */
function failGate(attempt, check, log) {
  process.stderr.write(`[HARNESS] FAIL gate attempt ${attempt}: ${check}:\n${truncate(log)}\n`);
  process.exit(2);
}

/**
 * Runs the gate for the current running loop.
 * @param {Record<string, any>} input SubagentStop payload
 * @returns {void}
 */
function runGate(input) {
  if (input.agent_type !== undefined && !isBuilderAgent(input.agent_type)) return;
  const sc = loadScorecard();
  if (!sc || sc.loop_state !== 'running') return;

  let attempt = 0;
  try {
    attempt = Number(cmdGateAttempt());
  } catch (e) {
    infra(`gate counter unavailable (stop_hook_active=${input.stop_hook_active}): ${e instanceof Error ? e.message : e}`);
  }
  if (!Number.isFinite(attempt) || attempt <= 0) infra('gate counter returned an invalid value');
  if (attempt > sc.gate_max_attempts) {
    cmdMark('GATE_FAILED', `builder failed the gate ${sc.gate_max_attempts} times`);
    process.stderr.write('[HARNESS] gate attempts exhausted; loop marked GATE_FAILED\n');
    return;
  }
  const k = `${attempt}/${sc.gate_max_attempts}`;

  try { verifyRefLock(); } catch (e) { failGate(k, 'reference lock', e instanceof Error ? e.message : String(e)); }

  const violations = antiCheat(ROOT, sc.base_sha);
  if (violations.length) failGate(k, 'anti-cheat', violations.map((v) => ' - ' + v).join('\n'));

  const cfg = loadConfig();
  const build = runChecks(cfg, 'build');
  if (build.status === 'infra') infra('build: ' + build.log);
  if (build.status === 'fail') failGate(k, 'build', build.log);

  const tests = runChecks(cfg, 'test');
  if (tests.status === 'infra') infra('tests: ' + tests.log);
  const baseline = new Set(Array.isArray(sc.baseline_failures) ? sc.baseline_failures : []);
  const fresh = tests.failed.filter((id) => !baseline.has(id));
  if (fresh.length) failGate(k, 'tests', `new failures:\n${fresh.join('\n')}\n${tests.log}`);

  const n = sc.iteration + 1;
  if (!fs.existsSync(P.summary)) failGate(k, 'builder_summary', `write .gauntlet/inbox/builder_summary.json with iteration ${n}`);
  let summary;
  try { summary = readJson(P.summary); } catch { failGate(k, 'builder_summary', 'not valid JSON'); }
  const errs = validateSummary(summary, n);
  if (errs.length) failGate(k, 'builder_summary', errs.join('; '));

  cmdBuilderPassed();
  process.stdout.write(`[HARNESS] gate passed for iteration ${n}\n`);
}

if (isOff() || !isEnabled()) process.exit(0);
try {
  const input = readInput();
  debugLog('builder-stop-gate', input);
  runGate(input);
  process.exit(0);
} catch (e) {
  infra(`stop gate internal error: ${e instanceof Error ? e.message : String(e)}`);
}
