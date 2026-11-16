// Tests for status after a passed gate (#9) and defect gaps blocking approval (#8). Run: node --test tests/status-approval.test.mjs
// Integration cases build a throwaway git project in the OS temp dir and drive the real CLI and stop gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReport, defectGaps } from '../scripts/gauntlet-cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'scripts', 'gauntlet-cli.mjs');
const GATE = path.join(HERE, '..', 'hooks', 'builder-stop-gate.mjs');

const FAKE_PYTEST = `
import fs from 'node:fs';
const out = (process.argv.find((a) => a.startsWith('--junitxml=')) || '').slice('--junitxml='.length);
const r = JSON.parse(fs.readFileSync('results.json', 'utf8'));
const body = r.cases.map((c) => '<testcase classname="t" name="' + c.name + '">' + (c.outcome === 'fail' ? '<failure/>' : '') + '</testcase>').join('');
if (out) fs.writeFileSync(out, '<testsuite>' + body + '</testsuite>');
process.exit(r.cases.some((c) => c.outcome === 'fail') ? 1 : 0);
`;

/** @param {string} dir @param {string[]} args */
function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** @param {string} dir @param {string} script @param {string[]} args @param {string} [input] */
function node(dir, script, args, input) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  delete env.HARNESS_OFF;
  const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env, input });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const cli = (/** @type {string} */ dir, /** @type {string[]} */ ...args) => node(dir, CLI, args);
const gate = (/** @type {string} */ dir) => node(dir, GATE, [], JSON.stringify({ agent_type: 'gauntlet:builder' }));

/** @param {string} dir @param {string} rel @param {unknown} data */
function write(dir, rel, data) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
}
const scorecardPath = (/** @type {string} */ dir) => path.join(dir, '.gauntlet', 'scorecard.json');
const scorecard = (/** @type {string} */ dir) => JSON.parse(fs.readFileSync(scorecardPath(dir), 'utf8'));

/** @returns {string} project dir with a committed harness and one junit test command, loop initialised */
function makeLoop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-sa-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  write(dir, '.claude/harness/discovery.json', {
    schema_version: 1, secret_files: [], protected_files: [], hook_payload: { pretooluse_agent_type: true },
    commands: { build: 'NONE', test: [{ name: 'unit', cmd: [process.execPath, 'fakepytest.mjs'], junit: 'pytest' }] },
  });
  write(dir, '.claude/harness/allowed-suppressions.json', []);
  write(dir, '.gitignore', '.gauntlet/inbox/\n.gauntlet/history/\n.gauntlet/scorecard.json\n.gauntlet/*.tmp\n');
  write(dir, 'fakepytest.mjs', FAKE_PYTEST);
  write(dir, 'results.json', { cases: [{ name: 'case0', outcome: 'pass' }] });
  write(dir, 'src/app.js', 'export const a = 1;\n');
  write(dir, 'ref.md', '# reference\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  assert.equal(cli(dir, 'init', 'comp', 'ref.md').code, 0);
  return dir;
}

/** @param {string} dir @param {number} n */
function builderWork(dir, n) {
  write(dir, 'src/app.js', `export const a = ${n + 1};\n`);
  write(dir, '.gauntlet/inbox/builder_summary.json', { schema_version: 1, iteration: n, summary: 'work', changed_files: [], tests_added: [], remaining_risks: [] });
}
const PROVEN = [{ id: 'ACC-1', status: 'met', method: 'test', test_id: 'case0', evidence: 'unit case0 passed' }];
const HIGH = { functionality: 40, fidelity: 40, quality: 20 };

/** @param {string} dir @param {number} n @param {unknown[]} gaps */
function criticReport(dir, n, gaps) {
  write(dir, '.gauntlet/inbox/critic_report.json', {
    schema_version: 1, iteration: n, scores: HIGH, requirements: PROVEN, blockers: [], gaps, evidence: ['x'],
  });
}

/** Builder work + gate + critic report + record-verdict. */
function iterate(/** @type {string} */ dir, /** @type {number} */ n, /** @type {unknown[]} */ gaps) {
  builderWork(dir, n);
  const g = gate(dir);
  assert.equal(g.code, 0, g.out);
  criticReport(dir, n, gaps);
  return cli(dir, 'record-verdict');
}

test('status: before the gate it is unchanged', () => {
  const dir = makeLoop();
  try {
    const out = cli(dir, 'status').out;
    assert.match(out, /gate attempts: 0\/3/);
    assert.match(out, /next: run builder for iteration 1/);
    assert.doesNotMatch(out, /gate: passed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('status: after the gate passed it says so and points at the critic', () => {
  const dir = makeLoop();
  try {
    builderWork(dir, 1);
    const g = gate(dir);
    assert.equal(g.code, 0, g.out);
    assert.equal(scorecard(dir).gate_passed_attempts, 1);
    const out = cli(dir, 'status').out;
    assert.match(out, /gate: passed for iteration 1 \(attempts used: 1\/3\)/);
    assert.match(out, /next: dispatch gauntlet:critic for iteration 1, then record-verdict/);
    assert.doesNotMatch(out, /next: run builder/);
    // After the verdict the passed marker is gone and the builder is next again.
    criticReport(dir, 1, []);
    assert.equal(cli(dir, 'record-verdict').code, 0);
    assert.equal(scorecard(dir).gate_passed_attempts, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('record-verdict: a defect gap blocks approval while iterations remain', () => {
  const dir = makeLoop();
  try {
    const r = iterate(dir, 1, [{ text: 'crashes on empty input', kind: 'defect' }, { text: 'rename helper', kind: 'improvement' }]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /IN_PROGRESS/);
    const sc = scorecard(dir);
    assert.equal(sc.loop_state, 'running');
    assert.equal(sc.iteration, 1);
    assert.ok(sc.attempts[0].blockers.includes('defect: crashes on empty input'), 'defect handed to the next builder as a blocker');
    assert.ok(!sc.attempts[0].blockers.some((/** @type {string} */ b) => b.includes('rename helper')), 'improvement is not a blocker');
    assert.match(cli(dir, 'status').out, /next: run builder for iteration 2/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('record-verdict: improvement gaps (typed, untyped or plain strings) still approve', () => {
  const dir = makeLoop();
  try {
    const r = iterate(dir, 1, [{ text: 'polish', kind: 'improvement' }, { text: 'no kind' }, 'plain string']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /APPROVED/);
    assert.equal(scorecard(dir).status, 'APPROVED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('record-verdict: defect gaps on the last iteration approve with an open-defects note', () => {
  const dir = makeLoop();
  try {
    const sc0 = scorecard(dir);
    sc0.max_iterations = 2;
    fs.writeFileSync(scorecardPath(dir), JSON.stringify(sc0, null, 2) + '\n');
    assert.match(iterate(dir, 1, [{ text: 'wrong total', kind: 'defect' }]).out, /IN_PROGRESS/);
    const r = iterate(dir, 2, [{ text: 'wrong total', kind: 'defect' }]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /APPROVED.*approved with 1 open defects: wrong total/);
    const sc = scorecard(dir);
    assert.equal(sc.status, 'APPROVED');
    assert.match(sc.halt_reason, /approved with 1 open defects/);
    assert.deepEqual(sc.attempts[1].open_defects, ['wrong total']);
    assert.match(cli(dir, 'status').out, /approved with 1 open defects/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('record-verdict: an unknown gap kind is rejected with a clear error', () => {
  const dir = makeLoop();
  try {
    builderWork(dir, 1);
    assert.equal(gate(dir).code, 0);
    criticReport(dir, 1, [{ text: 'x', kind: 'bug' }]);
    const r = cli(dir, 'record-verdict');
    assert.notEqual(r.code, 0);
    assert.match(r.out, /gaps\[0\]\.kind must be one of: defect, improvement \(got "bug"\)/);
    assert.equal(scorecard(dir).iteration, 0, 'nothing recorded');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validateReport/defectGaps: kind handling in isolation', () => {
  const rubric = { criteria: { a: { max: 100 } } };
  const base = { schema_version: 1, iteration: 1, scores: { a: 90 }, blockers: [], evidence: ['x'], requirements: PROVEN };
  const errs = (/** @type {unknown[]} */ gaps) => validateReport({ ...base, gaps }, 1, /** @type {any} */ (rubric), ['ACC-1']);
  assert.deepEqual(errs([{ text: 'a', kind: 'defect' }, { text: 'b', kind: 'improvement' }, 'd']), []);
  assert.match(errs([{ text: 'a', kind: 'Defect' }]).join(), /kind must be one of/);
  assert.deepEqual(defectGaps([{ text: 'a', kind: 'defect' }, { text: 'b' }, 'c']), ['a']);
});
