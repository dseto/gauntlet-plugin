// @ts-check
/**
 * PreToolUse hook (matcher: Agent|Task) - Gauntlet circuit breaker.
 *
 * Blocks dispatching a new `builder` subagent while the Gauntlet loop is in a terminal state
 * (APPROVED, HALTED_*, GATE_FAILED) or its acceptance tests are not locked yet, and a `spec-tester`
 * outside the pending acceptance phase. Any other subagent, or no active loop, passes.
 * Fail-closed: an unreadable/corrupt scorecard blocks the builder (exit 2).
 */
import fs from 'node:fs';
import path from 'node:path';
import { runGuard, readInput, projectDir, block, debugLog, isBuilderAgent, isSpecTesterAgent } from './lib/common.mjs';

/** @typedef {{ loop_state?: string, status?: string, acceptance?: { state?: string } }} ScorecardView */

/**
 * Reads the scorecard when present.
 * @param {string} file absolute path to scorecard.json
 * @returns {ScorecardView | null} parsed scorecard, or null when no loop exists
 * @throws {Error} when the file exists but is not a JSON object
 */
function readScorecard(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('scorecard.json is not a JSON object');
  return /** @type {ScorecardView} */ (parsed);
}

runGuard('orchestrator-breaker', () => {
  const input = readInput();
  debugLog('orchestrator-breaker', input);
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const subagent = String(toolInput.subagent_type || '');
  const builder = isBuilderAgent(subagent);
  const specTester = isSpecTesterAgent(subagent);
  if (!builder && !specTester) return;
  const sc = readScorecard(path.join(projectDir(), '.gauntlet', 'scorecard.json'));
  if (sc && sc.loop_state === 'terminal') {
    block(`[CIRCUIT BREAKER] HALT: status is ${sc.status}. Run gauntlet-cli status, then rollback-to-best (if applicable) or close, and present the report to the user.`);
  }
  const pending = !!sc && sc.loop_state === 'running' && !!sc.acceptance && sc.acceptance.state === 'pending';
  if (builder && pending) {
    block('[CIRCUIT BREAKER] acceptance tests are not locked yet: dispatch gauntlet:spec-tester and run gauntlet-cli lock-acceptance (or skip-acceptance with the user\'s yes) before any builder.');
  }
  if (specTester && !pending) {
    block('[CIRCUIT BREAKER] the spec-tester only runs while the acceptance phase is pending (right after init); it is not pending now.');
  }
});
