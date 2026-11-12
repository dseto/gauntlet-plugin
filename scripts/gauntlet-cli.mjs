#!/usr/bin/env node
// @ts-check
/**
 * Deterministic state machine for the Gauntlet Loop. Agents never edit state; only this CLI writes
 * outside .gauntlet/inbox/. All child processes run without a shell (argument arrays) so pathspecs
 * and quotes survive on Windows. Every JSON write is atomic (temp file + rename).
 *
 * Subcommands: init, next-iteration, record-verdict, rollback-to-best, close, status.
 * The gate transitions (cmdGateAttempt, cmdBuilderPassed, cmdMark) are exported for the stop gate hook
 * only and are deliberately not reachable from the command line.
 */
/**
 * @typedef {object} Attempt
 * @property {number} iteration
 * @property {string} sha commit recorded for this iteration
 * @property {string} builder_summary text of the builder summary
 * @property {number} score
 * @property {Record<string, number>} breakdown
 * @property {string[]} blockers
 * @property {string[]} gaps
 */
/**
 * @typedef {object} Scorecard
 * @property {1} schema_version
 * @property {'idle'|'running'|'terminal'} loop_state
 * @property {string} status IN_PROGRESS | APPROVED | HALTED_MAX_ITER | HALTED_PLATEAU | GATE_FAILED | HALTED_INFRA
 * @property {string} component
 * @property {string} branch
 * @property {string} base_sha
 * @property {number} iteration
 * @property {number} max_iterations
 * @property {number} pass_threshold
 * @property {number} plateau_epsilon
 * @property {number} gate_max_attempts
 * @property {number} gate_attempts_current
 * @property {string[]} baseline_failures
 * @property {Record<string, TestCounts>} [baseline_counts] per test command, from the junit report at init
 * @property {number} [plateau_window] iterations the best score may stay flat (default 3)
 * @property {number | null} gate_passed_iteration
 * @property {string | null} builder_summary_sha256
 * @property {string | null} [gate_tree] git tree hash of the working tree that passed the gate
 * @property {{ iteration: number | null, score: number, sha: string | null }} best
 * @property {number[]} score_history
 * @property {Attempt[]} attempts
 * @property {string[]} [warnings]
 * @property {string} [halt_reason]
 */
/**
 * @typedef {object} CheckCommand
 * @property {string} name
 * @property {string} [cwd] project-relative working directory
 * @property {string[]} cmd executable + arguments (no shell)
 * @property {number} [seconds] duration measured at discovery (timeout = max(60, 2x))
 * @property {'pytest'} [junit] reporter used to extract failing test ids
 */
/** @typedef {{ tests: number, skipped: number }} TestCounts collected test cases and how many were skipped (xfail included) */
/** @typedef {{ status: 'ok'|'fail'|'infra', failed: string[], log: string, warnings?: string[], counts?: Record<string, TestCounts> }} CheckResult */
/** @typedef {{ schema_version: number, criteria: Record<string, { max: number, desc?: string }> }} Rubric */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The CLI ships inside the plugin, so the project is CLAUDE_PROJECT_DIR (hooks) or the cwd (orchestrator Bash calls).
export const ROOT = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const G = path.join(ROOT, '.gauntlet');
export const P = {
  scorecard: path.join(G, 'scorecard.json'),
  refDir: path.join(G, 'reference'),
  refLock: path.join(G, 'ref-lock.json'),
  rubric: path.join(G, 'rubric.json'),
  inbox: path.join(G, 'inbox'),
  summary: path.join(G, 'inbox', 'builder_summary.json'),
  report: path.join(G, 'inbox', 'critic_report.json'),
  history: path.join(G, 'history'),
  config: path.join(ROOT, '.claude', 'harness', 'discovery.json'),
};
/** @type {Rubric} */
const DEFAULT_RUBRIC = {
  schema_version: 1,
  criteria: {
    functionality: { max: 40, desc: 'contratos, comportamento, casos de borda' },
    fidelity: { max: 40, desc: 'aderencia a referencia (visual para UI; API/saida para backend)' },
    quality: { max: 20, desc: 'legibilidade, resiliencia, tratamento de erro' },
  },
};

/** Expected failure with a user-facing ASCII message (exit 1, no stack trace). */
export class CliError extends Error {}

/**
 * @param {string} msg
 * @returns {never}
 */
const fail = (msg) => { throw new CliError(msg); };

// ---------- io ----------

/**
 * @param {string} f JSON file path
 * @returns {any} parsed JSON
 */
export function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }

/**
 * Writes JSON atomically (temp file + rename) so readers never see a partial file.
 * @param {string} f target path
 * @param {unknown} data serializable value
 * @returns {void}
 */
export function writeJsonAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, f);
}

/** @param {string} f @returns {string} hex SHA-256 of the file bytes */
export function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

/**
 * @returns {Scorecard | null} current scorecard, or null when idle
 * @throws {CliError} when the scorecard exists but is corrupt
 */
export function loadScorecard() {
  if (!fs.existsSync(P.scorecard)) return null;
  const sc = readJson(P.scorecard);
  if (!sc || typeof sc !== 'object' || typeof sc.iteration !== 'number') fail('[GAUNTLET] FAIL scorecard.json is corrupt');
  return sc;
}

/** @returns {any} `.claude/harness/discovery.json` */
export function loadConfig() { return readJson(P.config); }

// ---------- git ----------

/**
 * Runs git in the project root without a shell.
 * @param {string[]} args
 * @param {{ allowFail?: boolean, env?: NodeJS.ProcessEnv }} [opts] allowFail returns the exit code instead of throwing
 * @returns {{ code: number | null, out: string }}
 * @throws {CliError} on non-zero exit unless allowFail
 */
export function git(args, { allowFail = false, env = process.env } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: ROOT, encoding: 'utf8', shell: false, env, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) fail(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return { code: r.status, out: (r.stdout || '').trim() };
}

/**
 * Ensures a git work tree with git >= 2.23 (needed for `git restore`).
 * @returns {void}
 * @throws {CliError}
 */
function requireGit() {
  if (spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, shell: false }).status !== 0) {
    fail('[GAUNTLET] FAIL git repository required');
  }
  const v = /(\d+)\.(\d+)/.exec(git(['--version']).out);
  if (!v || Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 23)) fail('[GAUNTLET] FAIL git >= 2.23 required (git restore)');
}
/** @returns {boolean} true when `git status --porcelain` is empty (ignored files excluded) */
function treeClean() { return git(['status', '--porcelain']).out === ''; }

// What an iteration commit contains: everything except the harness files. The gate hash also leaves out
// the loop state the CLI and the agents write between the gate and the verdict.
const COMMIT_SPEC = ['.', ':(exclude).claude'];
const LOOP_STATE = ['.gauntlet/inbox', '.gauntlet/history', '.gauntlet/scorecard.json'];

/**
 * Hashes the working tree as git would commit it (tracked + untracked, ignored files excluded) using a
 * temporary index, so the real index is never touched.
 * @returns {string} git tree object id
 * @throws {CliError} on git failure
 */
export function worktreeTreeHash() {
  const idx = path.join(os.tmpdir(), `gauntlet-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    git(['read-tree', 'HEAD'], { env });
    git(['add', '-A', '--', ...COMMIT_SPEC], { env });
    // Dropped from the index afterwards: naming an ignored path in a pathspec makes `git add` fail.
    git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...LOOP_STATE], { env });
    return git(['write-tree'], { env }).out;
  } finally {
    fs.rmSync(idx, { force: true });
    fs.rmSync(`${idx}.lock`, { force: true });
  }
}

/**
 * True when the gate already passed for the pending iteration and neither the working tree nor the
 * builder summary changed since. A repeated stop hook is then a no-op.
 * @param {Scorecard} sc
 * @returns {boolean}
 */
export function gateStillValid(sc) {
  return sc.gate_passed_iteration === sc.iteration + 1 && !!sc.gate_tree
    && fs.existsSync(P.summary) && sha256File(P.summary) === sc.builder_summary_sha256
    && worktreeTreeHash() === sc.gate_tree;
}

// ---------- checks (build/test), shared with the stop gate ----------

/** @param {CheckCommand} c @returns {number} child timeout in ms: max(60s, 2x measured) */
function childTimeout(c) { return Math.max(60, Math.round((c.seconds || 0) * 2)) * 1000; }

/**
 * Reads a JUnit XML report: failing test ids (`classname::name`), collected test cases and skipped ones
 * (pytest reports xfail as skipped).
 * @param {string} xml
 * @returns {{ failed: string[] } & TestCounts}
 */
export function parseJunit(xml) {
  /** @type {string[]} */
  const failed = [];
  let tests = 0;
  let skipped = 0;
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const body = m[3] || '';
    tests += 1;
    if (/<skipped\b/.test(body)) skipped += 1;
    if (/<(failure|error)\b/.test(body)) {
      /** @param {string} n @returns {string} */
      const attr = (n) => ((new RegExp(`\\b${n}="([^"]*)"`).exec(attrs) || [])[1] || '');
      failed.push(`${attr('classname')}::${attr('name')}`);
    }
  }
  return { failed, tests, skipped };
}

/**
 * Lists test commands that executed fewer tests than the baseline. Removing tests from collection,
 * skipping or xfail-ing them does not create a new failure, so the failure diff alone misses it.
 * @param {Record<string, TestCounts> | undefined} base counts recorded at init
 * @param {Record<string, TestCounts> | undefined} now counts of the current run
 * @returns {string[]} human-readable drops; empty means none
 */
export function testCountDrops(base, now) {
  /** @type {string[]} */
  const out = [];
  for (const [name, b] of Object.entries(base || {})) {
    const n = now && now[name];
    const before = b.tests - b.skipped;
    if (!n) { out.push(`${name}: no test report (baseline executed ${before})`); continue; }
    const after = n.tests - n.skipped;
    if (after < before) out.push(`${name}: executed ${before} -> ${after} (collected ${b.tests} -> ${n.tests}, skipped ${b.skipped} -> ${n.skipped})`);
  }
  return out;
}

// cmd.exe metacharacters, escaped with ^ when a .cmd/.bat has to run through cmd.exe.
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

/**
 * @param {string} arg one argument
 * @param {boolean} twice escape twice (npm .bin shims re-parse their arguments)
 * @returns {string} argument quoted for a cmd.exe command line
 */
function cmdArg(arg, twice) {
  let a = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`.replace(CMD_META_RE, '^$1');
  return twice ? a.replace(CMD_META_RE, '^$1') : a;
}

/**
 * Windows only: finds the file a bare command name resolves to (PATH + .com/.exe/.bat/.cmd).
 * @param {string} cmd0 executable as written in the config
 * @param {string} cwd working directory of the command
 * @returns {string | null} full path, or null when nothing matches
 */
function resolveWinExe(cmd0, cwd) {
  const hasDir = /[\\/]/.test(cmd0);
  const dirs = hasDir ? [path.dirname(path.resolve(cwd, cmd0))] : [cwd, ...String(process.env.PATH || process.env.Path || '').split(';').filter(Boolean)];
  const exts = path.extname(cmd0) ? [''] : ['.com', '.exe', '.bat', '.cmd'];
  for (const d of dirs) {
    for (const e of exts) {
      const f = path.join(d, path.basename(cmd0) + e);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * Builds the spawn call for a check command. Node cannot spawn .cmd/.bat without a shell on Windows
 * (ENOENT for `npm`, EINVAL for `npm.cmd`), so those run through cmd.exe with every argument escaped.
 * Anything else is spawned directly, as written.
 * @param {string[]} cmd executable + arguments
 * @param {string} cwd working directory
 * @param {NodeJS.Platform} [platform]
 * @returns {{ exe: string, args: string[], verbatim: boolean }}
 */
export function spawnPlan(cmd, cwd, platform = process.platform) {
  const exe = /[\\/]/.test(cmd[0]) ? path.resolve(cwd, cmd[0]) : cmd[0];
  const args = cmd.slice(1);
  if (platform !== 'win32') return { exe, args, verbatim: false };
  const found = resolveWinExe(cmd[0], cwd);
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { exe, args, verbatim: false };
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(found);
  const line = [path.normalize(found).replace(CMD_META_RE, '^$1'), ...args.map((a) => cmdArg(a, twice))].join(' ');
  return { exe: process.env.ComSpec || process.env.comspec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/**
 * Runs one build/test command without a shell, classifying the outcome.
 * Timeouts and spawn errors are 'infra' (not the builder's fault).
 * @param {CheckCommand} c
 * @returns {CheckResult}
 */
export function runCommand(c) {
  if (!c || !Array.isArray(c.cmd) || c.cmd.length === 0) return { status: 'infra', failed: [], log: 'invalid command config' };
  const cmd = [...c.cmd];
  /** @type {string | null} */
  let junitFile = null;
  if (c.junit === 'pytest') {
    junitFile = path.join(os.tmpdir(), `gauntlet-junit-${process.pid}-${Date.now()}.xml`);
    cmd.push(`--junitxml=${junitFile}`);
  }
  const cwd = path.join(ROOT, c.cwd || '.');
  const plan = spawnPlan(cmd, cwd);
  const r = spawnSync(plan.exe, plan.args, {
    cwd, encoding: 'utf8', shell: false, windowsVerbatimArguments: plan.verbatim, timeout: childTimeout(c), maxBuffer: 64 * 1024 * 1024,
  });
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  /** @type {ReturnType<typeof parseJunit> | null} */
  let junit = null;
  if (junitFile && fs.existsSync(junitFile)) {
    junit = parseJunit(fs.readFileSync(junitFile, 'utf8'));
    fs.rmSync(junitFile, { force: true });
  }
  if (r.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (r.error).code;
    return { status: 'infra', failed: [], log: `${c.name}: ${code || r.error.message}\n${log}` };
  }
  const counts = junit ? { [c.name]: { tests: junit.tests, skipped: junit.skipped } } : undefined;
  if (r.status === 0) return { status: 'ok', failed: [], log, counts };
  const failed = junit && junit.failed.length ? junit.failed.map((id) => `${c.name}::${id}`) : [`${c.name}::<command>`];
  return { status: 'fail', failed, log, counts };
}

/**
 * @param {any} cfg discovery config
 * @param {'build'|'test'} kind
 * @returns {CheckCommand[]} configured commands ([] when NONE)
 */
function cmdList(cfg, kind) {
  const v = cfg && cfg.commands && cfg.commands[kind];
  return !v || v === 'NONE' || !Array.isArray(v) ? [] : v;
}

/**
 * Runs all commands of a kind. Stops at the first infra failure.
 * @param {any} cfg discovery config
 * @param {'build'|'test'} kind
 * @returns {CheckResult & { warnings: string[], counts: Record<string, TestCounts> }}
 */
export function runChecks(cfg, kind) {
  const list = cmdList(cfg, kind);
  if (!list.length) return { status: 'ok', failed: [], log: '', warnings: [`${kind} command is NONE; skipped`], counts: {} };
  /** @type {CheckResult & { warnings: string[], counts: Record<string, TestCounts> }} */
  const out = { status: 'ok', failed: [], log: '', warnings: [], counts: {} };
  for (const c of list) {
    const r = runCommand(c);
    out.log += `--- ${c.name} (${r.status})\n${r.log}\n`;
    Object.assign(out.counts, r.counts || {});
    if (r.status === 'infra') return { ...out, status: 'infra' };
    if (r.status === 'fail') { out.status = 'fail'; out.failed.push(...r.failed); }
  }
  return out;
}

// ---------- reference lock ----------
/**
 * @param {string} dir
 * @returns {string[]} all files under dir, sorted (empty when dir is missing)
 */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}
/** @returns {Record<string, string>} reference-relative path -> SHA-256 */
function hashRef() {
  /** @type {Record<string, string>} */
  const map = {};
  for (const f of listFiles(P.refDir)) map[path.relative(P.refDir, f).split(path.sep).join('/')] = sha256File(f);
  return map;
}

/**
 * Compares `.gauntlet/reference/` against ref-lock.json (detects edited, added and removed files).
 * @returns {void}
 * @throws {CliError} FATAL when missing or tampered
 */
export function verifyRefLock() {
  if (!fs.existsSync(P.refLock)) fail('[GAUNTLET] FATAL reference lock missing');
  const lock = readJson(P.refLock).files;
  const now = hashRef();
  if (JSON.stringify(lock) !== JSON.stringify(now)) fail('[GAUNTLET] FATAL reference tampered');
}

// ---------- validation ----------

/**
 * Validates builder_summary.json against schema v1.
 * @param {any} s parsed summary
 * @param {number} iteration expected iteration
 * @returns {string[]} errors (empty = valid)
 */
export function validateSummary(s, iteration) {
  /** @type {string[]} */
  const e = [];
  if (!s || s.schema_version !== 1) e.push('schema_version must be 1');
  if (s && s.iteration !== iteration) e.push(`iteration must be ${iteration}`);
  if (!s || typeof s.summary !== 'string' || !s.summary.trim()) e.push('summary must be a non-empty string');
  for (const k of ['changed_files', 'tests_added', 'remaining_risks']) if (!s || !Array.isArray(s[k])) e.push(`${k} must be an array`);
  return e;
}
/**
 * Validates critic_report.json: schema v1, iteration, scores keys/ranges per rubric, lists.
 * @param {any} r parsed report
 * @param {number} iteration expected iteration
 * @param {Rubric} rubric
 * @returns {string[]} errors (empty = valid)
 */
function validateReport(r, iteration, rubric) {
  /** @type {string[]} */
  const e = [];
  if (!r || r.schema_version !== 1) e.push('schema_version must be 1');
  if (r && r.iteration !== iteration) e.push(`iteration must be ${iteration}`);
  const crit = Object.keys(rubric.criteria);
  const keys = r && r.scores && typeof r.scores === 'object' ? Object.keys(r.scores) : [];
  if (keys.sort().join(',') !== [...crit].sort().join(',')) e.push(`scores keys must be exactly: ${crit.join(', ')}`);
  for (const k of crit) {
    const v = r && r.scores ? r.scores[k] : undefined;
    if (!Number.isInteger(v) || v < 0 || v > rubric.criteria[k].max) e.push(`scores.${k} must be an integer 0..${rubric.criteria[k].max}`);
  }
  if (!r || !Array.isArray(r.blockers)) e.push('blockers must be an array');
  if (!r || !Array.isArray(r.gaps) || r.gaps.length > 3) e.push('gaps must be an array with at most 3 items');
  if (!r || !Array.isArray(r.evidence) || r.evidence.length === 0) e.push('evidence must be a non-empty array');
  return e;
}
/**
 * @param {Rubric} rb
 * @returns {void}
 * @throws {CliError} when criteria are missing/invalid or max values do not sum to 100
 */
function validateRubric(rb) {
  if (!rb || typeof rb.criteria !== 'object' || !Object.keys(rb.criteria).length) fail('[GAUNTLET] FAIL rubric needs criteria');
  const total = Object.values(rb.criteria).reduce((a, c) => a + (Number.isInteger(c.max) ? c.max : NaN), 0);
  if (total !== 100) fail(`[GAUNTLET] FAIL rubric max values must be integers summing to 100 (got ${total})`);
}

// ---------- commands ----------

/** @param {Scorecard} sc @returns {void} */
function save(sc) { writeJsonAtomic(P.scorecard, sc); }

/**
 * @param {Scorecard | null} sc
 * @returns {asserts sc is Scorecard}
 * @throws {CliError} when there is no loop or it is not running
 */
function requireRunning(sc) {
  if (!sc) fail('[GAUNTLET] FAIL no active loop (run init)');
  if (sc.loop_state !== 'running') fail(`[GAUNTLET] FAIL loop_state is ${sc.loop_state}, expected running`);
}

/**
 * Moves the loop to a terminal status (the circuit breaker then blocks new builders).
 * @param {Scorecard} sc
 * @param {string} status
 * @param {string} [reason]
 * @returns {void}
 */
function terminal(sc, status, reason) {
  sc.status = status; sc.loop_state = 'terminal';
  if (reason) sc.halt_reason = String(reason).slice(0, 500);
}

/**
 * Starts a loop: baseline (before any mutation), branch, locked reference, rubric, scorecard.
 * Any failure after mutation starts is rolled back.
 * @param {string | undefined} component
 * @param {string | undefined} referencePath
 * @param {string | null} rubricArg
 * @returns {string} message
 */
export function cmdInit(component, referencePath, rubricArg) {
  if (!component || !referencePath) fail('usage: init <component> <reference_path> [--rubric <file>]');
  if (!/^[\w.-]+$/.test(component)) fail('[GAUNTLET] FAIL component must match [A-Za-z0-9_.-]+');
  requireGit();
  const sc = loadScorecard();
  if (sc && sc.loop_state !== 'idle') fail(`[GAUNTLET] FAIL a loop is ${sc.loop_state}; run close first`);
  if (!treeClean()) fail('[GAUNTLET] FAIL working tree not clean; commit harness files first');
  const refAbs = path.resolve(ROOT, referencePath);
  if (!fs.existsSync(refAbs)) fail(`[GAUNTLET] FAIL reference not found: ${referencePath}`);
  if (refAbs.toLowerCase().startsWith(G.toLowerCase())) fail('[GAUNTLET] FAIL reference must be outside .gauntlet/');
  const branch = `gauntlet/${component}`;
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).code === 0) fail(`[GAUNTLET] FAIL branch ${branch} already exists`);
  let rubric = DEFAULT_RUBRIC;
  if (rubricArg) { rubric = readJson(path.resolve(ROOT, rubricArg)); }
  validateRubric(rubric);
  const cfg = loadConfig();

  // Baseline BEFORE any mutation, so a refusal leaves the tree untouched.
  const build = runChecks(cfg, 'build');
  if (build.status === 'infra') fail('[GAUNTLET] FAIL baseline build infra error:\n' + build.log.slice(-2000));
  if (build.status === 'fail') fail('[GAUNTLET] FAIL baseline build broken; fix before starting\n' + build.log.slice(-2000));
  const tests = runChecks(cfg, 'test');
  if (tests.status === 'infra') fail('[GAUNTLET] FAIL baseline test infra error:\n' + tests.log.slice(-2000));
  const warnings = [...build.warnings, ...tests.warnings];
  if (tests.failed.length) warnings.push(`baseline has ${tests.failed.length} failing test(s); only new failures will block`);
  for (const id of tests.failed) {
    if (id.endsWith('::<command>')) {
      warnings.push(`baseline test command "${id.slice(0, -'::<command>'.length)}" fails without per-test ids (no junit): the test gate is inert for it and new failures will NOT block`);
    }
  }
  for (const c of cmdList(cfg, 'test')) {
    if (!tests.counts[c.name]) warnings.push(`test command "${c.name}" has no junit report: the number of executed tests is not checked`);
  }
  // The gate pins the tree that passed; commands that rewrite or leave untracked files would make every
  // verdict look like a change after the gate (and would ride along in the iteration commits).
  const dirty = git(['status', '--porcelain']).out.split('\n').filter(Boolean);
  if (dirty.length) {
    fail('[GAUNTLET] FAIL build/test commands change the working tree; add generated files to .gitignore, commit, and run init again:\n'
      + dirty.slice(0, 10).join('\n') + (dirty.length > 10 ? `\n... and ${dirty.length - 10} more` : ''));
  }

  const origBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const baseSha = git(['rev-parse', 'HEAD']).out;
  try {
    fs.rmSync(P.inbox, { recursive: true, force: true });
    fs.rmSync(P.refDir, { recursive: true, force: true });
    git(['switch', '-c', branch]);
    fs.mkdirSync(P.refDir, { recursive: true });
    if (fs.statSync(refAbs).isDirectory()) fs.cpSync(refAbs, P.refDir, { recursive: true });
    else fs.copyFileSync(refAbs, path.join(P.refDir, path.basename(refAbs)));
    writeJsonAtomic(P.refLock, { schema_version: 1, files: hashRef() });
    writeJsonAtomic(P.rubric, rubric);
    // Commit reference + lock + rubric on the gauntlet branch so they never leak as untracked files.
    git(['add', '--', '.gauntlet']);
    git(['commit', '--no-verify', '-m', `gauntlet: init ${component}`]);
    const initSha = git(['rev-parse', 'HEAD']).out;
    fs.mkdirSync(P.inbox, { recursive: true });
    save({
      schema_version: 1, loop_state: 'running', status: 'IN_PROGRESS', component,
      reference_path: '.gauntlet/reference/', branch, base_sha: initSha, parent_sha: baseSha, original_branch: origBranch,
      iteration: 0, max_iterations: 6, pass_threshold: 85, plateau_epsilon: 6, plateau_window: 3,
      gate_max_attempts: 3, gate_attempts_current: 0,
      baseline_failures: tests.failed, baseline_counts: tests.counts, warnings,
      gate_passed_iteration: null, builder_summary_sha256: null, gate_tree: null,
      best: { iteration: null, score: -1, sha: null }, score_history: [], attempts: [],
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    // Undo partial mutation.
    for (const f of [P.scorecard, P.refLock, P.rubric]) fs.rmSync(f, { force: true });
    fs.rmSync(P.refDir, { recursive: true, force: true });
    fs.rmSync(P.inbox, { recursive: true, force: true });
    git(['switch', '--discard-changes', origBranch], { allowFail: true });
    git(['branch', '-D', branch], { allowFail: true });
    fail(`[GAUNTLET] FAIL init aborted and rolled back: ${e instanceof Error ? e.message : String(e)}`);
  }
  return `[GAUNTLET] init ok: branch ${branch} (from ${origBranch} @ ${baseSha.slice(0, 10)})` + (warnings.length ? `\nWARN: ${warnings.join('; ')}` : '');
}

/** @returns {string} iteration number the builder/critic must write (scorecard.iteration + 1) */
export function cmdNextIteration() {
  const sc = loadScorecard(); requireRunning(sc);
  return String(sc.iteration + 1);
}

/** @returns {string} incremented gate attempt counter (atomic write) */
export function cmdGateAttempt() {
  const sc = loadScorecard(); requireRunning(sc);
  sc.gate_attempts_current += 1; save(sc);
  return String(sc.gate_attempts_current);
}

/**
 * Records that the builder passed the gate: wipes any (forged) critic report, pins the summary hash and
 * the hash of the working tree that was checked.
 * @returns {string} message
 */
export function cmdBuilderPassed() {
  const sc = loadScorecard(); requireRunning(sc);
  fs.rmSync(P.report, { force: true });
  if (!fs.existsSync(P.summary)) fail('[GAUNTLET] FAIL builder_summary.json missing');
  sc.gate_passed_iteration = sc.iteration + 1;
  sc.builder_summary_sha256 = sha256File(P.summary);
  sc.gate_tree = worktreeTreeHash();
  sc.gate_attempts_current = 0;
  save(sc);
  return `[GAUNTLET] gate passed for iteration ${sc.gate_passed_iteration}`;
}

/**
 * Marks a running loop terminal (GATE_FAILED / HALTED_INFRA). No-op when nothing is running.
 * @param {string} status
 * @param {string} [reason]
 * @returns {string} message
 */
export function cmdMark(status, reason) {
  const sc = loadScorecard();
  if (!sc || sc.loop_state !== 'running') return '[GAUNTLET] no running loop; nothing marked';
  terminal(sc, status, reason || status); save(sc);
  return `[GAUNTLET] status ${status}`;
}

/**
 * True when the best score did not rise by at least `epsilon` over the last `window` iterations.
 * Compares the best of the last `window` scores with the best before them, so a loop that keeps
 * improving (78, 81, 84) is not stopped just because its recent scores are close together.
 * @param {number[]} history scores in iteration order
 * @param {number} epsilon minimum gain that counts as progress
 * @param {number} [window] iterations to look back
 * @returns {boolean}
 */
export function isPlateau(history, epsilon, window = 3) {
  if (history.length <= window) return false;
  return Math.max(...history.slice(-window)) - Math.max(...history.slice(0, -window)) < epsilon;
}

/**
 * Scores an iteration: requires running loop + passed gate + unchanged summary + unchanged working tree +
 * intact reference + valid report; commits, updates history/best, archives the inbox and evaluates stop
 * conditions (APPROVED, then HALTED_MAX_ITER, then HALTED_PLATEAU). Refusals never change state.
 * @returns {string} message
 */
export function cmdRecordVerdict() {
  requireGit();
  const sc = loadScorecard(); requireRunning(sc);
  const n = sc.iteration + 1;
  if (sc.gate_passed_iteration !== n) fail('[GAUNTLET] FAIL builder gate did not pass for this iteration');
  if (!fs.existsSync(P.summary) || sha256File(P.summary) !== sc.builder_summary_sha256) fail('[GAUNTLET] FAIL builder_summary changed after the gate');
  // The commit below must contain exactly what the gate checked (loops started before this check have no gate_tree).
  if (sc.gate_tree) {
    const now = worktreeTreeHash();
    if (now !== sc.gate_tree) {
      const changed = git(['diff', '--name-only', sc.gate_tree, now], { allowFail: true }).out.split('\n').filter(Boolean);
      fail('[GAUNTLET] FAIL working tree changed after the gate: ' + (changed.slice(0, 10).join(', ') || 'unknown paths')
        + (changed.length > 10 ? ` and ${changed.length - 10} more` : '')
        + '. The gate must check the code that gets committed: dispatch the builder again. Files generated by test runs belong in .gitignore.');
    }
  }
  verifyRefLock();
  if (!fs.existsSync(P.report)) fail('[GAUNTLET] FAIL critic_report.json missing (invalid report)');
  /** @type {any} */
  let summary;
  /** @type {any} */
  let report;
  try { summary = readJson(P.summary); } catch { fail('[GAUNTLET] FAIL builder_summary.json is not valid JSON'); }
  try { report = readJson(P.report); } catch { fail('[GAUNTLET] FAIL critic_report.json is not valid JSON (invalid report)'); }
  /** @type {Rubric} */
  const rubric = readJson(P.rubric);
  const es = validateSummary(summary, n);
  if (es.length) fail('[GAUNTLET] FAIL builder_summary invalid: ' + es.join('; '));
  const er = validateReport(report, n, rubric);
  if (er.length) fail('[GAUNTLET] FAIL critic_report invalid (invalid report): ' + er.join('; '));

  const score = Object.keys(rubric.criteria).reduce((a, k) => a + report.scores[k], 0);
  // Harness files (.claude/) never ride along with an iteration commit; rollback excludes them too.
  git(['add', '-A', '--', ...COMMIT_SPEC]);
  git(['commit', '--allow-empty', '--no-verify', '-m', `gauntlet: iter ${n} score ${score}`]);
  const sha = git(['rev-parse', 'HEAD']).out;

  sc.iteration = n;
  sc.attempts.push({ iteration: n, sha, builder_summary: summary.summary, score, breakdown: report.scores, blockers: report.blockers, gaps: report.gaps });
  sc.score_history.push(score);
  if (score > sc.best.score) sc.best = { iteration: n, score, sha };
  sc.gate_attempts_current = 0;
  sc.gate_tree = null;

  const dest = path.join(P.history, `iter-${n}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of [P.summary, P.report]) fs.copyFileSync(f, path.join(dest, path.basename(f)));
  fs.rmSync(P.inbox, { recursive: true, force: true });
  fs.mkdirSync(P.inbox, { recursive: true });

  if (score >= sc.pass_threshold && report.blockers.length === 0) terminal(sc, 'APPROVED');
  else if (sc.iteration >= sc.max_iterations) terminal(sc, 'HALTED_MAX_ITER');
  else if (isPlateau(sc.score_history, sc.plateau_epsilon, sc.plateau_window || 3)) terminal(sc, 'HALTED_PLATEAU');
  save(sc);
  return `[GAUNTLET] iteration ${n} score ${score} -> ${sc.status}`;
}

/**
 * Non-destructive rollback: restores the best iteration's tree (no-overlay, `.claude` preserved)
 * in a NEW commit. Refuses without a best or with a dirty tree; never uses reset --hard.
 * @returns {string} message
 */
export function cmdRollback() {
  requireGit();
  const sc = loadScorecard();
  if (!sc) fail('[GAUNTLET] FAIL no loop');
  const best = sc.best;
  if (!best || !best.sha) fail('[GAUNTLET] FAIL nothing to roll back (no scored iteration)');
  if (!treeClean()) fail('[GAUNTLET] FAIL working tree not clean');
  const spec = ['--', '.', ':(exclude).claude'];
  if (git(['diff', '--quiet', best.sha, 'HEAD', ...spec], { allowFail: true }).code === 0) return '[GAUNTLET] already at best';
  git(['restore', `--source=${best.sha}`, '--staged', '--worktree', ...spec]);
  git(['commit', '--no-verify', '-m', `gauntlet: rollback to iter ${best.iteration}`]);
  return `[GAUNTLET] rolled back to iter ${best.iteration} (${best.sha.slice(0, 10)}) in a new commit`;
}

/**
 * Archives the scorecard (as idle) into history/ and removes it. Does not merge or switch branch.
 * @returns {string} message
 */
export function cmdClose() {
  const sc = loadScorecard();
  if (!sc) return '[GAUNTLET] nothing to close (idle)';
  const copy = { ...sc, loop_state: 'idle', closed_at: new Date().toISOString() };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeJsonAtomic(path.join(P.history, `scorecard-${stamp}.json`), copy);
  fs.rmSync(P.scorecard, { force: true });
  return `[GAUNTLET] closed. Work is on branch ${sc.branch}; merge it manually if you want to keep it.`;
}

/** @returns {string} human-readable loop summary and next step */
export function cmdStatus() {
  const sc = loadScorecard();
  if (!sc) return 'loop_state: idle (no scorecard)';
  const next = sc.loop_state === 'running'
    ? `next: run builder for iteration ${sc.iteration + 1}`
    : 'next: present report; then rollback-to-best (if applicable) or close';
  return [
    `component: ${sc.component}  branch: ${sc.branch}`,
    `loop_state: ${sc.loop_state}  status: ${sc.status}${sc.halt_reason ? ` (${sc.halt_reason})` : ''}`,
    `iteration: ${sc.iteration}/${sc.max_iterations}  threshold: ${sc.pass_threshold}  gate attempts: ${sc.gate_attempts_current}/${sc.gate_max_attempts}`,
    `scores: [${sc.score_history.join(', ')}]  best: ${sc.best.iteration === null ? 'none' : `iter ${sc.best.iteration} = ${sc.best.score}`}`,
    ...(sc.attempts.length ? [`last blockers: ${JSON.stringify(sc.attempts[sc.attempts.length - 1].blockers)}`, `last gaps: ${JSON.stringify(sc.attempts[sc.attempts.length - 1].gaps)}`] : []),
    ...(sc.warnings && sc.warnings.length ? [`warnings: ${sc.warnings.join('; ')}`] : []),
    next,
  ].join('\n');
}

/**
 * CLI dispatcher.
 * @param {string[]} argv arguments after the script path
 * @returns {string} output message
 * @throws {CliError} on usage errors and refusals
 */
export function main(argv) {
  const [cmd, ...rest] = argv;
  const ri = rest.indexOf('--rubric');
  const rubricArg = ri >= 0 ? rest[ri + 1] : null;
  const pos = ri >= 0 ? rest.filter((_, i) => i !== ri && i !== ri + 1) : rest;
  switch (cmd) {
    case 'init': return cmdInit(pos[0], pos[1], rubricArg);
    case 'next-iteration': return cmdNextIteration();
    case 'record-verdict': return cmdRecordVerdict();
    case 'rollback-to-best': return cmdRollback();
    case 'close': return cmdClose();
    case 'status': return cmdStatus();
    default: fail('usage: gauntlet-cli <init|next-iteration|record-verdict|rollback-to-best|close|status>');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)) + '\n');
  } catch (e) {
    process.stderr.write(String(e instanceof CliError ? e.message : `[GAUNTLET] FAIL internal error: ${e.message}`).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?') + '\n');
    process.exit(1);
  }
}
