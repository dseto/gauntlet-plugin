// @ts-check
/**
 * PostToolUse hook (matcher: Edit|Write|MultiEdit) - fast single-file check.
 *
 * Runs AFTER the edit and does NOT revert it: exit 2 only feeds the error back so the agent fixes the file.
 * Skips harness files, docs and config formats, and does nothing when `fast_lint` is NONE.
 * Fail-open: internal errors only warn (exit 0).
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInformative, readInput, loadConfig, normalizePath, projectDir, truncate, debugLog } from './lib/common.mjs';

/** @typedef {{ cmd: string[], exts: string[] }} FastLint */

/** Extensions never linted (docs and config formats). */
const SKIP_EXT = new Set(['.md', '.json', '.toml', '.ini', '.cfg', '.yaml', '.yml', '.txt', '.lock']);
const LINT_TIMEOUT_MS = 10000;

/**
 * Returns the configured fast linter when it applies to the extension.
 * @param {unknown} lint `commands.fast_lint` from discovery.json
 * @param {string} ext file extension, including the dot
 * @returns {FastLint | null}
 */
function applicableLint(lint, ext) {
  if (!lint || lint === 'NONE' || typeof lint !== 'object') return null;
  const l = /** @type {FastLint} */ (lint);
  if (!Array.isArray(l.cmd) || l.cmd.length === 0 || !Array.isArray(l.exts)) return null;
  return l.exts.includes(ext) ? l : null;
}

runInformative('fast-file-check', () => {
  const input = readInput();
  debugLog('fast-file-check', input);
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  const rel = normalizePath(filePath);
  if (rel === null || rel.startsWith('.gauntlet/') || rel.startsWith('.claude/')) return;
  const ext = path.extname(rel);
  if (SKIP_EXT.has(ext)) return;
  const lint = applicableLint(loadConfig().commands?.fast_lint, ext);
  if (!lint) return;

  const [exe0, ...args] = lint.cmd;
  const exe = /[\\/]/.test(exe0) ? path.resolve(projectDir(), exe0) : exe0;
  const abs = path.resolve(projectDir(), filePath);
  const r = spawnSync(exe, [...args, abs], { cwd: projectDir(), encoding: 'utf8', timeout: LINT_TIMEOUT_MS, shell: false });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    process.stderr.write(`[HARNESS] FAIL fast check on ${rel} (file already saved; fix it):\n${truncate((r.stdout || '') + (r.stderr || ''))}\n`);
    process.exit(2);
  }
});
