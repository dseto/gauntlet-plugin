// Regression tests for bash-guard fixes (#10 copy sources, #11 /tmp on Windows Git Bash).
// Run: node --test tests/guard-fixes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, '..', 'hooks', 'bash-guard.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-guard-'));
fs.mkdirSync(path.join(dir, '.claude', 'harness'), { recursive: true });
fs.writeFileSync(path.join(dir, '.claude', 'harness', 'discovery.json'), JSON.stringify({
  schema_version: 1, secret_files: [], protected_files: ['pytest.ini'], hook_payload: { pretooluse_agent_type: true },
  commands: { build: 'NONE', test: [] },
}));

/** @param {string} command @returns {number|null} guard exit code (2 = blocked) */
function guard(command) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  delete env.HARNESS_OFF;
  const r = spawnSync(process.execPath, [GUARD], { cwd: dir, encoding: 'utf8', env, input: JSON.stringify({ tool_input: { command } }) });
  return r.status;
}
const blocked = (/** @type {string} */ c) => assert.equal(guard(c), 2, `expected block: ${c}`);
const allowed = (/** @type {string} */ c) => assert.equal(guard(c), 0, `expected allow: ${c}`);

test('#10 cp from a protected source is allowed', () => {
  allowed('cp pytest.ini copy-of-it.txt');
  allowed('cp pytest.ini ' + path.join(os.tmpdir(), 'out').replace(/\\/g, '/') + '/');
});

test('#10 cp to a protected destination is blocked', () => {
  blocked('cp x pytest.ini');
  blocked('cp -r a b pytest.ini');
});

test('#10 mv of a protected source is still blocked', () => {
  blocked('mv pytest.ini ' + os.tmpdir().replace(/\\/g, '/') + '/');
  blocked('mv x pytest.ini');
});

test('#10 cp short-flag clusters with t/T fail closed (no protected write through -vt, -rt, -T, -tDIR)', () => {
  blocked('cp -vt pytest.ini x');
  blocked('cp -rt .claude x');
  blocked('cp -Pt .gauntlet x');
  blocked('cp -T x pytest.ini');
  blocked('cp -t.claude x');
  blocked('cp -tpytest.ini x');
});

test('#10 cp -t / --target-directory / Copy-Item -Destination', () => {
  allowed('cp -t ' + os.tmpdir().replace(/\\/g, '/') + '/out pytest.ini');
  blocked('cp -t .claude pytest.ini');
  blocked('cp --target-directory=.claude x.txt');
  allowed('Copy-Item pytest.ini -Destination out.txt');
  blocked('Copy-Item x.txt -Destination pytest.ini');
});

test('#11 /tmp writes on win32 map to the OS temp dir', { skip: process.platform !== 'win32' }, () => {
  allowed('echo hi > /tmp/guard-fixes.txt');
  allowed('mkdir -p /var/tmp/guard-fixes');
});

test('#11 /tmpfoo and /tmp/../x are not treated as temp', () => {
  blocked('echo hi > /tmpfoo/x.txt');
  blocked('echo hi > /tmp/../etc/x.txt');
});
