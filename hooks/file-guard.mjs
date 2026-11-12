// @ts-check
/**
 * PreToolUse hook (matcher: Edit|Write|MultiEdit|NotebookEdit) - blocks writes to protected paths.
 *
 * Protected: secret files, frozen quality configs, `.claude/**`, `.gauntlet/**` except `.gauntlet/inbox/**`.
 * Paths outside the project (scratchpad, user memory) are intentionally not handled here.
 * Best-effort guardrail, not a sandbox. Fail-closed: malformed input blocks (exit 2).
 */
import { runGuard, readInput, loadConfig, normalizePath, classifyPath, block, debugLog } from './lib/common.mjs';

/** @type {Readonly<Record<string, string>>} reason shown per blocked path class */
const REASONS = Object.freeze({
  secret: 'secret file',
  protected: 'quality/config file frozen by the harness (use HARNESS_OFF=1 for a legitimate change)',
  claude: 'harness files under .claude/',
  gauntlet: 'gauntlet state; agents may only write .gauntlet/inbox/',
});

/**
 * Extracts the target path from the tool input of any file-writing tool.
 * @param {Record<string, unknown>} toolInput
 * @returns {string} the target path
 * @throws {Error} when no path field is present
 */
function targetPath(toolInput) {
  const target = toolInput.file_path || toolInput.notebook_path || toolInput.path;
  if (typeof target !== 'string' || !target.trim()) throw new Error('no file_path in tool_input');
  return target;
}

runGuard('file-guard', () => {
  const input = readInput();
  debugLog('file-guard', input);
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const target = targetPath(toolInput);
  const rel = normalizePath(target);
  const why = REASONS[classifyPath(rel, loadConfig())];
  if (why) {
    block(`[HARNESS] BLOCKED: write to '${rel === null ? target : rel}' denied: ${why}. Do not try alternative commands to bypass; ask the user.`);
  }
});
