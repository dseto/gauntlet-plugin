#!/usr/bin/env node
// @ts-check
/**
 * Deterministic state machine for the Gauntlet Loop. Agents never edit state; only this CLI writes
 * outside .gauntlet/inbox/. All child processes run without a shell (argument arrays) so pathspecs
 * and quotes survive on Windows. Every JSON write is atomic (temp file + rename).
 *
 * Subcommands: init, next-iteration, gate-attempt, builder-passed, mark-gate-failed,
 * mark-infra-failed, record-verdict, rollback-to-best, close, status.
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
 * @property {number | null} gate_passed_iteration
 * @property {string | null} builder_summary_sha256
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
/** @typedef {{ status: 'ok'|'fail'|'infra', failed: string[], log: string, warnings?: string[] }} CheckResult */
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
 * @param {{ allowFail?: boolean }} [opts] allowFail returns the exit code instead of throwing
 * @returns {{ code: number | null, out: string }}
 * @throws {CliError} on non-zero exit unless allowFail
 */
export function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: ROOT, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
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

// ---------- checks (build/test), shared with the stop gate ----------

/** @param {CheckCommand} c @returns {number} child timeout in ms: max(60s, 2x measured) */
function childTimeout(c) { return Math.max(60, Math.round((c.seconds || 0) * 2)) * 1000; }

/**
 * Extracts failing test ids (`classname::name`) from a JUnit XML report.
 * @param {string} xml
 * @returns {string[]}
 */
function parseJunit(xml) {
  /** @type {string[]} */
  const failed = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const body = m[3] || '';
    if (/<(failure|error)\b/.test(body)) {
      /** @param {string} n @returns {string} */
      const attr = (n) => ((new RegExp(`\\b${n}="([^"]*)"`).exec(attrs) || [])[1] || '');
      failed.push(`${attr('classname')}::${attr('name')}`);
    }
  }
  return failed;
}

/**
 * Runs one build/test command without a shell, classifying the outcome.
 * Timeouts and spawn errors are 'infra' (not the builder's fault).
 * @param {CheckCommand} c
 * @returns {CheckResult}
 */
export function runCommand(c) {
  if (!c || !Array.isArray(c.cmd) || c.cmd.length === 0) return { status: 'infra', failed: [], log: 'invalid command config' };
  const args = [...c.cmd.slice(1)];
  /** @type {string | null} */
  let junitFile = null;
  if (c.junit === 'pytest') {
    junitFile = path.join(os.tmpdir(), `gauntlet-junit-${process.pid}-${Date.now()}.xml`);
    args.push(`--junitxml=${junitFile}`);
  }
  const cwd = path.join(ROOT, c.cwd || '.');
  const exe = /[\\/]/.test(c.cmd[0]) ? path.resolve(cwd, c.cmd[0]) : c.cmd[0];
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', shell: false, timeout: childTimeout(c), maxBuffer: 64 * 1024 * 1024 });
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (r.error).code;
    return { status: 'infra', failed: [], log: `${c.name}: ${code || r.error.message}\n${log}` };
  }
  if (r.status === 0) { if (junitFile) fs.rmSync(junitFile, { force: true }); return { status: 'ok', failed: [], log }; }
  let failed = [`${c.name}::<command>`];
  if (junitFile && fs.existsSync(junitFile)) {
    const ids = parseJunit(fs.readFileSync(junitFile, 'utf8'));
    if (ids.length) failed = ids.map((id) => `${c.name}::${id}`);
    fs.rmSync(junitFile, { force: true });
  }
  return { status: 'fail', failed, log };
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
 * @returns {CheckResult & { warnings: string[] }}
 */
export function runChecks(cfg, kind) {
  const list = cmdList(cfg, kind);
  if (!list.length) return { status: 'ok', failed: [], log: '', warnings: [`${kind} command is NONE; skipped`] };
  /** @type {CheckResult & { warnings: string[] }} */
  const out = { status: 'ok', failed: [], log: '', warnings: [] };
  for (const c of list) {
    const r = runCommand(c);
    out.log += `--- ${c.name} (${r.status})\n${r.log}\n`;
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
      iteration: 0, max_iterations: 6, pass_threshold: 85, plateau_epsilon: 6,
      gate_max_attempts: 3, gate_attempts_current: 0,
      baseline_failures: tests.failed, warnings,
      gate_passed_iteration: null, builder_summary_sha256: null,
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
 * Records that the builder passed the gate: wipes any (forged) critic report, pins the summary hash.
 * @returns {string} message
 */
export function cmdBuilderPassed() {
  const sc = loadScorecard(); requireRunning(sc);
  fs.rmSync(P.report, { force: true });
  if (!fs.existsSync(P.summary)) fail('[GAUNTLET] FAIL builder_summary.json missing');
  sc.gate_passed_iteration = sc.iteration + 1;
  sc.builder_summary_sha256 = sha256File(P.summary);
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
 * Scores an iteration: requires running loop + passed gate + unchanged summary + intact reference +
 * valid report; commits, updates history/best, archives the inbox and evaluates stop conditions
 * (APPROVED, then HALTED_MAX_ITER, then HALTED_PLATEAU). Refusals never change state.
 * @returns {string} message
 */
export function cmdRecordVerdict() {
  requireGit();
  const sc = loadScorecard(); requireRunning(sc);
  const n = sc.iteration + 1;
  if (sc.gate_passed_iteration !== n) fail('[GAUNTLET] FAIL builder gate did not pass for this iteration');
  if (!fs.existsSync(P.summary) || sha256File(P.summary) !== sc.builder_summary_sha256) fail('[GAUNTLET] FAIL builder_summary changed after the gate');
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
  git(['add', '-A', '--', '.', ':(exclude).claude']);
  git(['commit', '--allow-empty', '--no-verify', '-m', `gauntlet: iter ${n} score ${score}`]);
  const sha = git(['rev-parse', 'HEAD']).out;

  sc.iteration = n;
  sc.attempts.push({ iteration: n, sha, builder_summary: summary.summary, score, breakdown: report.scores, blockers: report.blockers, gaps: report.gaps });
  sc.score_history.push(score);
  if (score > sc.best.score) sc.best = { iteration: n, score, sha };
  sc.gate_attempts_current = 0;

  const dest = path.join(P.history, `iter-${n}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of [P.summary, P.report]) fs.copyFileSync(f, path.join(dest, path.basename(f)));
  fs.rmSync(P.inbox, { recursive: true, force: true });
  fs.mkdirSync(P.inbox, { recursive: true });

  const last3 = sc.score_history.slice(-3);
  if (score >= sc.pass_threshold && report.blockers.length === 0) terminal(sc, 'APPROVED');
  else if (sc.iteration >= sc.max_iterations) terminal(sc, 'HALTED_MAX_ITER');
  else if (sc.iteration >= 3 && Math.max(...last3) - Math.min(...last3) <= sc.plateau_epsilon) terminal(sc, 'HALTED_PLATEAU');
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
    case 'gate-attempt': return cmdGateAttempt();
    case 'builder-passed': return cmdBuilderPassed();
    case 'mark-gate-failed': return cmdMark('GATE_FAILED', pos.join(' '));
    case 'mark-infra-failed': return cmdMark('HALTED_INFRA', pos.join(' '));
    case 'record-verdict': return cmdRecordVerdict();
    case 'rollback-to-best': return cmdRollback();
    case 'close': return cmdClose();
    case 'status': return cmdStatus();
    default: fail('usage: gauntlet-cli <init|next-iteration|gate-attempt|builder-passed|mark-gate-failed|mark-infra-failed|record-verdict|rollback-to-best|close|status>');
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
