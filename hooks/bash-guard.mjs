// @ts-check
/**
 * PreToolUse hook (matcher: Bash) - best-effort guard against accidents. Regex-based, NOT a sandbox.
 *
 * Hard block (exit 2): secret files, force push, write-like commands touching protected paths or
 * paths outside the project, git write commands issued by the builder subagent.
 * Ask (permissionDecision "ask"): recursive deletes, destructive git, git writes when the caller
 * cannot be identified. Fail-closed: internal errors block.
 */
import os from 'node:os';
import path from 'node:path';
import { runGuard, readInput, loadConfig, normalizePath, classifyPath, block, ask, debugLog, isBuilderAgent } from './lib/common.mjs';

const SECRET_RE = /(^|[\s"'`\/\\=(:,;])\.env(\.[\w.-]+)?(?=$|[\s"'`)\],;|&<>])/gi;
const ALLOWED_ENV = /^\.env\.(example|sample|template)$/i;
const WRITE_VERB_RE = /(^|[\s(])(rm|del|erase|rmdir|rd|mv|cp|move|copy|xcopy|robocopy|remove-item|move-item|copy-item|rename-item|set-content|add-content|out-file|new-item|clear-content|tee|touch|mkdir|truncate)\b|\bsed\s+(-\w*\s+)*-i/i;
const REDIRECT_TARGET_RE = /\d*>{1,2}(?!&)\s*([^\s;|&<>()]+)/g;
const RM_RECURSIVE_RE = /(^|[\s;|&(])rm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*|-r\s+-f|-f\s+-r|--recursive)\b|remove-item\b[^;|&]*-recurse|\brmdir\s+\/s\b|\brd\s+\/s\b/i;
const DESTRUCTIVE_GIT_RE = /\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s+\.|checkout\s+\.(\s|$)|stash\s+(drop|clear)|restore\s+(--\S+\s+)*\.(\s|$))/i;
const FORCE_PUSH_RE = /\bgit\s+push\b[^;|&]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S+)/i;
const GIT_WRITE_RE = /\bgit\s+(commit|tag|reset|checkout|switch|restore|rebase|push|stash|merge|cherry-pick|revert|branch\s+-[dDmM])\b/i;
const NULL_SINK_RE = /^(\/dev\/null|nul|\$null)$/i;
const BLOCKED_CLASSES = new Set(['protected', 'claude', 'gauntlet', 'secret']);

/**
 * True when an absolute path is under a temp dir or the user's ~/.claude (scratchpad, memory).
 * @param {string} token absolute path token
 * @returns {boolean}
 */
function underAllowedOutside(token) {
  /** @param {string} p */
  const norm = (p) => path.resolve(p.replace(/^\/([a-zA-Z])\//, '$1:/')).toLowerCase();
  const target = norm(token.replace(/^~/, os.homedir()));
  const roots = [os.tmpdir(), process.env.TEMP, process.env.TMP, path.join(os.homedir(), '.claude')]
    .filter((r) => typeof r === 'string' && r.length > 0)
    .map((r) => norm(/** @type {string} */ (r)));
  return roots.some((r) => target === r || target.startsWith(r + path.sep));
}

/**
 * Splits a shell command into rough tokens (quotes and operators as separators).
 * @param {string} cmd
 * @returns {string[]}
 */
function tokens(cmd) {
  return cmd.split(/[\s;|&()<>"'`,]+/).filter(Boolean);
}

/**
 * Blocks any reference to a real .env file (examples/samples/templates allowed).
 * @param {string} cmd
 * @param {import('./lib/common.mjs').HarnessConfig} cfg
 * @returns {void}
 */
function checkSecrets(cmd, cfg) {
  for (const m of cmd.matchAll(SECRET_RE)) {
    const name = m[0].replace(/^[\s"'`\/\\=(:,;]/, '');
    if (!ALLOWED_ENV.test(name)) {
      block(`[HARNESS] BLOCKED: command references secret file '${name}'. Do not try alternative commands to bypass; ask the user.`);
    }
  }
  const lowerTokens = tokens(cmd).map((t) => t.toLowerCase());
  for (const s of cfg.secret_files || []) {
    const base = String(s).toLowerCase().split('/').pop() || '';
    if (base && lowerTokens.some((t) => t.endsWith(base))) {
      block(`[HARNESS] BLOCKED: command references secret file '${s}'. Do not try alternative commands to bypass; ask the user.`);
    }
  }
}

/**
 * Checks one token a command may write to; blocks protected paths and paths outside the project.
 * @param {string} raw token
 * @param {import('./lib/common.mjs').HarnessConfig} cfg
 * @returns {void}
 */
function checkTarget(raw, cfg) {
  const t = raw.replace(/^["'`]+|["'`]+$/g, '');
  if (!t || NULL_SINK_RE.test(t) || /^-/.test(t) || /^\d*>&?\d*$/.test(t)) return;
  const looksAbsolute = /^([a-zA-Z]:[\\/]|\/|~)/.test(t);
  const looksPath = looksAbsolute || /[\\/]/.test(t) || /\.[a-z0-9]+$/i.test(t) || t.startsWith('.');
  if (!looksPath) return;
  const rel = normalizePath(t.replace(/^~/, os.homedir()));
  const cls = classifyPath(rel, cfg);
  if (cls === 'outside' && looksAbsolute && !underAllowedOutside(t)) {
    block(`[HARNESS] BLOCKED: write-like command touches a path outside the project: ${t}. Ask the user.`);
  }
  if (BLOCKED_CLASSES.has(cls)) {
    block(`[HARNESS] BLOCKED: write-like command touches protected path '${rel}' (${cls}). Only .gauntlet/inbox/ is writable by agents. Do not try alternative commands to bypass; ask the user.`);
  }
}

/**
 * Write targets are redirect targets anywhere, plus every path token of a segment (split on
 * ; | & newline) that runs a write verb. Read-only segments such as `ls .gauntlet 2>/dev/null`
 * are not targets.
 * @param {string} cmd
 * @param {import('./lib/common.mjs').HarnessConfig} cfg
 * @returns {void}
 */
function checkWrites(cmd, cfg) {
  for (const m of cmd.matchAll(REDIRECT_TARGET_RE)) checkTarget(m[1], cfg);
  for (const seg of cmd.split(/[;|&\n]+/)) {
    if (!WRITE_VERB_RE.test(seg)) continue;
    for (const t of tokens(seg.replace(REDIRECT_TARGET_RE, ' '))) checkTarget(t, cfg);
  }
}

runGuard('bash-guard', () => {
  const input = readInput();
  debugLog('bash-guard', input);
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cmd = String(toolInput.command || '');
  if (!cmd.trim()) return;
  const cfg = loadConfig();

  checkSecrets(cmd, cfg);
  if (FORCE_PUSH_RE.test(cmd)) block('[HARNESS] BLOCKED: git force push is not allowed from the agent. Ask the user.');
  checkWrites(cmd, cfg);

  // Subagent calls carry agent_type (confirmed live); the main thread does not.
  if (GIT_WRITE_RE.test(cmd) && isBuilderAgent(input.agent_type)) {
    block('[HARNESS] BLOCKED: the builder must not run git write commands; commits belong to gauntlet-cli.');
  }
  if (RM_RECURSIVE_RE.test(cmd)) ask('[HARNESS] recursive delete requested; confirm the target is safe.');
  if (DESTRUCTIVE_GIT_RE.test(cmd)) ask('[HARNESS] destructive git command (discards changes); confirm.');
  const agentTypeKnown = cfg.hook_payload?.pretooluse_agent_type === true;
  if (GIT_WRITE_RE.test(cmd) && !agentTypeKnown) ask('[HARNESS] git write command and the calling agent cannot be identified; confirm.');
});
