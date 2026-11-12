// Regression tests for the gate integrity fixes. Run: node --test tests/
// Integration cases build a throwaway git project in the OS temp dir and drive the real CLI and stop gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPlateau, parseJunit, testCountDrops, spawnPlan } from '../scripts/gauntlet-cli.mjs';
import { antiCheat, isTestFile } from '../hooks/anti-cheat-diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'scripts', 'gauntlet-cli.mjs');
const GATE = path.join(HERE, '..', 'hooks', 'builder-stop-gate.mjs');

// Stand-in for pytest: writes the junit report asked for by --junitxml from results.json.
const FAKE_PYTEST = `
import fs from 'node:fs';
const out = (process.argv.find((a) => a.startsWith('--junitxml=')) || '').slice('--junitxml='.length);
const r = JSON.parse(fs.readFileSync('results.json', 'utf8'));
if (r.junk) fs.writeFileSync('junk.txt', String(Date.now()));
const body = r.cases.map((c) => '<testcase classname="t" name="' + c.name + '">'
  + (c.outcome === 'fail' ? '<failure/>' : c.outcome === 'skip' ? '<skipped/>' : '') + '</testcase>').join('');
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
const gate = (/** @type {string} */ dir, agentType = 'gauntlet:builder') => node(dir, GATE, [], JSON.stringify({ agent_type: agentType }));

/** @param {string} dir @param {string} rel @param {unknown} data */
function write(dir, rel, data) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
}
const scorecard = (/** @type {string} */ dir) => JSON.parse(fs.readFileSync(path.join(dir, '.gauntlet', 'scorecard.json'), 'utf8'));
const cases = (/** @type {string[]} */ ...outcomes) => outcomes.map((outcome, i) => ({ name: `case${i}`, outcome }));

/**
 * @param {{ results?: unknown }} [opts]
 * @returns {string} project dir with a committed harness and one junit test command
 */
function makeProject(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-test-'));
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
  write(dir, 'results.json', opts.results || { cases: cases('pass', 'pass', 'pass') });
  write(dir, 'src/app.js', 'export const a = 1;\n');
  write(dir, 'ref.md', '# reference\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

/** @param {string} dir @param {number} n */
function builderWork(dir, n) {
  write(dir, 'src/app.js', `export const a = ${n + 1};\n`);
  write(dir, '.gauntlet/inbox/builder_summary.json', { schema_version: 1, iteration: n, summary: 'work', changed_files: [], tests_added: [], remaining_risks: [] });
}

/** @param {string} dir @param {number} n */
function criticReport(dir, n) {
  write(dir, '.gauntlet/inbox/critic_report.json', {
    schema_version: 1, iteration: n, scores: { functionality: 30, fidelity: 30, quality: 10 }, blockers: [], gaps: [], evidence: ['x'],
  });
}

test('plateau: an improving loop is not stopped', () => {
  assert.equal(isPlateau([78, 81, 84], 6), false, 'three scores are not enough to judge');
  assert.equal(isPlateau([78, 81, 84, 84], 6), false, 'best rose 6 over the last 3 iterations');
  assert.equal(isPlateau([78, 81, 84, 84, 84], 6), true, 'best rose only 3 over the last 3 iterations');
  assert.equal(isPlateau([80, 80, 80, 80], 6), true);
  assert.equal(isPlateau([70, 72, 73, 74], 6), true);
  assert.equal(isPlateau([80, 70, 72, 74], 6), true, 'best never beaten again');
  assert.equal(isPlateau([60, 70, 80, 90], 6), false);
});

test('junit: counts collected and skipped tests', () => {
  const r = parseJunit('<testsuite><testcase classname="a" name="x"/><testcase classname="a" name="y"><skipped type="pytest.xfail"/></testcase>'
    + '<testcase classname="a" name="z"><failure>boom</failure></testcase></testsuite>');
  assert.deepEqual(r, { failed: ['a::z'], tests: 3, skipped: 1 });
});

test('test count: fewer executed tests than the baseline is reported', () => {
  const base = { unit: { tests: 10, skipped: 1 } };
  assert.deepEqual(testCountDrops(base, { unit: { tests: 12, skipped: 1 } }), []);
  assert.equal(testCountDrops(base, { unit: { tests: 8, skipped: 0 } }).length, 1, 'tests removed from collection');
  assert.equal(testCountDrops(base, { unit: { tests: 10, skipped: 3 } }).length, 1, 'tests skipped or xfail');
  assert.equal(testCountDrops(base, {}).length, 1, 'report missing');
  assert.deepEqual(testCountDrops(undefined, {}), [], 'loops started before the check');
});

test('anti-cheat: test file detection covers conftest and other languages', () => {
  for (const p of ['conftest.py', 'pkg/conftest.py', 'pkg/foo_test.go', 'src/LoginTest.java', 'src/LoginTests.cs', 'tests/x.py', 'a.test.ts']) {
    assert.equal(isTestFile(p), true, p);
  }
  for (const p of ['src/app.py', 'src/Contest.java', 'src/latest.cs', 'main.go']) assert.equal(isTestFile(p), false, p);
});

test('anti-cheat: pytest ways of hiding tests are flagged', () => {
  const dir = makeProject();
  try {
    const base = git(dir, ['rev-parse', 'HEAD']);
    const tricks = {
      'a_mod.py': 'pytestmark = pytest.mark.skip\n',
      'b_mod.py': '@pytest.mark.xfail\ndef test_x(): pass\n',
      'conftest.py': 'collect_ignore = ["test_slow.py"]\n',
      'pkg/conftest.py': 'def pytest_collection_modifyitems(items):\n    items[:] = []\n',
      'pytest.ini': '[pytest]\naddopts = -k "not slow"\n',
      'setup.cfg': '[tool:pytest]\naddopts =\n    --deselect tests/test_a.py::test_b\n',
    };
    for (const [f, text] of Object.entries(tricks)) write(dir, f, text);
    const v = antiCheat(dir, base);
    for (const f of Object.keys(tricks)) assert.ok(v.some((x) => x.includes(`'skip' added in ${f}`)), `${f} not flagged:\n${v.join('\n')}`);
    write(dir, 'clean.py', 'import pytest\n\ndef test_ok():\n    assert 1\n');
    assert.ok(!antiCheat(dir, base).some((x) => x.includes('clean.py')), 'plain test flagged');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gate: hiding tests fails even without a new failure', () => {
  const dir = makeProject();
  try {
    assert.equal(cli(dir, 'init', 'comp', 'ref.md').code, 0);
    assert.deepEqual(scorecard(dir).baseline_counts, { unit: { tests: 3, skipped: 0 } });
    builderWork(dir, 1);
    write(dir, 'results.json', { cases: cases('pass', 'pass', 'skip') });
    const skipped = gate(dir);
    assert.equal(skipped.code, 2, skipped.out);
    assert.match(skipped.out, /fewer tests executed/);
    write(dir, 'results.json', { cases: cases('pass', 'pass') });
    assert.equal(gate(dir).code, 2, 'test removed from collection');
    write(dir, 'results.json', { cases: cases('pass', 'pass', 'pass', 'pass') });
    const ok = gate(dir);
    assert.equal(ok.code, 0, ok.out);
    assert.equal(scorecard(dir).gate_passed_iteration, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gate: repeated stop is a no-op and keeps the critic report', () => {
  const dir = makeProject();
  try {
    assert.equal(cli(dir, 'init', 'comp', 'ref.md').code, 0);
    builderWork(dir, 1);
    assert.equal(gate(dir).code, 0);
    assert.match(scorecard(dir).gate_tree, /^[0-9a-f]{40,64}$/);
    criticReport(dir, 1);
    const again = gate(dir, undefined);
    assert.equal(again.code, 0);
    assert.match(again.out, /already passed/);
    assert.equal(scorecard(dir).gate_attempts_current, 0);
    assert.ok(fs.existsSync(path.join(dir, '.gauntlet', 'inbox', 'critic_report.json')), 'critic report wiped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('record-verdict: refuses a tree that changed after the gate, commits the gated tree', () => {
  const dir = makeProject();
  try {
    assert.equal(cli(dir, 'init', 'comp', 'ref.md').code, 0);
    builderWork(dir, 1);
    assert.equal(gate(dir).code, 0);
    criticReport(dir, 1);
    write(dir, 'src/sneaked.js', 'export const late = true;\n');
    const refused = cli(dir, 'record-verdict');
    assert.equal(refused.code, 1);
    assert.match(refused.out, /working tree changed after the gate: src\/sneaked\.js/);
    assert.equal(scorecard(dir).iteration, 0, 'a refusal must not change state');
    fs.rmSync(path.join(dir, 'src', 'sneaked.js'));
    const gated = scorecard(dir).gate_tree;
    const ok = cli(dir, 'record-verdict');
    assert.equal(ok.code, 0, ok.out);
    assert.equal(git(dir, ['rev-parse', 'HEAD^{tree}']), gated, 'committed tree is the gated tree');
    assert.equal(scorecard(dir).gate_tree, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('init: refuses when the test command leaves files in the working tree', () => {
  const dir = makeProject({ results: { junk: true, cases: cases('pass') } });
  try {
    const r = cli(dir, 'init', 'comp', 'ref.md');
    assert.equal(r.code, 1);
    assert.match(r.out, /change the working tree/);
    assert.match(r.out, /junk\.txt/);
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'gauntlet/comp', false, 'no branch created');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('spawn plan: direct spawn off Windows and for real executables', () => {
  assert.deepEqual(spawnPlan(['npm', 'test'], process.cwd(), 'linux'), { exe: 'npm', args: ['test'], verbatim: false });
  const direct = spawnPlan([process.execPath, '-v'], process.cwd());
  assert.equal(direct.verbatim, false);
  assert.deepEqual(direct.args, ['-v']);
});

test('spawn plan: .cmd commands run through cmd.exe with arguments intact', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cmd-'));
  try {
    write(dir, 'print.mjs', 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    write(dir, 'tool.cmd', '@echo off\r\nnode "%~dp0print.mjs" %*\r\n');
    const args = ['plain', 'two words', 'a&b', 'p|q', '100%', 'x^y', '<tag>'];
    for (const name of ['tool', 'tool.cmd', './tool']) {
      const plan = spawnPlan([name, ...args], dir);
      assert.equal(plan.verbatim, true, name);
      const r = spawnSync(plan.exe, plan.args, { cwd: dir, encoding: 'utf8', shell: false, windowsVerbatimArguments: plan.verbatim });
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), args, name);
    }
    const npm = spawnPlan(['npm', '--version'], dir);
    assert.equal(npm.verbatim, true, 'npm resolves to npm.cmd');
    const v = spawnSync(npm.exe, npm.args, { cwd: dir, encoding: 'utf8', shell: false, windowsVerbatimArguments: true });
    assert.equal(v.status, 0, v.stderr);
    assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
