// @ts-check
/**
 * Shared helpers for harness hooks.
 * Output is ASCII-only on purpose (Windows consoles); exit 2 is the only blocking exit code in Claude Code.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} HarnessConfig
 * @property {string[]} [secret_files] project-relative secret files (forward slashes)
 * @property {string[]} [protected_files] project-relative frozen quality/config files
 * @property {{ fast_lint?: unknown, build?: unknown, test?: unknown }} [commands] discovered commands
 * @property {{ pretooluse_agent_type?: boolean }} [hook_payload] confirmed hook payload fields
 */

/**
 * @typedef {'outside'|'inbox'|'gauntlet'|'claude'|'secret'|'protected'|'ok'} PathClass
 */

/** @returns {string} absolute project root (CLAUDE_PROJECT_DIR or cwd) */
export function projectDir() {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

/**
 * The plugin is installed globally, so every hook must be a no-op in projects that did not opt in.
 * A project opts in by having `.gauntlet/` or `.claude/harness/discovery.json` (created by `/gauntlet:init`).
 * An opted-in project with a missing/invalid discovery.json still fails closed in the guards.
 * @returns {boolean} true when the current project uses the harness
 */
export function isEnabled() {
  const root = projectDir();
  return fs.existsSync(path.join(root, '.gauntlet')) || fs.existsSync(path.join(root, '.claude', 'harness', 'discovery.json'));
}

/**
 * Plugin agents are namespaced (`gauntlet:builder`); legacy project copies are plain `builder`.
 * @param {unknown} t agent_type or subagent_type
 * @returns {boolean}
 */
export function isBuilderAgent(t) {
  return t === 'builder' || t === 'gauntlet:builder';
}

/** @returns {boolean} true when the kill switch HARNESS_OFF=1 is set */
export function isOff() {
  return process.env.HARNESS_OFF === '1';
}

/**
 * Reads and parses the hook JSON payload from stdin.
 * @returns {Record<string, any>} payload object
 * @throws {Error} when stdin is not a JSON object
 */
export function readInput() {
  const raw = fs.readFileSync(0, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('stdin is not a JSON object');
  return data;
}

/**
 * Normalizes a path to project-relative form: forward slashes, lowercase.
 * Accepts Windows (C:\x), Git Bash (/c/x), relative and ./ forms.
 * @param {unknown} p raw path
 * @param {string} [base] project root
 * @returns {string | null} normalized relative path, or null when outside the project / invalid
 */
export function normalizePath(p, base = projectDir()) {
  if (!p || typeof p !== 'string') return null;
  let s = p.trim().replace(/^["']|["']$/g, '');
  const gitBash = /^\/([a-zA-Z])\/(.*)$/.exec(s);
  if (gitBash) s = `${gitBash[1]}:/${gitBash[2]}`;
  const abs = path.resolve(base, s);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/').toLowerCase();
}

/**
 * Loads `.claude/harness/discovery.json`.
 * @returns {HarnessConfig}
 * @throws {Error} when the file is missing or invalid (guards then fail closed)
 */
export function loadConfig() {
  const f = path.join(projectDir(), '.claude', 'harness', 'discovery.json');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!cfg || typeof cfg !== 'object') throw new Error('discovery.json is not a JSON object');
  return cfg;
}

/**
 * Keeps the last lines of a log and replaces non-ASCII characters.
 * @param {unknown} text
 * @param {number} [lines]
 * @returns {string}
 */
export function truncate(text, lines = 50) {
  const arr = String(text ?? '').split(/\r?\n/);
  const tail = arr.length > lines ? arr.slice(-lines) : arr;
  return tail.join('\n').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?');
}

/**
 * Asks the user to confirm (PreToolUse permissionDecision "ask") and exits 0.
 * @param {string} reason
 * @returns {never}
 */
export function ask(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

/**
 * Blocks the action: message to stderr, exit 2.
 * @param {string} msg
 * @returns {never}
 */
export function block(msg) {
  process.stderr.write(truncate(msg) + '\n');
  process.exit(2);
}

/**
 * Appends sanitized payload metadata (keys only, no contents) to debug.log when HARNESS_DEBUG=1.
 * @param {string} hook hook name
 * @param {Record<string, any>} input payload
 * @returns {void}
 */
export function debugLog(hook, input) {
  if (process.env.HARNESS_DEBUG !== '1') return;
  try {
    const f = path.join(projectDir(), '.claude', 'harness', 'debug.log');
    const entry = {
      ts: new Date().toISOString(), hook,
      keys: Object.keys(input || {}),
      tool_name: input && input.tool_name,
      agent_type: input && input.agent_type,
      stop_hook_active: input && input.stop_hook_active,
      tool_input_keys: input && input.tool_input ? Object.keys(input.tool_input) : null,
    };
    fs.appendFileSync(f, JSON.stringify(entry) + '\n');
  } catch {
    // Debug logging must never affect the hook decision.
  }
}

/**
 * Runs a guard hook fail-closed: any exception blocks with exit 2.
 * @param {string} name hook name for messages
 * @param {() => void} fn guard body; returns normally to allow
 * @returns {never}
 */
export function runGuard(name, fn) {
  if (isOff() || !isEnabled()) process.exit(0);
  try {
    fn();
    process.exit(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    block(`[HARNESS] FAIL internal error in ${name}: ${msg} (blocking by default; set HARNESS_OFF=1 to bypass)`);
  }
}

/**
 * Runs an informative hook fail-open: exceptions only warn, exit 0.
 * @param {string} name hook name for messages
 * @param {() => void} fn hook body
 * @returns {never}
 */
export function runInformative(name, fn) {
  if (isOff() || !isEnabled()) process.exit(0);
  try {
    fn();
    process.exit(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[HARNESS] WARN ${name} internal error: ${truncate(msg, 5)}\n`);
    process.exit(0);
  }
}

/**
 * Classifies a normalized project-relative path against the protection policy.
 * @param {string | null} rel output of normalizePath
 * @param {HarnessConfig} cfg harness config
 * @returns {PathClass}
 */
export function classifyPath(rel, cfg) {
  if (rel === null) return 'outside';
  if (rel.startsWith('.gauntlet/inbox/')) return 'inbox';
  if (rel === '.gauntlet' || rel.startsWith('.gauntlet/')) return 'gauntlet';
  if (rel === '.claude' || rel.startsWith('.claude/')) return 'claude';
  const lower = (/** @type {string[] | undefined} */ list) => (Array.isArray(list) ? list : []).map((s) => String(s).toLowerCase());
  if (lower(cfg.secret_files).includes(rel)) return 'secret';
  if (lower(cfg.protected_files).includes(rel)) return 'protected';
  return 'ok';
}
