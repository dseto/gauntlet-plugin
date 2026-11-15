// @ts-check
/**
 * SubagentStop hook (matcher: builder) - quality gate for the Gauntlet builder.
 *
 * Checks, in order: reference lock, acceptance-test lock, anti-cheat diff, build, tests (failures outside
 * the baseline, and fewer executed tests than the baseline), builder_summary.json. On success the checked
 * working tree is pinned by hash and the junit outcomes are stored for record-verdict. Locked acceptance
 * tests that still fail do not fail the gate (they are baseline failures); they leave their requirement
 * unproven at the verdict. exit 2 keeps the builder working, bounded by gate_max_attempts.
 * Infra problems (timeouts, missing executables) mark HALTED_INFRA instead of blaming the builder.
 * Unlike the guards, a crash here exits 0 (fail-closed would trap the builder in a loop); safety
 * comes from record-verdict refusing any iteration whose gate did not pass.
 */
import fs from 'node:fs';
import { isOff, isEnabled, isBuilderAgent, readInput, truncate, debugLog } from './lib/common.mjs';
import { antiCheat } from './anti-cheat-diff.mjs';
import {
  ROOT, P, loadScorecard, loadConfig, readJson, verifyRefLock, verifyAcceptanceLock, runChecks, validateSummary,
  cmdGateAttempt, cmdBuilderPassed, cmdMark, cmdSpecConflict, gateStillValid, testCountDrops,
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
  // Idempotent: a repeated stop (or a stop of another subagent that reached this hook) must not burn an
  // attempt, re-run the checks or wipe the critic report when nothing changed since the gate passed.
  if (gateStillValid(sc)) {
    process.stdout.write('[HARNESS] gate already passed for this tree; nothing to do\n');
    return;
  }

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
  try { verifyAcceptanceLock(sc); } catch (e) { failGate(k, 'acceptance lock', e instanceof Error ? e.message : String(e)); }

  // A declared spec conflict halts the loop and releases the builder: the locked tests it names cannot all pass,
  // so the gate's test checks would only burn attempts. An invalid declaration counts as a failed attempt.
  if (fs.existsSync(P.conflict)) {
    try { process.stdout.write(`${cmdSpecConflict()}\n`); } catch (e) { failGate(k, 'spec conflict', e instanceof Error ? e.message : String(e)); }
    return;
  }

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
  const drops = testCountDrops(sc.baseline_counts, tests.counts);
  if (drops.length) {
    failGate(k, 'tests', 'fewer tests executed than at the baseline (tests removed from collection, skipped, xfail or deselected). '
      + `Restore them; do not hide them:\n${drops.join('\n')}`);
  }

  const n = sc.iteration + 1;
  if (!fs.existsSync(P.summary)) failGate(k, 'builder_summary', `write .gauntlet/inbox/builder_summary.json with iteration ${n}`);
  let summary;
  try { summary = readJson(P.summary); } catch { failGate(k, 'builder_summary', 'not valid JSON'); }
  const errs = validateSummary(summary, n);
  if (errs.length) failGate(k, 'builder_summary', errs.join('; '));

  cmdBuilderPassed(tests.results);
  const locked = sc.acceptance && sc.acceptance.state === 'locked' ? sc.acceptance.tests || {} : {};
  const red = Object.entries(locked).filter(([, ids]) => ids.some((id) => tests.results[id] !== 'pass')).map(([id]) => id);
  process.stdout.write(`[HARNESS] gate passed for iteration ${n}`
    + (red.length ? `; locked acceptance tests still failing: ${red.join(', ')}` : '') + '\n');
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
