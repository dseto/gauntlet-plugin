#!/usr/bin/env node
// @ts-check
/**
 * Deterministic state machine for the Gauntlet Loop. Agents never edit state; only this CLI writes
 * outside .gauntlet/inbox/. All child processes run without a shell (argument arrays) so pathspecs
 * and quotes survive on Windows. Every JSON write is atomic (temp file + rename).
 *
 * Subcommands: init, lock-acceptance, skip-acceptance, next-iteration, record-verdict, rollback-to-best,
 * close, status.
 * The gate transitions (cmdGateAttempt, cmdBuilderPassed, cmdMark) are exported for the stop gate hook
 * only and are deliberately not reachable from the command line.
 *
 * Proof of a requirement, strongest first:
 *   1. a locked acceptance test (written from the reference before any implementation, red at lock,
 *      hash-locked) that passed in the junit report of the gate run;
 *   2. a test the critic names in `test_id` that passed in that same junit report;
 *   3. the critic's own `run` / `browser` observation.
 * Reading the code (`static`) never proves anything.
 */
/**
 * @typedef {object} Attempt
 * @property {number} iteration
 * @property {string} sha commit recorded for this iteration
 * @property {string} builder_summary text of the builder summary
 * @property {number} score
 * @property {Record<string, number>} breakdown
 * @property {string[]} blockers critic blockers plus one per requirement that is not proven
 * @property {string[]} gaps
 * @property {Requirement[]} [requirements] per-requirement verdict of the critic
 * @property {string[]} [unproven] ids of requirements that are not met with executed evidence
 */
/**
 * @typedef {object} Requirement
 * @property {string} id requirement id from the reference (e.g. R3) or one the critic assigned
 * @property {'met'|'unmet'|'unverified'} status
 * @property {'test'|'run'|'browser'|'static'} method how it was checked; `static` (reading code) is not proof
 * @property {string} evidence test name, command + observed output, or browser observation
 * @property {string} [test_id] junit test the critic relies on for method `test` (name or classname::name)
 * @property {'acceptance'|'gate'|'critic'} [source] who decided the proof (recorded by record-verdict)
 * @property {boolean} [proven] recorded by record-verdict
 */
/**
 * @typedef {object} Acceptance
 * @property {'pending'|'locked'|'skipped'|'unavailable'} state pending: spec-tester must write the tests first
 * @property {Record<string, string[]>} [tests] requirement id -> junit case ids locked for it
 * @property {Record<string, string>} [not_testable] requirement id -> why no automated test can check it
 * @property {string[]} [preexisting] ids whose acceptance test already passed at lock (behavior existed before)
 * @property {Record<string, string>} [files] acceptance test file -> SHA-256 at lock
 * @property {string} [sha] commit holding the locked tests
 * @property {string} [reason] why the phase was skipped or is unavailable
 */
/**
 * @typedef {object} AcceptanceManifest written by the spec-tester in .gauntlet/inbox/acceptance_manifest.json
 * @property {1} schema_version
 * @property {{ id: string, files: string[], names: string[], preexisting?: boolean }[]} tests
 * @property {{ id: string, reason: string }[]} [not_testable]
 */
/** @typedef {'pass'|'fail'|'skip'} Outcome outcome of one junit test case */
/**
 * @typedef {object} Scorecard
 * @property {1} schema_version
 * @property {'idle'|'running'|'terminal'} loop_state
 * @property {string} status IN_PROGRESS | APPROVED | HALTED_MAX_ITER | HALTED_PLATEAU | GATE_FAILED | HALTED_INFRA | HALTED_SPEC_CONFLICT
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
 * @property {string[]} [requirement_ids] numbered requirements found in the reference at init; every report must cover them
 * @property {Acceptance} [acceptance] acceptance-test phase (absent in loops started before it existed)
 * @property {Record<string, Outcome> | null} [gate_results] junit outcomes of the gate run, by `command::classname::name`
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
/**
 * @typedef {{ status: 'ok'|'fail'|'infra', failed: string[], log: string, warnings?: string[], counts?: Record<string, TestCounts>,
 *   results?: Record<string, Outcome> }} CheckResult results: every junit case by `command::classname::name`
 */
/** @typedef {{ schema_version: number, criteria: Record<string, { max: number, desc?: string }> }} Rubric */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { antiCheat, isTestFile } from '../hooks/anti-cheat-diff.mjs';

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
  conflict: path.join(G, 'inbox', 'spec_conflict.json'),
  report: path.join(G, 'inbox', 'critic_report.json'),
  manifest: path.join(G, 'inbox', 'acceptance_manifest.json'),
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
 * Reads a JUnit XML report: failing test ids (`classname::name`), the outcome of every case, collected
 * test cases and skipped ones (pytest reports xfail as skipped).
 * @param {string} xml
 * @returns {{ failed: string[], cases: Record<string, Outcome> } & TestCounts}
 */
export function parseJunit(xml) {
  /** @type {string[]} */
  const failed = [];
  /** @type {Record<string, Outcome>} */
  const cases = {};
  let tests = 0;
  let skipped = 0;
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const body = m[3] || '';
    /** @param {string} n @returns {string} */
    const attr = (n) => unescapeXml((new RegExp(`\\b${n}="([^"]*)"`).exec(attrs) || [])[1] || '');
    const id = `${attr('classname')}::${attr('name')}`;
    tests += 1;
    /** @type {Outcome} */
    let outcome = 'pass';
    if (/<skipped\b/.test(body)) { skipped += 1; outcome = 'skip'; }
    if (/<(failure|error)\b/.test(body)) { failed.push(id); outcome = 'fail'; }
    // A name reported twice keeps its worst outcome (fail > skip > pass).
    const prev = cases[id];
    if (!prev || prev === 'pass' || (prev === 'skip' && outcome === 'fail')) cases[id] = outcome;
  }
  return { failed, cases, tests, skipped };
}

/** @param {string} s XML attribute value @returns {string} with the five predefined entities decoded */
function unescapeXml(s) {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[/** @type {'lt'} */ (e)]);
}

/**
 * Finds the junit cases a test reference names. A reference is a full id (`command::classname::name`),
 * a `classname::name` suffix, or a bare test name; a bare name also matches its parametrized cases
 * (`test_x[a]`).
 * @param {Record<string, Outcome> | null | undefined} results gate or lock results
 * @param {unknown} ref test name or id
 * @returns {string[]} matching full ids (empty when none ran)
 */
export function matchTests(results, ref) {
  if (!results || typeof ref !== 'string' || !ref.trim()) return [];
  const r = ref.trim();
  return Object.keys(results).filter((id) => id === r || id.endsWith(`::${r}`) || (id.includes(`::${r}[`) && id.endsWith(']')));
}

/**
 * Combined outcome of a set of cases: missing when any did not run, then fail, then skip, else pass.
 * @param {Record<string, Outcome> | null | undefined} results
 * @param {string[]} ids full ids
 * @returns {Outcome | 'missing'}
 */
export function combinedOutcome(results, ids) {
  if (!results || !ids.length || ids.some((id) => !(id in results))) return 'missing';
  const o = ids.map((id) => results[id]);
  if (o.includes('fail')) return 'fail';
  if (o.includes('skip')) return 'skip';
  return 'pass';
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
  /** @type {Record<string, Outcome> | undefined} */
  let results;
  if (junit) {
    results = {};
    for (const [id, o] of Object.entries(junit.cases)) results[`${c.name}::${id}`] = o;
  }
  if (r.status === 0) return { status: 'ok', failed: [], log, counts, results };
  const failed = junit && junit.failed.length ? junit.failed.map((id) => `${c.name}::${id}`) : [`${c.name}::<command>`];
  return { status: 'fail', failed, log, counts, results };
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
 * @returns {CheckResult & { warnings: string[], counts: Record<string, TestCounts>, results: Record<string, Outcome> }}
 */
export function runChecks(cfg, kind) {
  const list = cmdList(cfg, kind);
  if (!list.length) return { status: 'ok', failed: [], log: '', warnings: [`${kind} command is NONE; skipped`], counts: {}, results: {} };
  /** @type {CheckResult & { warnings: string[], counts: Record<string, TestCounts>, results: Record<string, Outcome> }} */
  const out = { status: 'ok', failed: [], log: '', warnings: [], counts: {}, results: {} };
  for (const c of list) {
    const r = runCommand(c);
    out.log += `--- ${c.name} (${r.status})\n${r.log}\n`;
    Object.assign(out.counts, r.counts || {});
    Object.assign(out.results, r.results || {});
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

// ---------- requirements and evidence ----------

const REQ_STATUS = ['met', 'unmet', 'unverified'];
const REQ_METHOD = ['test', 'run', 'browser', 'static'];
/** Methods that count as proof: something was executed and observed. Reading the code is not proof. */
const PROOF_METHODS = ['test', 'run', 'browser'];
const TEXT_REF = /\.(md|markdown|txt|rst|adoc)$/i;
// A numbered requirement at the start of a line, after optional heading/bullet/bold markers:
// "- R1. ...", "### AC-3: ...", "**REQ12)** ...", "1. FR-2 ...". The id must contain a digit.
const REQ_LINE = /^\s*(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\[?([A-Z]{1,5}-?\d+(?:\.\d+)*)\]?(?:\*\*|__)?[.:)-]?(?:\*\*|__)?\s/;

/**
 * Lists the numbered requirement ids (R1, AC-2, FR-3.1 ...) declared in the text files of a reference.
 * @param {string} text reference text
 * @returns {string[]} unique ids in order of appearance
 */
export function extractRequirementIds(text) {
  /** @type {string[]} */
  const ids = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = REQ_LINE.exec(line);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** @returns {string[]} requirement ids of all text files in the locked reference */
function referenceRequirementIds() {
  /** @type {string[]} */
  const ids = [];
  for (const f of listFiles(P.refDir)) {
    if (!TEXT_REF.test(f)) continue;
    for (const id of extractRequirementIds(fs.readFileSync(f, 'utf8'))) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Requirements the critic did not prove: anything not `met`, or `met` only by reading the code.
 * @param {Requirement[]} reqs
 * @returns {Requirement[]}
 */
export function unprovenRequirements(reqs) {
  return reqs.filter((r) => r.status !== 'met' || !PROOF_METHODS.includes(r.method));
}

/**
 * Validates the `requirements` list of a critic report.
 * @param {any} reqs
 * @param {string[]} requiredIds ids that must be present (from the reference and earlier iterations)
 * @returns {string[]} errors (empty = valid)
 */
export function validateRequirements(reqs, requiredIds) {
  /** @type {string[]} */
  const e = [];
  if (!Array.isArray(reqs) || reqs.length === 0) return ['requirements must be a non-empty array (one entry per requirement of the reference)'];
  /** @type {Set<string>} */
  const seen = new Set();
  reqs.forEach((r, i) => {
    const where = `requirements[${i}]`;
    if (!r || typeof r.id !== 'string' || !r.id.trim()) { e.push(`${where}.id must be a non-empty string`); return; }
    if (seen.has(r.id)) e.push(`${where}.id duplicated: ${r.id}`);
    seen.add(r.id);
    if (!REQ_STATUS.includes(r.status)) e.push(`${where}.status must be one of ${REQ_STATUS.join('|')}`);
    if (!REQ_METHOD.includes(r.method)) e.push(`${where}.method must be one of ${REQ_METHOD.join('|')}`);
    if (typeof r.evidence !== 'string' || r.evidence.trim().length < 10) e.push(`${where}.evidence must describe what was run and observed (at least 10 chars)`);
  });
  const missing = requiredIds.filter((id) => !seen.has(id));
  if (missing.length) e.push(`requirements missing ids: ${missing.join(', ')}`);
  return e;
}

/**
 * When the gate produced junit results, a `met` by `test` claim must name the test it relies on, and
 * that test must have run at the gate. Requirements with a locked acceptance test are decided by it.
 * @param {any} reqs critic requirements (already shape-checked)
 * @param {Record<string, Outcome> | null | undefined} gateResults
 * @param {Record<string, string[]>} locked requirement id -> locked acceptance cases
 * @returns {string[]} errors (empty = valid)
 */
export function validateTestIds(reqs, gateResults, locked) {
  if (!gateResults || !Object.keys(gateResults).length || !Array.isArray(reqs)) return [];
  /** @type {string[]} */
  const e = [];
  reqs.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
    if (!r || r.status !== 'met' || r.method !== 'test' || locked[r.id]) return;
    const where = `requirements[${i}] (${r.id})`;
    if (typeof r.test_id !== 'string' || !r.test_id.trim()) {
      e.push(`${where}.test_id is required for method test: name the junit test (e.g. test_r3_rejects_empty) that proves it, or use method run/browser`);
    } else if (!matchTests(gateResults, r.test_id).length) {
      e.push(`${where}.test_id '${r.test_id}' did not run in the junit report of the gate run; name a test that ran, or use method run with the command and its output`);
    }
  });
  return e;
}

/**
 * Decides, per requirement, whether it is proven and by whom. A locked acceptance test that passed at
 * the gate proves its requirement unless the critic observed it `unmet`; a critic `test` claim counts
 * only when its `test_id` passed at the gate (when the gate has junit results); otherwise the critic's
 * `run`/`browser` observation decides.
 * @param {Requirement[]} reqs critic requirements
 * @param {Record<string, Outcome> | null | undefined} gateResults
 * @param {Record<string, string[]>} locked requirement id -> locked acceptance cases
 * @returns {Requirement[]} normalized requirements with `source` and `proven`
 */
export function resolveProof(reqs, gateResults, locked) {
  const junit = !!gateResults && Object.keys(gateResults).length > 0;
  return reqs.map((r) => {
    /** @type {Requirement} */
    const base = { id: r.id, status: r.status, method: r.method, evidence: r.evidence };
    if (typeof r.test_id === 'string' && r.test_id.trim()) base.test_id = r.test_id.trim();
    const critic = `critic ${r.status}/${r.method}: ${r.evidence}`;
    if (locked[r.id]) {
      const o = combinedOutcome(gateResults, locked[r.id]);
      const proven = o === 'pass' && r.status !== 'unmet';
      const status = proven ? 'met' : (o === 'pass' ? r.status : 'unmet');
      return { ...base, status, method: 'test', source: 'acceptance', proven,
        evidence: `[gate] locked acceptance test ${o === 'pass' ? 'passed' : o} (${locked[r.id].join(', ')}); ${critic}` };
    }
    if (junit && r.status === 'met' && r.method === 'test') {
      const ids = matchTests(gateResults, base.test_id);
      const o = combinedOutcome(gateResults, ids);
      return { ...base, status: o === 'pass' ? 'met' : 'unmet', source: 'gate', proven: o === 'pass',
        evidence: `[gate] ${base.test_id || '(no test_id)'} ${o === 'pass' ? 'passed' : o}; ${critic}` };
    }
    return { ...base, source: 'critic', proven: r.status === 'met' && PROOF_METHODS.includes(r.method) };
  });
}

/**
 * Validates the spec-tester manifest: every reference id covered exactly once, by tests or by a reason
 * why no automated test can check it; only reference ids.
 * @param {any} m parsed manifest
 * @param {string[]} requiredIds numbered ids of the reference
 * @returns {string[]} errors (empty = valid)
 */
export function validateManifest(m, requiredIds) {
  /** @type {string[]} */
  const e = [];
  if (!m || m.schema_version !== 1) e.push('schema_version must be 1');
  const tests = m && Array.isArray(m.tests) ? m.tests : null;
  const nt = m && m.not_testable === undefined ? [] : (m && Array.isArray(m.not_testable) ? m.not_testable : null);
  if (!tests) e.push('tests must be an array');
  if (!nt) e.push('not_testable must be an array when present');
  if (!tests || !nt) return e;
  if (!tests.length) e.push('tests is empty: nothing to lock (use skip-acceptance if no requirement can be tested automatically)');
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {any} id @param {string} where */
  const takeId = (id, where) => {
    if (typeof id !== 'string' || !id.trim()) { e.push(`${where}.id must be a non-empty string`); return; }
    if (seen.has(id)) e.push(`${where}.id duplicated: ${id}`);
    if (!requiredIds.includes(id)) e.push(`${where}.id ${id} is not a requirement of the reference (${requiredIds.join(', ')})`);
    seen.add(id);
  };
  /** @param {any} v @returns {boolean} */
  const strList = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim().length > 0);
  tests.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
    const where = `tests[${i}]`;
    takeId(t && t.id, where);
    if (!t || !strList(t.files)) e.push(`${where}.files must be a non-empty array of project-relative paths`);
    if (!t || !strList(t.names)) e.push(`${where}.names must be a non-empty array of test names`);
    if (t && t.preexisting !== undefined && typeof t.preexisting !== 'boolean') e.push(`${where}.preexisting must be a boolean`);
  });
  nt.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
    const where = `not_testable[${i}]`;
    takeId(t && t.id, where);
    if (!t || typeof t.reason !== 'string' || t.reason.trim().length < 10) e.push(`${where}.reason must say why no automated test can check it (at least 10 chars)`);
  });
  const missing = requiredIds.filter((id) => !seen.has(id));
  if (missing.length) e.push(`ids not covered (add a test or a not_testable reason): ${missing.join(', ')}`);
  return e;
}

/**
 * Compares the locked acceptance test files with their hashes at lock.
 * @param {Scorecard} sc
 * @returns {void}
 * @throws {CliError} FATAL when a locked file was changed or removed
 */
export function verifyAcceptanceLock(sc) {
  const a = sc.acceptance;
  if (!a || a.state !== 'locked' || !a.files) return;
  const bad = Object.entries(a.files).filter(([f, h]) => {
    const abs = path.join(ROOT, f);
    return !fs.existsSync(abs) || sha256File(abs) !== h;
  }).map(([f]) => f);
  if (bad.length) {
    fail(`[GAUNTLET] FATAL locked acceptance test changed or removed: ${bad.join(', ')}. Restore it exactly; make the code pass the test instead.`);
  }
}

/** @param {Scorecard} sc @returns {Record<string, string[]>} requirement id -> locked cases ({} when not locked) */
function lockedTests(sc) {
  return sc.acceptance && sc.acceptance.state === 'locked' && sc.acceptance.tests ? sc.acceptance.tests : {};
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
 * Validates critic_report.json: schema v1, iteration, scores keys/ranges per rubric, lists, requirements.
 * @param {any} r parsed report
 * @param {number} iteration expected iteration
 * @param {Rubric} rubric
 * @param {string[]} requiredIds requirement ids the report must cover
 * @returns {string[]} errors (empty = valid)
 */
export function validateReport(r, iteration, rubric, requiredIds) {
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
  e.push(...validateRequirements(r ? r.requirements : undefined, requiredIds));
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
  /** @type {string[]} */
  let requirementIds = [];
  /** @type {Acceptance} */
  let acceptance = { state: 'unavailable' };
  try {
    fs.rmSync(P.inbox, { recursive: true, force: true });
    fs.rmSync(P.refDir, { recursive: true, force: true });
    git(['switch', '-c', branch]);
    fs.mkdirSync(P.refDir, { recursive: true });
    if (fs.statSync(refAbs).isDirectory()) fs.cpSync(refAbs, P.refDir, { recursive: true });
    else fs.copyFileSync(refAbs, path.join(P.refDir, path.basename(refAbs)));
    writeJsonAtomic(P.refLock, { schema_version: 1, files: hashRef() });
    writeJsonAtomic(P.rubric, rubric);
    requirementIds = referenceRequirementIds();
    if (!requirementIds.length) warnings.push('no numbered requirements (R1, AC-2, ...) found in the reference: the critic must list them itself, and later reports may not drop any');
    // Acceptance tests are written before any implementation; they need ids to map and a junit report to read.
    const junitCmds = cmdList(cfg, 'test').filter((c) => c.junit && tests.counts[c.name]);
    if (requirementIds.length && junitCmds.length) acceptance = { state: 'pending' };
    else {
      const why = !requirementIds.length ? 'no numbered requirements in the reference' : 'no test command with a junit report';
      acceptance = { state: 'unavailable', reason: why };
      warnings.push(`acceptance tests unavailable (${why}): proof falls back to the critic's own runs`);
    }
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
      requirement_ids: requirementIds, acceptance, gate_results: null,
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
  return `[GAUNTLET] init ok: branch ${branch} (from ${origBranch} @ ${baseSha.slice(0, 10)})`
    + (requirementIds.length ? `\nrequirements to prove: ${requirementIds.join(', ')}` : '')
    + (acceptance.state === 'pending' ? '\nnext: dispatch gauntlet:spec-tester, then run lock-acceptance' : '')
    + (warnings.length ? `\nWARN: ${warnings.join('; ')}` : '');
}

/**
 * @param {Scorecard} sc
 * @returns {void}
 * @throws {CliError} while the acceptance tests are still to be written and locked
 */
function requireAcceptanceSettled(sc) {
  if (sc.acceptance && sc.acceptance.state === 'pending') {
    fail('[GAUNTLET] FAIL acceptance tests not locked yet: dispatch gauntlet:spec-tester, then run lock-acceptance (or skip-acceptance with the user\'s yes)');
  }
}

/**
 * Paths that differ from HEAD in the working tree (tracked changes + untracked, ignored excluded),
 * leaving out the harness and loop state.
 * @returns {{ changed: string[], untracked: string[] }} forward-slash project-relative paths
 */
function pendingPaths() {
  const tracked = git(['diff', '--name-only', 'HEAD']).out.split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean);
  /** @param {string} p */
  const mine = (p) => !p.startsWith('.gauntlet/') && !p.startsWith('.claude/');
  return { changed: [...new Set([...tracked, ...untracked])].filter(mine), untracked: untracked.filter(mine) };
}

/**
 * Locks the acceptance tests the spec-tester wrote from the reference: they must be new test files
 * (nothing else changed), cover every requirement id of the reference (or say why it cannot be tested),
 * pass anti-cheat and the build, leave the other tests as they were, and FAIL now (red) unless marked
 * preexisting. On success they are committed, hash-locked, and their red cases join the baseline
 * failures so the builder's gate does not demand them all at once.
 * @returns {string} message
 */
export function cmdLockAcceptance() {
  requireGit();
  const sc = loadScorecard(); requireRunning(sc);
  if (!sc.acceptance || sc.acceptance.state !== 'pending') fail(`[GAUNTLET] FAIL acceptance is ${sc.acceptance ? sc.acceptance.state : 'not part of this loop'}, expected pending`);
  verifyRefLock();
  if (!fs.existsSync(P.manifest)) fail('[GAUNTLET] FAIL .gauntlet/inbox/acceptance_manifest.json missing (the spec-tester writes it)');
  /** @type {any} */
  let m;
  try { m = readJson(P.manifest); } catch { fail('[GAUNTLET] FAIL acceptance_manifest.json is not valid JSON'); }
  const ids = sc.requirement_ids || [];
  const me = validateManifest(m, ids);
  if (me.length) fail('[GAUNTLET] FAIL acceptance manifest invalid: ' + me.join('; '));
  /** @type {AcceptanceManifest} */
  const manifest = m;
  /** @param {string} f */
  const norm = (f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const files = [...new Set(manifest.tests.flatMap((t) => t.files.map(norm)))];
  const outside = files.filter((f) => normalizedOutside(f));
  if (outside.length) fail(`[GAUNTLET] FAIL acceptance files must be inside the project, outside .gauntlet/ and .claude/: ${outside.join(', ')}`);
  const notTests = files.filter((f) => !isTestFile(f));
  if (notTests.length) fail(`[GAUNTLET] FAIL acceptance files must be test files (tests/ dir, test_*.py, *.test.js, ...): ${notTests.join(', ')}`);

  const cfg = loadConfig();
  const build = runChecks(cfg, 'build');
  if (build.status === 'infra') fail('[GAUNTLET] FAIL build infra error:\n' + build.log.slice(-2000));
  if (build.status === 'fail') fail('[GAUNTLET] FAIL the acceptance tests break the build; they must compile and fail at run time\n' + build.log.slice(-2000));
  const tests = runChecks(cfg, 'test');
  if (tests.status === 'infra') fail('[GAUNTLET] FAIL test infra error:\n' + tests.log.slice(-2000));

  // Scope is checked after the run, so files the new tests leave behind are caught too.
  const { changed, untracked } = pendingPaths();
  const extra = changed.filter((p) => !files.includes(p));
  if (extra.length) fail(`[GAUNTLET] FAIL the spec-tester may only add the acceptance test files listed in the manifest; also changed: ${extra.join(', ')}`);
  const notNew = files.filter((f) => !untracked.includes(f));
  if (notNew.length) fail(`[GAUNTLET] FAIL acceptance files must be new, unignored files (existing tests are not rewritten): ${notNew.join(', ')}`);
  const violations = antiCheat(ROOT, sc.base_sha);
  if (violations.length) fail('[GAUNTLET] FAIL anti-cheat in the acceptance tests:\n' + violations.map((v) => ' - ' + v).join('\n'));

  /** @type {Record<string, string[]>} */
  const locked = {};
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const preexisting = [];
  /** @type {string[]} */
  const red = [];
  for (const t of manifest.tests) {
    /** @type {string[]} */
    const cases = [];
    for (const n of t.names) {
      const found = matchTests(tests.results, n);
      if (!found.length) problems.push(`${t.id}: no test named '${n}' ran (is the file collected? does it fail at import instead of inside the test?)`);
      for (const id of found) if (!cases.includes(id)) cases.push(id);
    }
    for (const id of cases) {
      const o = tests.results[id];
      if (o === 'skip') problems.push(`${t.id}: ${id} was skipped; acceptance tests must run`);
      else if (t.preexisting && o !== 'pass') problems.push(`${t.id}: ${id} is marked preexisting but does not pass`);
      else if (!t.preexisting && o === 'pass') problems.push(`${t.id}: ${id} passes before any implementation, so it does not check the requirement (fix the test, or mark preexisting if the behavior already exists)`);
      else if (o === 'fail') red.push(id);
    }
    locked[t.id] = cases;
    if (t.preexisting) preexisting.push(t.id);
  }
  const baseline = new Set(sc.baseline_failures || []);
  const broken = tests.failed.filter((id) => !baseline.has(id) && !red.includes(id));
  if (broken.length) problems.push(`tests that passed at the baseline now fail: ${broken.join(', ')}`);
  const drops = testCountDrops(sc.baseline_counts, tests.counts);
  if (drops.length) problems.push(`fewer tests executed than at the baseline: ${drops.join('; ')}`);
  if (problems.length) fail('[GAUNTLET] FAIL acceptance tests not locked:\n' + problems.map((p) => ' - ' + p).join('\n'));

  /** @type {Record<string, string>} */
  const hashes = {};
  for (const f of files) hashes[f] = sha256File(path.join(ROOT, f));
  git(['add', '--', ...files]);
  git(['commit', '--no-verify', '-m', `gauntlet: lock acceptance tests (${Object.keys(locked).join(', ')})`]);
  const sha = git(['rev-parse', 'HEAD']).out;
  /** @type {Record<string, string>} */
  const notTestable = {};
  for (const t of manifest.not_testable || []) notTestable[t.id] = t.reason;
  sc.acceptance = { state: 'locked', tests: locked, not_testable: notTestable, preexisting, files: hashes, sha };
  sc.baseline_failures = [...(sc.baseline_failures || []), ...red];
  sc.baseline_counts = tests.counts;
  const dest = path.join(P.history, 'acceptance');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(P.manifest, path.join(dest, path.basename(P.manifest)));
  fs.rmSync(P.manifest, { force: true });
  save(sc);
  return `[GAUNTLET] acceptance locked at ${sha.slice(0, 10)}: ${Object.entries(locked).map(([id, c]) => `${id} (${c.length} test${c.length === 1 ? '' : 's'})`).join(', ')}`
    + (Object.keys(notTestable).length ? `; not testable: ${Object.keys(notTestable).join(', ')}` : '')
    + (preexisting.length ? `; already passing: ${preexisting.join(', ')}` : '');
}

/** @param {string} f forward-slash path from the manifest @returns {boolean} true when outside the project or in harness dirs */
function normalizedOutside(f) {
  const abs = path.resolve(ROOT, f);
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) || rel !== f || rel.startsWith('.gauntlet/') || rel.startsWith('.claude/');
}

/**
 * Skips the acceptance phase (the user's decision, recorded with its reason). Proof falls back to the
 * critic. Refuses with uncommitted changes so a half-written test suite never rides along.
 * @param {string} reason why
 * @returns {string} message
 */
export function cmdSkipAcceptance(reason) {
  requireGit();
  const sc = loadScorecard(); requireRunning(sc);
  if (!sc.acceptance || sc.acceptance.state !== 'pending') fail(`[GAUNTLET] FAIL acceptance is ${sc.acceptance ? sc.acceptance.state : 'not part of this loop'}, expected pending`);
  if (typeof reason !== 'string' || reason.trim().length < 10) fail('usage: skip-acceptance <reason, at least 10 chars>');
  const left = pendingPaths().changed;
  if (left.length) fail(`[GAUNTLET] FAIL working tree has uncommitted changes (remove the unlocked acceptance files first): ${left.join(', ')}`);
  fs.rmSync(P.manifest, { force: true });
  sc.acceptance = { state: 'skipped', reason: reason.trim().slice(0, 500) };
  save(sc);
  return '[GAUNTLET] acceptance phase skipped; proof falls back to the critic';
}

/** @returns {string} iteration number the builder/critic must write (scorecard.iteration + 1) */
export function cmdNextIteration() {
  const sc = loadScorecard(); requireRunning(sc); requireAcceptanceSettled(sc);
  return String(sc.iteration + 1);
}

/** @returns {string} incremented gate attempt counter (atomic write) */
export function cmdGateAttempt() {
  const sc = loadScorecard(); requireRunning(sc);
  sc.gate_attempts_current += 1; save(sc);
  return String(sc.gate_attempts_current);
}

/**
 * Records that the builder passed the gate: wipes any (forged) critic report, pins the summary hash,
 * the hash of the working tree that was checked and the junit outcomes of that run (the proof
 * record-verdict reads for `test` claims and locked acceptance tests).
 * @param {Record<string, Outcome>} [results] junit outcomes of the gate's test run
 * @returns {string} message
 */
export function cmdBuilderPassed(results) {
  const sc = loadScorecard(); requireRunning(sc);
  fs.rmSync(P.report, { force: true });
  if (!fs.existsSync(P.summary)) fail('[GAUNTLET] FAIL builder_summary.json missing');
  sc.gate_passed_iteration = sc.iteration + 1;
  sc.builder_summary_sha256 = sha256File(P.summary);
  sc.gate_tree = worktreeTreeHash();
  sc.gate_results = results && Object.keys(results).length ? results : null;
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
 * Records a spec conflict the builder declared in `.gauntlet/inbox/spec_conflict.json`: locked acceptance
 * tests that cannot all pass (they contradict each other or the reference). The loop halts as
 * HALTED_SPEC_CONFLICT instead of burning iterations on an impossible target; the spec must be fixed by the
 * user (new init, new component). Each conflict names the locked tests or requirement ids it involves and
 * explains why, so the user can check it. A declaration that is not valid is refused and the builder keeps working.
 * @returns {string} message (no-op message when nothing is declared)
 * @throws {CliError} when the declaration is invalid
 */
export function cmdSpecConflict() {
  const sc = loadScorecard();
  if (!sc || sc.loop_state !== 'running') return '[GAUNTLET] no running loop; spec conflict ignored';
  if (!fs.existsSync(P.conflict)) return '[GAUNTLET] no spec conflict declared';
  if (!sc.acceptance || sc.acceptance.state !== 'locked') fail('[GAUNTLET] FAIL spec conflict declared, but no acceptance tests are locked');
  const d = readJson(P.conflict);
  const n = sc.iteration + 1;
  if (!d || typeof d !== 'object' || d.schema_version !== 1 || d.iteration !== n) {
    fail(`[GAUNTLET] FAIL spec_conflict.json must have "schema_version": 1 and "iteration": ${n}`);
  }
  if (!Array.isArray(d.conflicts) || d.conflicts.length === 0) fail('[GAUNTLET] FAIL spec_conflict.json needs at least one conflict');
  const locked = sc.acceptance.tests || {};
  const known = new Set([...Object.keys(locked), ...Object.values(locked).flat()]);
  for (const c of d.conflicts) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.tests) || c.tests.length === 0) {
      fail('[GAUNTLET] FAIL each conflict must list the locked tests or requirement ids it involves ("tests": [...])');
    }
    const unknown = c.tests.filter((t) => typeof t !== 'string' || !known.has(t));
    if (unknown.length) fail(`[GAUNTLET] FAIL conflict names something that is not a locked test or requirement: ${unknown.join(', ')}`);
    if (typeof c.reason !== 'string' || c.reason.trim().length < 40) {
      fail('[GAUNTLET] FAIL each conflict needs a reason of at least 40 characters explaining the contradiction');
    }
  }
  const summary = d.conflicts.map((c) => c.tests.join(' + ')).join('; ');
  terminal(sc, 'HALTED_SPEC_CONFLICT', `spec conflict: ${summary}`); save(sc);
  const lines = d.conflicts.map((c) => ` - ${c.tests.join(' + ')}: ${String(c.reason).replace(/[^\x20-\x7e]/g, '?')}`);
  return ['[GAUNTLET] status HALTED_SPEC_CONFLICT: the locked acceptance tests cannot all pass', ...lines,
    'next: the spec needs a fix by the user; then close and init again with a new component name'].join('\n');
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
  const sc = loadScorecard(); requireRunning(sc); requireAcceptanceSettled(sc);
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
  verifyAcceptanceLock(sc);
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
  // Every id of the reference, plus every id an earlier report listed: a requirement can never silently drop out.
  const requiredIds = [...(sc.requirement_ids || [])];
  for (const a of sc.attempts) for (const r of a.requirements || []) if (!requiredIds.includes(r.id)) requiredIds.push(r.id);
  const locked = lockedTests(sc);
  const er = validateReport(report, n, rubric, requiredIds);
  if (!er.length) er.push(...validateTestIds(report.requirements, sc.gate_results, locked));
  if (er.length) fail('[GAUNTLET] FAIL critic_report invalid (invalid report): ' + er.join('; '));

  const score = Object.keys(rubric.criteria).reduce((a, k) => a + report.scores[k], 0);
  // Proof comes from the gate's junit report where one exists; the critic's word only for run/browser.
  const requirements = resolveProof(report.requirements, sc.gate_results, locked);
  const unproven = requirements.filter((r) => !r.proven);
  // A requirement that is not proven is a blocker, so the next builder attacks it and approval is impossible.
  const blockers = [...report.blockers, ...unproven.map((r) => `${r.id} not proven (${r.status}, ${r.method}): ${r.evidence}`)];
  // Harness files (.claude/) never ride along with an iteration commit; rollback excludes them too.
  git(['add', '-A', '--', ...COMMIT_SPEC]);
  git(['commit', '--allow-empty', '--no-verify', '-m', `gauntlet: iter ${n} score ${score}`]);
  const sha = git(['rev-parse', 'HEAD']).out;

  sc.iteration = n;
  sc.attempts.push({
    iteration: n, sha, builder_summary: summary.summary, score, breakdown: report.scores, blockers, gaps: report.gaps,
    requirements, unproven: unproven.map((r) => r.id),
  });
  sc.score_history.push(score);
  if (score > sc.best.score) sc.best = { iteration: n, score, sha };
  sc.gate_attempts_current = 0;
  sc.gate_tree = null;
  sc.gate_results = null;

  const dest = path.join(P.history, `iter-${n}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of [P.summary, P.report]) fs.copyFileSync(f, path.join(dest, path.basename(f)));
  fs.rmSync(P.inbox, { recursive: true, force: true });
  fs.mkdirSync(P.inbox, { recursive: true });

  const unprovenNote = unproven.length ? `${unproven.length} requirement(s) not proven: ${unproven.map((r) => r.id).join(', ')}` : '';
  if (score >= sc.pass_threshold && blockers.length === 0) terminal(sc, 'APPROVED');
  else if (sc.iteration >= sc.max_iterations) terminal(sc, 'HALTED_MAX_ITER', unprovenNote || undefined);
  else if (isPlateau(sc.score_history, sc.plateau_epsilon, sc.plateau_window || 3)) terminal(sc, 'HALTED_PLATEAU', unprovenNote || undefined);
  save(sc);
  return `[GAUNTLET] iteration ${n} score ${score} -> ${sc.status}` + (unprovenNote ? ` (${unprovenNote})` : ` (all ${requirements.length} requirements proven)`);
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
  const pending = sc.loop_state === 'running' && sc.acceptance && sc.acceptance.state === 'pending';
  const next = pending
    ? 'next: dispatch gauntlet:spec-tester, then run lock-acceptance'
    : sc.loop_state === 'running'
      ? `next: run builder for iteration ${sc.iteration + 1}`
      : 'next: present report with the evidence of every requirement; then rollback-to-best (if applicable) or close';
  const last = sc.attempts.length ? sc.attempts[sc.attempts.length - 1] : null;
  const ids = [...(sc.requirement_ids || [])];
  for (const a of sc.attempts) for (const r of a.requirements || []) if (!ids.includes(r.id)) ids.push(r.id);
  /** @type {string[]} */
  const evidence = [`required ids: ${ids.length ? ids.join(', ') : 'none numbered; the critic lists every requirement'}`];
  evidence.push(acceptanceLine(sc.acceptance));
  if (last && last.requirements) {
    const proven = last.requirements.length - (last.unproven || []).length;
    evidence.push(`requirements (iter ${last.iteration}): ${proven}/${last.requirements.length} proven`);
    for (const r of last.requirements) {
      const mark = (last.unproven || []).includes(r.id) ? 'NOT PROVEN' : 'proven';
      const by = r.source ? ` by ${r.source}` : '';
      evidence.push(`  ${r.id} [${mark}${by}] ${r.status}/${r.method}: ${r.evidence.replace(/\s+/g, ' ').slice(0, 240)}`);
    }
  } else if (last) {
    evidence.push('requirements: none recorded (iteration scored before the evidence rule); nothing is proven');
  }
  return [
    `component: ${sc.component}  branch: ${sc.branch}`,
    `loop_state: ${sc.loop_state}  status: ${sc.status}${sc.halt_reason ? ` (${sc.halt_reason})` : ''}`,
    `iteration: ${sc.iteration}/${sc.max_iterations}  threshold: ${sc.pass_threshold}  gate attempts: ${sc.gate_attempts_current}/${sc.gate_max_attempts}`,
    `scores: [${sc.score_history.join(', ')}]  best: ${sc.best.iteration === null ? 'none' : `iter ${sc.best.iteration} = ${sc.best.score}`}`,
    ...(sc.attempts.length ? [`last blockers: ${JSON.stringify(sc.attempts[sc.attempts.length - 1].blockers)}`, `last gaps: ${JSON.stringify(sc.attempts[sc.attempts.length - 1].gaps)}`] : []),
    ...evidence,
    ...(sc.warnings && sc.warnings.length ? [`warnings: ${sc.warnings.join('; ')}`] : []),
    next,
  ].join('\n');
}

/**
 * One status line about the acceptance phase. The orchestrator passes it to the critic, so it lists
 * which requirements a locked test decides and which the critic must prove itself.
 * @param {Acceptance | undefined} a
 * @returns {string}
 */
function acceptanceLine(a) {
  if (!a) return 'acceptance: not part of this loop';
  if (a.state !== 'locked') return `acceptance: ${a.state}${a.reason ? ` (${a.reason})` : ''}`;
  const tests = Object.entries(a.tests || {}).map(([id, c]) => `${id} -> ${c.join(' + ')}`);
  const nt = Object.keys(a.not_testable || {});
  return `acceptance: locked at ${(a.sha || '').slice(0, 10)}; gate-proven by locked tests: ${tests.join('; ')}`
    + (nt.length ? `; critic must prove (no automated test): ${nt.join(', ')}` : '');
}

/**
 * CLI dispatcher.
 * @param {string[]} argv arguments after the script path
 * @returns {string} output message
 * @throws {CliError} on usage errors and refusals
 */
/** Folder that contains this plugin (the parent of scripts/). @type {string} */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Refuses to run from the plugin's own folder or from a folder without a harness. Without this, an agent
 * started in the wrong directory reads "idle" and writes state where the hooks never look.
 * @returns {void}
 * @throws {CliError} when ROOT is the plugin folder or lacks `.claude/harness/discovery.json`
 */
export function assertProjectRoot() {
  const rel = path.relative(PLUGIN_ROOT, ROOT);
  /** @type {boolean} ROOT equals or sits inside PLUGIN_ROOT */
  const insidePlugin = rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
  if (insidePlugin) fail(`[GAUNTLET] FAIL run from the project root, not the plugin folder (resolved: ${ROOT})`);
  if (!fs.existsSync(P.config)) {
    fail(`[GAUNTLET] FAIL no harness in ${ROOT} (missing .claude/harness/discovery.json); run /gauntlet:init in the project root`);
  }
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  assertProjectRoot();
  const ri = rest.indexOf('--rubric');
  const rubricArg = ri >= 0 ? rest[ri + 1] : null;
  const pos = ri >= 0 ? rest.filter((_, i) => i !== ri && i !== ri + 1) : rest;
  switch (cmd) {
    case 'init': return cmdInit(pos[0], pos[1], rubricArg);
    case 'lock-acceptance': return cmdLockAcceptance();
    case 'skip-acceptance': return cmdSkipAcceptance(pos.join(' '));
    case 'next-iteration': return cmdNextIteration();
    case 'record-verdict': return cmdRecordVerdict();
    case 'rollback-to-best': return cmdRollback();
    case 'spec-conflict': return cmdSpecConflict();
    case 'close': return cmdClose();
    case 'status': return cmdStatus();
    default: fail('usage: gauntlet-cli <init|lock-acceptance|skip-acceptance|next-iteration|record-verdict|rollback-to-best|spec-conflict|close|status>');
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
