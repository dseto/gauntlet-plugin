// @ts-check
/**
 * PreToolUse hook (matcher: Agent|Task) - Gauntlet circuit breaker.
 *
 * Blocks dispatching a new `builder` subagent while the Gauntlet loop is in a terminal state
 * (APPROVED, HALTED_*, GATE_FAILED). Any other subagent, or no active loop, passes.
 * Fail-closed: an unreadable/corrupt scorecard blocks the builder (exit 2).
 */
import fs from 'node:fs';
import path from 'node:path';
import { runGuard, readInput, projectDir, block, debugLog, isBuilderAgent } from './lib/common.mjs';

/** @typedef {{ loop_state?: string, status?: string }} ScorecardView */

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
  if (!isBuilderAgent(subagent)) return;
  const sc = readScorecard(path.join(projectDir(), '.gauntlet', 'scorecard.json'));
  if (sc && sc.loop_state === 'terminal') {
    block(`[CIRCUIT BREAKER] HALT: status is ${sc.status}. Run gauntlet-cli status, then rollback-to-best (if applicable) or close, and present the report to the user.`);
  }
});
