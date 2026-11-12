// @ts-check
/**
 * Utility (not a registered hook): detects suppressions and weakened tests since a base commit.
 * Heuristic (regex + assert counting), not proof. `.gauntlet/**` and `.claude/**` are excluded
 * (protected by file-guard and the reference lock; the reference may contain legit suppressions).
 * Usage: node anti-cheat-diff.mjs --base <sha>   -> exit 0 clean, exit 2 violations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** @typedef {{ st: string, old: string | null, p: string }} Change one changed path (st: git status letter, '?' untracked) */
/** @typedef {{ path: string, rule: string, reason?: string }} AllowEntry */

/** @type {Array<[string, RegExp]>} rule name (allowlist key) and its detector */
const RULES = [
  ['ts-ignore', /@ts-ignore\b/],
  ['ts-expect-error', /@ts-expect-error\b/],
  ['eslint-disable', /eslint-disable/],
  ['type-ignore', /#\s*type:\s*ignore\b/],
  ['noqa', /#\s*noqa\b/],
  ['skip', /\b(test|it|describe)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\[Fact\(Skip\s*=|@pytest\.mark\.skip(if)?\b|\bpytest\.skip\s*\(|@unittest\.skip/],
];
const ASSERT_RE = /\bexpect\s*\(|\bassert\b|\bAssert\.|\bself\.assert\w*\s*\(|\bpytest\.raises\s*\(/g;
const COMMENTED_TEST_RE = /^\s*(#|\/\/)\s*(def test_|async def test_|it\s*\(|test\s*\(|describe\s*\(|assert\b|expect\s*\()/;

/**
 * Runs git without a shell.
 * @param {string} cwd repository root
 * @param {string[]} args git arguments
 * @returns {string} stdout
 * @throws {Error} on spawn failure or non-zero exit
 */
function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

/**
 * @param {string} p repo-relative path with forward slashes
 * @returns {boolean} true for test files (tests/ dirs, test_*.py, *_test.py, *.test|spec.[jt]s)
 */
export function isTestFile(p) {
  const b = p.split('/').pop() || '';
  return /(^|\/)(tests?|__tests__)\//.test(p) || /^test_.*\.py$/.test(b) || /_test\.py$/.test(b) || /\.(test|spec)\.[jt]sx?$/.test(b);
}

/** @param {string} p @returns {boolean} true for paths owned by the harness itself */
function excluded(p) {
  return p.startsWith('.gauntlet/') || p.startsWith('.claude/');
}

/** @param {string} text @returns {number} number of assertion-like calls */
function countAsserts(text) {
  return (String(text).match(ASSERT_RE) || []).length;
}

/**
 * @param {string} pkgText package.json contents
 * @returns {string | null} canonical form of scripts.test* (null when unparsable)
 */
function testScripts(pkgText) {
  try {
    const s = (JSON.parse(pkgText).scripts) || {};
    return JSON.stringify(Object.keys(s).filter((k) => k.startsWith('test')).sort().map((k) => [k, s[k]]));
  } catch { return null; }
}

/**
 * @param {string} file JSON file path
 * @param {T} fallback value when the file does not exist
 * @returns {T}
 * @template T
 */
function readJsonOr(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

/**
 * Lists anti-cheat violations between `base` and the working tree (tracked + untracked).
 * @param {string} root repository root
 * @param {string} base base commit (sha or HEAD-relative ref)
 * @returns {string[]} human-readable violations; empty means clean
 * @throws {Error} on invalid base or git failure
 */
export function antiCheat(root, base) {
  if (typeof base !== 'string' || !/^([0-9a-f]{7,40}|HEAD[~^\d]*)$/.test(base)) throw new Error(`invalid base: ${base}`);
  const cfg = readJsonOr(path.join(root, '.claude', 'harness', 'discovery.json'), {});
  /** @type {AllowEntry[]} */
  const allow = readJsonOr(path.join(root, '.claude', 'harness', 'allowed-suppressions.json'), []);
  if (!Array.isArray(allow)) throw new Error('allowed-suppressions.json must be an array');
  /** @type {(p: string, rule: string) => boolean} */
  const allowed = (p, rule) => allow.some((a) => a.path && a.path.toLowerCase() === p.toLowerCase() && a.rule === rule);
  const protectedFiles = (Array.isArray(cfg.protected_files) ? cfg.protected_files : []).map((/** @type {string} */ s) => s.toLowerCase());
  /** @type {string[]} */
  const violations = [];

  // Tracked changes (with rename detection) + untracked files.
  /** @type {Change[]} */
  const changes = [];
  for (const line of git(root, ['diff', '-M', '--name-status', base]).split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const st = parts[0][0];
    if (st === 'R') changes.push({ st, old: parts[1], p: parts[2] });
    else changes.push({ st, old: parts[1], p: parts[1] });
  }
  for (const p of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    changes.push({ st: '?', old: null, p });
  }

  for (const c of changes) {
    if (excluded(c.p)) continue;
    const lower = c.p.toLowerCase();

    if (c.st === 'D' && isTestFile(c.p)) violations.push(`test file deleted: ${c.p}`);
    if (/(^|\/)__snapshots__\/|\.snap$/.test(c.p) && !allowed(c.p, 'snapshot')) violations.push(`snapshot changed: ${c.p}`);

    if (protectedFiles.includes(lower) || protectedFiles.includes((c.old || '').toLowerCase())) {
      if (lower.endsWith('package.json') && c.st === 'M') {
        const before = testScripts(git(root, ['show', `${base}:${c.p}`]));
        const after = testScripts(fs.readFileSync(path.join(root, c.p), 'utf8'));
        if (before !== after) violations.push(`package.json test scripts changed: ${c.p}`);
      } else {
        violations.push(`protected file changed (${c.st}): ${c.p}`);
      }
    }
    if (c.st === 'D') continue;

    // Added lines.
    /** @type {string[]} */
    let added = [];
    if (c.st === '?') {
      added = fs.readFileSync(path.join(root, c.p), 'utf8').split(/\r?\n/);
    } else {
      const diff = git(root, ['diff', '-M', '-U0', base, '--', ...(c.old && c.old !== c.p ? [c.old, c.p] : [c.p])]);
      added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    }
    for (const l of added) {
      for (const [rule, re] of RULES) {
        if (re.test(l) && !allowed(c.p, rule)) violations.push(`suppression '${rule}' added in ${c.p}: ${l.trim().slice(0, 120)}`);
      }
      if (isTestFile(c.p) && COMMENTED_TEST_RE.test(l)) violations.push(`commented-out test code in ${c.p}: ${l.trim().slice(0, 120)}`);
    }

    // Assert count must not drop in existing test files (renames compare against the old path).
    if (isTestFile(c.p) && (c.st === 'M' || c.st === 'R')) {
      const before = countAsserts(git(root, ['show', `${base}:${c.old || c.p}`]));
      const after = countAsserts(fs.readFileSync(path.join(root, c.p), 'utf8'));
      if (after < before) violations.push(`asserts reduced in ${c.p}: ${before} -> ${after}`);
    }
  }
  return violations;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const i = process.argv.indexOf('--base');
    const base = i > 0 ? process.argv[i + 1] : null;
    if (!base) throw new Error('usage: anti-cheat-diff --base <sha>');
    const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, shell: false }).status !== 0) {
      process.stderr.write('[HARNESS] WARN anti-cheat skipped (no git)\n');
      process.exit(0);
    }
    const v = antiCheat(root, base);
    if (v.length) {
      process.stderr.write('[HARNESS] FAIL anti-cheat:\n' + v.map((x) => ' - ' + x).join('\n').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?') + '\n');
      process.exit(2);
    }
    process.stdout.write('[HARNESS] anti-cheat clean\n');
  } catch (e) {
    process.stderr.write(`[HARNESS] FAIL anti-cheat internal error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}
