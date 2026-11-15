// Regression tests for the gate integrity fixes. Run: node --test tests/
// Integration cases build a throwaway git project in the OS temp dir and drive the real CLI and stop gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isPlateau, parseJunit, testCountDrops, spawnPlan, extractRequirementIds, unprovenRequirements, validateRequirements,
  matchTests, combinedOutcome, resolveProof, validateTestIds, validateManifest,
} from '../scripts/gauntlet-cli.mjs';
import { antiCheat, isTestFile } from '../hooks/anti-cheat-diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'scripts', 'gauntlet-cli.mjs');
const GATE = path.join(HERE, '..', 'hooks', 'builder-stop-gate.mjs');

// Stand-in for pytest: writes the junit report asked for by --junitxml from results.json, plus the cases
// of every tests/*.json file (acceptance tests). A case with `requires` passes once that file exists.
const FAKE_PYTEST = `
import fs from 'node:fs';
const out = (process.argv.find((a) => a.startsWith('--junitxml=')) || '').slice('--junitxml='.length);
const r = JSON.parse(fs.readFileSync('results.json', 'utf8'));
if (r.junk) fs.writeFileSync('junk.txt', String(Date.now()));
const all = [...r.cases];
if (fs.existsSync('tests')) for (const f of fs.readdirSync('tests').sort()) if (f.endsWith('.json')) all.push(...JSON.parse(fs.readFileSync('tests/' + f, 'utf8')));
const outcome = (c) => (c.requires ? (fs.existsSync(c.requires) ? 'pass' : 'fail') : c.outcome);
const body = all.map((c) => '<testcase classname="t" name="' + c.name + '">'
  + (outcome(c) === 'fail' ? '<failure/>' : outcome(c) === 'skip' ? '<skipped/>' : '') + '</testcase>').join('');
if (out) fs.writeFileSync(out, '<testsuite>' + body + '</testsuite>');
process.exit(all.some((c) => outcome(c) === 'fail') ? 1 : 0);
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

const PROVEN = [{ id: 'ACC-1', status: 'met', method: 'test', test_id: 'case0', evidence: 'unit case0 passed' }];

/**
 * @param {string} dir @param {number} n
 * @param {{ requirements?: unknown[], scores?: Record<string, number> }} [opts]
 */
function criticReport(dir, n, opts = {}) {
  write(dir, '.gauntlet/inbox/critic_report.json', {
    schema_version: 1, iteration: n, scores: opts.scores || { functionality: 30, fidelity: 30, quality: 10 },
    requirements: opts.requirements || PROVEN, blockers: [], gaps: [], evidence: ['x'],
  });
}

/** Runs one full iteration (builder work, gate, critic) and records the verdict. */
function iterate(/** @type {string} */ dir, /** @type {number} */ n, /** @type {Parameters<typeof criticReport>[2]} */ opts) {
  builderWork(dir, n);
  const g = gate(dir);
  assert.equal(g.code, 0, g.out);
  criticReport(dir, n, opts);
  return cli(dir, 'record-verdict');
}
const HIGH = { functionality: 40, fidelity: 40, quality: 20 };

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
  assert.deepEqual(r, { failed: ['a::z'], cases: { 'a::x': 'pass', 'a::y': 'skip', 'a::z': 'fail' }, tests: 3, skipped: 1 });
  assert.deepEqual(parseJunit('<testcase classname="a" name="q[x&amp;y]"/>').cases, { 'a::q[x&y]': 'pass' }, 'entities decoded');
});

test('junit: tests are found by bare name, suffix or full id, parametrized cases included', () => {
  const results = /** @type {const} */ ({ 'unit::t::test_r1': 'pass', 'unit::t::test_r10': 'fail', 'unit::t::test_r2[a]': 'pass', 'unit::t::test_r2[b]': 'fail' });
  assert.deepEqual(matchTests(results, 'test_r1'), ['unit::t::test_r1'], 'test_r1 must not match test_r10');
  assert.deepEqual(matchTests(results, 't::test_r1'), ['unit::t::test_r1']);
  assert.deepEqual(matchTests(results, 'unit::t::test_r10'), ['unit::t::test_r10']);
  assert.deepEqual(matchTests(results, 'test_r2'), ['unit::t::test_r2[a]', 'unit::t::test_r2[b]']);
  assert.deepEqual(matchTests(results, 'test_r'), []);
  assert.deepEqual(matchTests(results, undefined), []);
  assert.equal(combinedOutcome(results, ['unit::t::test_r1']), 'pass');
  assert.equal(combinedOutcome(results, matchTests(results, 'test_r2')), 'fail', 'one failing parameter fails the set');
  assert.equal(combinedOutcome(results, ['unit::t::gone']), 'missing');
  assert.equal(combinedOutcome(results, []), 'missing');
  assert.equal(combinedOutcome(null, ['unit::t::test_r1']), 'missing');
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

test('spec conflict: an invalid declaration is refused; a valid one halts as HALTED_SPEC_CONFLICT and releases the builder', () => {
  const reason = 'R1 wants an empty input rejected while the R2 example feeds an empty input and expects success; both cannot hold';
  const dir = makeProject();
  try {
    startNumbered(dir);
    specTester(dir);
    assert.equal(cli(dir, 'lock-acceptance').code, 0);
    assert.equal(cli(dir, 'next-iteration').out.trim(), '1');

    write(dir, '.gauntlet/inbox/spec_conflict.json', { schema_version: 1, iteration: 1, conflicts: [{ tests: ['test_made_up'], reason }] });
    const unknown = gate(dir);
    assert.equal(unknown.code, 2, unknown.out);
    assert.match(unknown.out, /spec conflict.*not a locked test or requirement/s);

    write(dir, '.gauntlet/inbox/spec_conflict.json', { schema_version: 1, iteration: 1, conflicts: [{ tests: ['R1'], reason: 'too short' }] });
    const short = gate(dir);
    assert.equal(short.code, 2, short.out);
    assert.match(short.out, /at least 40 characters/);
    assert.equal(scorecard(dir).loop_state, 'running', 'refused declarations leave the loop running');

    write(dir, '.gauntlet/inbox/spec_conflict.json', { schema_version: 1, iteration: 1, conflicts: [{ tests: ['R1'], reason }] });
    const ok = gate(dir);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /status HALTED_SPEC_CONFLICT/);
    const sc = scorecard(dir);
    assert.equal(sc.loop_state, 'terminal');
    assert.equal(sc.status, 'HALTED_SPEC_CONFLICT');
    assert.match(cli(dir, 'status').out, /HALTED_SPEC_CONFLICT/);
    assert.match(ok.out, /a locked test/, 'the halt says the fix may be in a locked test');
    const breaker = node(dir, BREAKER, [], JSON.stringify({ tool_input: { subagent_type: 'gauntlet:builder' } }));
    assert.equal(breaker.code, 2, 'no further builder after the halt');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // A locked test is named by requirement id, bare name, classname::name suffix or full junit id (one project each: a
  // valid declaration ends the loop).
  for (const name of ['R1', 'test_r1_feature', 't::test_r1_feature', 'unit::t::test_r1_feature']) {
    const d = makeProject();
    try {
      startNumbered(d);
      specTester(d);
      assert.equal(cli(d, 'lock-acceptance').code, 0);
      write(d, '.gauntlet/inbox/spec_conflict.json', { schema_version: 1, iteration: 1, conflicts: [{ tests: [name], reason }] });
      const g = gate(d);
      assert.equal(g.code, 0, `${name}: ${g.out}`);
      assert.equal(scorecard(d).status, 'HALTED_SPEC_CONFLICT', name);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }

  // A prefix of a locked name is not that test (test_r1 vs test_r10). Separate project: refusals count as gate attempts.
  const dir2 = makeProject();
  try {
    startNumbered(dir2);
    write(dir2, ACC_FILE, [{ name: 'test_r10', requires: 'src/feature.txt' }]);
    write(dir2, '.gauntlet/inbox/acceptance_manifest.json', { schema_version: 1, tests: [{ id: 'R1', files: [ACC_FILE], names: ['test_r10'] }], not_testable: [NOT_TESTABLE_R2] });
    assert.equal(cli(dir2, 'lock-acceptance').code, 0);
    for (const name of ['test_r1', 'r10']) {
      write(dir2, '.gauntlet/inbox/spec_conflict.json', { schema_version: 1, iteration: 1, conflicts: [{ tests: [name], reason }] });
      const refused = gate(dir2);
      assert.equal(refused.code, 2, `${name}: ${refused.out}`);
      assert.match(refused.out, /not a locked test or requirement/);
      assert.match(refused.out, /requirement id.*test name.*suffix.*full junit id/s, 'the refusal lists the accepted forms');
      assert.equal(scorecard(dir2).status, 'IN_PROGRESS');
    }
  } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
});

test('cwd guard: refuses the plugin folder and a folder without a harness, before any state change', () => {
  const plugin = path.join(HERE, '..');
  const r1 = node(plugin, CLI, ['status']);
  assert.equal(r1.code, 1);
  assert.match(r1.out, /not the plugin folder/);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-bare-'));
  try {
    const r2 = cli(bare, 'status');
    assert.equal(r2.code, 1);
    assert.match(r2.out, /no harness in/);
    assert.equal(fs.existsSync(path.join(bare, '.gauntlet')), false, 'no state created in a folder without harness');
  } finally { fs.rmSync(bare, { recursive: true, force: true }); }
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

test('requirements: numbered ids are read from the reference text, code fences ignored', () => {
  const text = [
    '# Spec', '## Requirements', '- R1. clamps t', '- **R2.** surface', '### AC-3: acceptance', '1. FR-4.1 nested',
    'R5) bare line', '```', '- R9. inside a fence', '```', '- R1. duplicate', 'plain text mentioning R7 is not a requirement',
  ].join('\n');
  assert.deepEqual(extractRequirementIds(text), ['R1', 'R2', 'AC-3', 'FR-4.1', 'R5']);
});

test('requirements: reading the code is not proof', () => {
  const reqs = [
    { id: 'a', status: 'met', method: 'test', evidence: 'x' },
    { id: 'b', status: 'met', method: 'run', evidence: 'x' },
    { id: 'c', status: 'met', method: 'browser', evidence: 'x' },
    { id: 'd', status: 'met', method: 'static', evidence: 'x' },
    { id: 'e', status: 'unverified', method: 'test', evidence: 'x' },
    { id: 'f', status: 'unmet', method: 'browser', evidence: 'x' },
  ];
  // @ts-ignore test data
  assert.deepEqual(unprovenRequirements(reqs).map((r) => r.id), ['d', 'e', 'f']);
  assert.match(validateRequirements([], []).join(), /non-empty/);
  assert.match(validateRequirements([{ id: 'R1', status: 'met', method: 'test', evidence: 'short' }], []).join(), /evidence/);
  assert.match(validateRequirements([{ id: 'R1', status: 'done', method: 'eyes', evidence: 'long enough text' }], []).join(), /status.*method/s);
  assert.match(validateRequirements([{ id: 'R1', status: 'met', method: 'test', evidence: 'long enough text' }], ['R1', 'R2']).join(), /missing ids: R2/);
});

test('record-verdict: a high score with requirements proven only by reading code is not approved', () => {
  const dir = makeProject();
  try {
    assert.equal(cli(dir, 'init', 'comp', 'ref.md').code, 0);
    const staticOnly = [{ id: 'ACC-1', status: 'met', method: 'static', evidence: 'looks right in src/app.js:1' }];
    const first = iterate(dir, 1, { scores: HIGH, requirements: staticOnly });
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /IN_PROGRESS \(1 requirement\(s\) not proven: ACC-1\)/);
    const sc = scorecard(dir);
    assert.equal(sc.loop_state, 'running', 'loop must keep iterating');
    assert.ok(sc.attempts[0].blockers.some((/** @type {string} */ b) => b.startsWith('ACC-1 not proven (met, static)')), 'unproven requirement becomes a blocker');
    assert.deepEqual(sc.attempts[0].unproven, ['ACC-1']);
    const second = iterate(dir, 2, { scores: HIGH });
    assert.match(second.out, /APPROVED \(all 1 requirements proven\)/);
    assert.match(cli(dir, 'status').out, /ACC-1 \[proven by gate\] met\/test: \[gate\] case0 passed; critic met\/test: unit case0 passed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('record-verdict: every numbered requirement of the reference must be reported, and none may drop later', () => {
  const dir = makeProject();
  try {
    write(dir, 'ref.md', '# reference\n- R1. first\n- R2. second\n');
    git(dir, ['commit', '-q', '-am', 'numbered ref']);
    const init = cli(dir, 'init', 'comp', 'ref.md');
    assert.match(init.out, /requirements to prove: R1, R2/);
    assert.deepEqual(scorecard(dir).requirement_ids, ['R1', 'R2']);
    assert.equal(cli(dir, 'skip-acceptance', 'covered', 'by', 'the', 'critic', 'in', 'this', 'test').code, 0);
    const r1 = { id: 'R1', status: 'met', method: 'test', test_id: 'case0', evidence: 'test R1 passed' };
    const r2 = { id: 'R2', status: 'met', method: 'run', evidence: 'node cli.js printed ok' };
    const extra = { id: 'ACC-1', status: 'unmet', method: 'browser', evidence: 'button missing in DOM snapshot' };
    builderWork(dir, 1);
    assert.equal(gate(dir).code, 0);
    criticReport(dir, 1, { requirements: [r1] });
    const refused = cli(dir, 'record-verdict');
    assert.equal(refused.code, 1);
    assert.match(refused.out, /invalid report.*missing ids: R2/);
    assert.equal(scorecard(dir).iteration, 0, 'a refusal must not change state');
    criticReport(dir, 1, { requirements: [r1, r2, extra] });
    assert.equal(cli(dir, 'record-verdict').code, 0);
    builderWork(dir, 2);
    assert.equal(gate(dir).code, 0);
    criticReport(dir, 2, { scores: HIGH, requirements: [r1, r2] });
    assert.match(cli(dir, 'record-verdict').out, /missing ids: ACC-1/, 'a requirement listed earlier cannot be dropped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- acceptance tests (red-first, locked) and junit-backed proof ----------

const FILE_GUARD = path.join(HERE, '..', 'hooks', 'file-guard.mjs');
const BREAKER = path.join(HERE, '..', 'hooks', 'orchestrator-breaker.mjs');
const ACC_FILE = 'tests/acceptance.json';
const ACC_CASES = [{ name: 'test_r1_feature', requires: 'src/feature.txt' }];
const NOT_TESTABLE_R2 = { id: 'R2', reason: 'visual look only, judged in the browser' };

/** @param {string} dir @returns {string} init output; the loop runs with a numbered reference (R1, R2), acceptance pending */
function startNumbered(dir) {
  write(dir, 'ref.md', '# reference\n- R1. feature exists\n- R2. looks right\n');
  git(dir, ['commit', '-q', '-am', 'numbered ref']);
  const init = cli(dir, 'init', 'comp', 'ref.md');
  assert.equal(init.code, 0, init.out);
  return init.out;
}

/** @param {string} dir @param {unknown} [manifest] */
function specTester(dir, manifest) {
  write(dir, ACC_FILE, ACC_CASES);
  write(dir, '.gauntlet/inbox/acceptance_manifest.json', manifest || {
    schema_version: 1, tests: [{ id: 'R1', files: [ACC_FILE], names: ['test_r1_feature'] }], not_testable: [NOT_TESTABLE_R2],
  });
}

test('acceptance manifest: every reference id once, tests or a reason', () => {
  const ok = { schema_version: 1, tests: [{ id: 'R1', files: ['tests/a.py'], names: ['test_r1'] }], not_testable: [NOT_TESTABLE_R2] };
  assert.deepEqual(validateManifest(ok, ['R1', 'R2']), []);
  assert.match(validateManifest({ ...ok, not_testable: [] }, ['R1', 'R2']).join(), /not covered.*R2/);
  assert.match(validateManifest({ ...ok, tests: [...ok.tests, { id: 'R9', files: ['tests/a.py'], names: ['x'] }] }, ['R1', 'R2']).join(), /R9 is not a requirement/);
  assert.match(validateManifest({ ...ok, not_testable: [NOT_TESTABLE_R2, { id: 'R1', reason: 'duplicate entry here' }] }, ['R1', 'R2']).join(), /duplicated: R1/);
  assert.match(validateManifest({ ...ok, not_testable: [{ id: 'R2', reason: 'eh' }] }, ['R1', 'R2']).join(), /reason/);
  assert.match(validateManifest({ ...ok, tests: [{ id: 'R1', files: [], names: [] }] }, ['R1', 'R2']).join(), /files.*names/s);
  assert.match(validateManifest({ schema_version: 1, tests: [], not_testable: [NOT_TESTABLE_R2, { id: 'R1', reason: 'nothing testable at all' }] }, ['R1', 'R2']).join(), /skip-acceptance/);
});

test('proof: a test claim counts only when that test passed at the gate', () => {
  const gateResults = /** @type {const} */ ({ 'unit::t::test_r1': 'pass', 'unit::t::test_r2': 'fail', 'unit::t::test_acc': 'fail' });
  const reqs = [
    { id: 'R1', status: 'met', method: 'test', test_id: 'test_r1', evidence: 'passed locally' },
    { id: 'R2', status: 'met', method: 'test', test_id: 'test_r2', evidence: 'claims it passed' },
    { id: 'R3', status: 'met', method: 'browser', evidence: 'saw the button in the DOM' },
    { id: 'R4', status: 'met', method: 'static', evidence: 'looks right in the code' },
  ];
  // @ts-ignore test data
  const out = resolveProof(reqs, gateResults, {});
  assert.deepEqual(out.map((r) => [r.id, r.proven, r.source]), [['R1', true, 'gate'], ['R2', false, 'gate'], ['R3', true, 'critic'], ['R4', false, 'critic']]);
  assert.match(out[1].evidence, /\[gate\] test_r2 fail/);
  // Without junit results the critic's word stands for `test` (projects with no junit report).
  // @ts-ignore test data
  assert.equal(resolveProof([reqs[1]], null, {})[0].proven, true);
  // Locked acceptance tests decide their requirement; a critic `unmet` still overrides a pass.
  const locked = { R1: ['unit::t::test_r1'], R5: ['unit::t::test_acc'] };
  const lockedReqs = [
    { id: 'R1', status: 'unverified', method: 'static', evidence: 'did not run anything' },
    { id: 'R5', status: 'met', method: 'static', evidence: 'critic believes it works' },
  ];
  // @ts-ignore test data
  assert.deepEqual(resolveProof(lockedReqs, gateResults, locked).map((r) => [r.id, r.proven, r.source, r.status]),
    [['R1', true, 'acceptance', 'met'], ['R5', false, 'acceptance', 'unmet']]);
  // @ts-ignore test data
  assert.equal(resolveProof([{ id: 'R1', status: 'unmet', method: 'browser', evidence: 'wrong colour observed' }], gateResults, locked)[0].proven, false);
  assert.match(validateTestIds([{ id: 'R1', status: 'met', method: 'test', evidence: 'xxxxxxxxxx' }], gateResults, {}).join(), /test_id is required/);
  assert.match(validateTestIds([{ id: 'R1', status: 'met', method: 'test', test_id: 'nope', evidence: 'xxxxxxxxxx' }], gateResults, {}).join(), /did not run/);
  assert.deepEqual(validateTestIds([{ id: 'R1', status: 'met', method: 'test', evidence: 'xxxxxxxxxx' }], gateResults, locked), [], 'locked ids need no test_id');
  assert.deepEqual(validateTestIds([{ id: 'R1', status: 'met', method: 'test', evidence: 'xxxxxxxxxx' }], null, {}), [], 'no junit, no test_id rule');
});

test('record-verdict: a critic test claim is checked against the junit report of the gate', () => {
  const dir = makeProject({ results: { cases: cases('pass', 'pass', 'fail') } });
  try {
    assert.equal(cli(dir, 'init', 'comp', 'ref.md').code, 0);
    builderWork(dir, 1);
    assert.equal(gate(dir).code, 0);
    assert.equal(scorecard(dir).gate_results['unit::t::case0'], 'pass', 'gate stores the junit outcomes');
    criticReport(dir, 1, { scores: HIGH, requirements: [{ id: 'ACC-1', status: 'met', method: 'test', evidence: 'it passed, trust me' }] });
    assert.match(cli(dir, 'record-verdict').out, /test_id is required/);
    criticReport(dir, 1, { scores: HIGH, requirements: [{ id: 'ACC-1', status: 'met', method: 'test', test_id: 'test_made_up', evidence: 'it passed, trust me' }] });
    assert.match(cli(dir, 'record-verdict').out, /did not run in the junit report/);
    criticReport(dir, 1, { scores: HIGH, requirements: [{ id: 'ACC-1', status: 'met', method: 'test', test_id: 'case2', evidence: 'case2 passed for me' }] });
    const r = cli(dir, 'record-verdict');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /IN_PROGRESS \(1 requirement\(s\) not proven: ACC-1\)/, 'a failing test proves nothing, whatever the critic says');
    assert.equal(scorecard(dir).gate_results, null, 'gate results are consumed by the verdict');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acceptance: red-first tests are locked before the builder and prove their requirement at the gate', () => {
  const dir = makeProject();
  try {
    const initOut = startNumbered(dir);
    assert.match(initOut, /spec-tester/);
    assert.equal(scorecard(dir).acceptance.state, 'pending');
    assert.match(cli(dir, 'status').out, /next: dispatch gauntlet:spec-tester/);
    assert.match(cli(dir, 'next-iteration').out, /acceptance tests not locked/);
    const early = node(dir, BREAKER, [], JSON.stringify({ tool_input: { subagent_type: 'gauntlet:builder' } }));
    assert.equal(early.code, 2, 'breaker blocks a builder before the lock');

    specTester(dir);
    const lock = cli(dir, 'lock-acceptance');
    assert.equal(lock.code, 0, lock.out);
    assert.match(lock.out, /acceptance locked .*R1 \(1 test\); not testable: R2/);
    const sc = scorecard(dir);
    assert.equal(sc.acceptance.state, 'locked');
    assert.deepEqual(sc.acceptance.tests, { R1: ['unit::t::test_r1_feature'] });
    assert.ok(sc.baseline_failures.includes('unit::t::test_r1_feature'), 'red acceptance test may fail at the gate');
    assert.deepEqual(sc.baseline_counts, { unit: { tests: 4, skipped: 0 } });
    assert.match(git(dir, ['log', '-1', '--format=%s']), /lock acceptance tests \(R1\)/);
    assert.equal(git(dir, ['status', '--porcelain']), '', 'tests committed, tree clean');
    assert.equal(cli(dir, 'next-iteration').out.trim(), '1');
    assert.match(cli(dir, 'status').out, /gate-proven by locked tests: R1 -> unit::t::test_r1_feature; critic must prove \(no automated test\): R2/);

    // The hooks freeze the locked file while the loop runs.
    const edit = node(dir, FILE_GUARD, [], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(dir, ACC_FILE) } }));
    assert.equal(edit.code, 2, edit.out);
    assert.match(edit.out, /acceptance test locked/);

    // Iteration 1: the feature does not exist; the critic's claim cannot override the red test.
    const r2 = { id: 'R2', status: 'met', method: 'browser', evidence: 'opened the page, it looks like the mockup' };
    const first = iterate(dir, 1, { scores: HIGH, requirements: [{ id: 'R1', status: 'met', method: 'static', evidence: 'feature code looks done' }, r2] });
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /IN_PROGRESS \(1 requirement\(s\) not proven: R1\)/);
    assert.ok(scorecard(dir).attempts[0].blockers.some((/** @type {string} */ b) => /R1 not proven .*locked acceptance test fail/.test(b)));

    // Iteration 2: tampering with the locked test fails the gate; restoring it and implementing passes.
    builderWork(dir, 2);
    write(dir, 'src/feature.txt', 'done\n');
    write(dir, ACC_FILE, [{ name: 'test_r1_feature', outcome: 'pass' }]);
    const tampered = gate(dir);
    assert.equal(tampered.code, 2, tampered.out);
    assert.match(tampered.out, /acceptance lock.*tests\/acceptance\.json/s);
    write(dir, ACC_FILE, ACC_CASES);
    const ok = gate(dir);
    assert.equal(ok.code, 0, ok.out);
    criticReport(dir, 2, { scores: HIGH, requirements: [{ id: 'R1', status: 'unverified', method: 'static', evidence: 'did not run it myself' }, r2] });
    const second = cli(dir, 'record-verdict');
    assert.match(second.out, /APPROVED \(all 2 requirements proven\)/, second.out);
    assert.match(cli(dir, 'status').out, /R1 \[proven by acceptance\] met\/test/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acceptance: lock refuses tests that pass before any code, extra edits and unknown names', () => {
  const dir = makeProject();
  try {
    startNumbered(dir);
    specTester(dir);
    write(dir, ACC_FILE, [{ name: 'test_r1_feature', outcome: 'pass' }]);
    assert.match(cli(dir, 'lock-acceptance').out, /passes before any implementation/, 'a tautological test is refused');

    specTester(dir);
    write(dir, 'src/app.js', 'export const a = 99;\n');
    assert.match(cli(dir, 'lock-acceptance').out, /may only add the acceptance test files.*src\/app\.js/);
    git(dir, ['checkout', '--', 'src/app.js']);

    specTester(dir, { schema_version: 1, tests: [{ id: 'R1', files: [ACC_FILE], names: ['test_r1_typo'] }], not_testable: [NOT_TESTABLE_R2] });
    assert.match(cli(dir, 'lock-acceptance').out, /no test named 'test_r1_typo' ran/);
    specTester(dir, { schema_version: 1, tests: [{ id: 'R1', files: [ACC_FILE], names: ['test_r1_feature'] }] });
    assert.match(cli(dir, 'lock-acceptance').out, /not covered.*R2/);
    assert.equal(scorecard(dir).acceptance.state, 'pending', 'refusals change nothing');
    assert.equal(git(dir, ['log', '-1', '--format=%s']), 'gauntlet: init comp');

    // Behavior that already exists is locked as preexisting (green at lock).
    write(dir, 'src/feature.txt', 'already here\n');
    git(dir, ['add', 'src/feature.txt']);
    git(dir, ['commit', '-q', '-m', 'feature predates the loop']);
    specTester(dir, { schema_version: 1, tests: [{ id: 'R1', files: [ACC_FILE], names: ['test_r1_feature'], preexisting: true }], not_testable: [NOT_TESTABLE_R2] });
    const pre = cli(dir, 'lock-acceptance');
    assert.equal(pre.code, 0, pre.out);
    assert.match(pre.out, /already passing: R1/);
    assert.ok(!scorecard(dir).baseline_failures.includes('unit::t::test_r1_feature'), 'a green locked test must stay green');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acceptance: skip needs a reason and a clean tree; the spec-tester is blocked outside the phase', () => {
  const dir = makeProject();
  try {
    startNumbered(dir);
    assert.equal(cli(dir, 'skip-acceptance').code, 1, 'reason required');
    write(dir, ACC_FILE, ACC_CASES);
    assert.match(cli(dir, 'skip-acceptance', 'user decided to skip it').out, /uncommitted changes.*tests\/acceptance\.json/);
    fs.rmSync(path.join(dir, 'tests'), { recursive: true, force: true });
    assert.equal(cli(dir, 'skip-acceptance', 'user decided to skip it').code, 0);
    assert.match(cli(dir, 'status').out, /acceptance: skipped \(user decided to skip it\)/);
    assert.equal(cli(dir, 'next-iteration').out.trim(), '1');
    const late = node(dir, BREAKER, [], JSON.stringify({ tool_input: { subagent_type: 'gauntlet:spec-tester' } }));
    assert.equal(late.code, 2, 'spec-tester only runs while acceptance is pending');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- gate failure feedback ----------

/** Adds a failing test case (with a long name, so the log is long) to a project whose gate was passing. */
function breakTests(/** @type {string} */ dir) {
  write(dir, 'results.json', { cases: [...cases('pass', 'pass', 'pass'), { name: `bad_${'x'.repeat(3000)}`, outcome: 'fail' }] });
}

test('gate failure: reason is stored, shown by status and cleared when the gate passes', () => {
  const dir = makeProject();
  try {
    assert.equal(cli(dir, 'init', 'comp', 'ref.md').code, 0);
    assert.doesNotMatch(cli(dir, 'status').out, /last gate failure/);
    builderWork(dir, 1);
    breakTests(dir);
    const failed = gate(dir);
    assert.equal(failed.code, 2, failed.out);
    const f = scorecard(dir).last_gate_failure;
    assert.equal(f.attempt, 1);
    assert.equal(f.check, 'tests');
    assert.match(f.log, /new failures/);
    assert.ok(f.log.length > 0 && f.log.length <= 2000, `log length ${f.log.length}`);
    assert.equal(scorecard(dir).schema_version, 1);
    const st = cli(dir, 'status').out;
    const line = st.split('\n').find((l) => l.startsWith('last gate failure'));
    assert.ok(line, st);
    assert.match(line, /^last gate failure \(attempt 1\/3\): tests: new failures:/);
    assert.ok(line.length <= 'last gate failure (attempt 1/3): tests: '.length + 600, `line length ${line.length}`);
    assert.match(st, /next: re-dispatch builder for iteration 1 with the gate failure above/);

    write(dir, 'results.json', { cases: cases('pass', 'pass', 'pass') });
    const ok = gate(dir);
    assert.equal(ok.code, 0, ok.out);
    assert.equal(scorecard(dir).last_gate_failure, undefined, 'a passing gate clears the failure');
    const after = cli(dir, 'status').out;
    assert.doesNotMatch(after, /last gate failure/);
    assert.match(after, /next: run builder for iteration 1/);

    // A stale record (the gate already passed for this iteration) is not shown, and record-verdict drops it.
    const f2 = path.join(dir, '.gauntlet', 'scorecard.json');
    const sc2 = JSON.parse(fs.readFileSync(f2, 'utf8'));
    sc2.last_gate_failure = { attempt: 1, check: 'tests', log: 'old' };
    fs.writeFileSync(f2, JSON.stringify(sc2, null, 2));
    assert.doesNotMatch(cli(dir, 'status').out, /last gate failure/);
    criticReport(dir, 1);
    assert.equal(cli(dir, 'record-verdict').code, 0);
    assert.equal(scorecard(dir).last_gate_failure, undefined, 'record-verdict drops a stale failure');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gate failure: the third failure marks GATE_FAILED at once', () => {
  const dir = makeProject();
  try {
    assert.equal(cli(dir, 'init', 'comp', 'ref.md').code, 0);
    builderWork(dir, 1);
    breakTests(dir);
    assert.equal(gate(dir).code, 2, 'attempt 1 keeps the builder working');
    assert.equal(gate(dir).code, 2, 'attempt 2 keeps the builder working');
    assert.equal(scorecard(dir).loop_state, 'running');
    const third = gate(dir);
    assert.equal(third.code, 0, third.out);
    assert.match(third.out, /gate attempt 3\/3: tests/);
    const sc = scorecard(dir);
    assert.equal(sc.loop_state, 'terminal');
    assert.equal(sc.status, 'GATE_FAILED');
    assert.match(sc.halt_reason, /tests/);
    assert.equal(sc.last_gate_failure.attempt, 3);
    assert.match(cli(dir, 'status').out, /GATE_FAILED/);
    assert.doesNotMatch(cli(dir, 'status').out, /last gate failure/, 'a finished loop does not ask for a re-dispatch');
    const breaker = node(dir, BREAKER, [], JSON.stringify({ tool_input: { subagent_type: 'gauntlet:builder' } }));
    assert.equal(breaker.code, 2, 'no further builder after GATE_FAILED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bash-guard: the inbox folder itself is writable', () => {
  const dir = makeProject();
  try {
    const BASH_GUARD = path.join(HERE, '..', 'hooks', 'bash-guard.mjs');
    const guard = (/** @type {string} */ command) => node(dir, BASH_GUARD, [], JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
    for (const c of ['mkdir -p .gauntlet/inbox', 'mkdir -p .gauntlet/inbox/', 'mkdir -p ./.gauntlet/inbox']) {
      const r = guard(c);
      assert.equal(r.code, 0, `${c}: ${r.out}`);
    }
    // Only creating the folder is allowed: moving, copying or deleting it, or walking out of it, is not.
    for (const c of ['mkdir .gauntlet/other', 'rm -rf .gauntlet', 'mv .gauntlet/inbox ../gone', 'mv x .gauntlet/inbox',
      'cp -r .gauntlet/inbox ../gone', 'mkdir -p .gauntlet/inbox/..']) {
      const r = guard(c);
      assert.equal(r.code, 2, `${c}: ${r.out}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
