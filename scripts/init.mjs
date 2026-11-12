// Opts a project into the Gauntlet harness.
// Usage: node init.mjs <projectDir> <discoveryJson> [--migrate]
//   - writes .claude/harness/discovery.json and allowed-suppressions.json
//   - copies the RUNBOOK to .gauntlet/RUNBOOK.md
//   - adds secret_files deny rules to .claude/settings.json, .gitignore entries and a CLAUDE.md block
//   - --migrate: removes the legacy per-project copy made by harness-kit/install.mjs
//     (hook entries in settings.json, .claude/hooks, builder/critic agents, /gauntlet command, .gauntlet/gauntlet-cli.mjs)
// Hooks, agents, the command and the CLI come from the plugin and are never copied into the project.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const migrate = args.includes('--migrate');
const [projArg, cfgArg] = args.filter((a) => !a.startsWith('--'));
if (!projArg || !cfgArg) {
  console.error('usage: node init.mjs <projectDir> <discoveryJson> [--migrate]');
  process.exit(1);
}
const proj = path.resolve(projArg);
const cfg = JSON.parse(fs.readFileSync(path.resolve(cfgArg), 'utf8'));
if (!cfg || typeof cfg !== 'object' || !cfg.commands || !('test' in cfg.commands)) {
  console.error('discovery json must be an object with commands.test (see templates/discovery.example.json)');
  process.exit(1);
}
if (!fs.existsSync(proj)) {
  console.error(`project dir not found: ${proj}`);
  process.exit(1);
}

const done = [];

// discovery + allowlist
const hdir = path.join(proj, '.claude', 'harness');
fs.mkdirSync(hdir, { recursive: true });
fs.writeFileSync(path.join(hdir, 'discovery.json'), JSON.stringify(cfg, null, 2) + '\n');
const allow = path.join(hdir, 'allowed-suppressions.json');
if (!fs.existsSync(allow)) fs.writeFileSync(allow, '[]\n');
done.push('wrote .claude/harness/discovery.json');

// runbook
const gdir = path.join(proj, '.gauntlet');
fs.mkdirSync(gdir, { recursive: true });
fs.copyFileSync(path.join(HERE, '..', 'templates', 'RUNBOOK.md'), path.join(gdir, 'RUNBOOK.md'));
done.push('wrote .gauntlet/RUNBOOK.md');

// settings.json: secret deny rules (+ legacy hook removal on --migrate)
const sf = path.join(proj, '.claude', 'settings.json');
const settings = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {};
if (migrate && settings.hooks) {
  for (const [ev, entries] of Object.entries(settings.hooks)) {
    const kept = entries.filter((e) => !JSON.stringify(e).includes('/.claude/hooks/'));
    if (kept.length !== entries.length) done.push(`removed legacy ${ev} hook entries from settings.json`);
    if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}
const deny = (cfg.secret_files || []).flatMap((f) => [`Read(./${f})`, `Edit(./${f})`]);
if (deny.length) {
  settings.permissions = settings.permissions || {};
  settings.permissions.deny = [...new Set([...(settings.permissions.deny || []), ...deny])];
}
fs.writeFileSync(sf, JSON.stringify(settings, null, 2) + '\n');
done.push('updated .claude/settings.json');

// legacy files
if (migrate) {
  const legacy = [
    ['.claude', 'hooks'],
    ['.claude', 'agents', 'builder.md'],
    ['.claude', 'agents', 'critic.md'],
    ['.claude', 'commands', 'gauntlet.md'],
    ['.gauntlet', 'gauntlet-cli.mjs'],
  ];
  for (const parts of legacy) {
    const p = path.join(proj, ...parts);
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); done.push(`removed legacy ${parts.join('/')}`); }
  }
}

// .gitignore
const gi = path.join(proj, '.gitignore');
const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
const add = ['.gauntlet/inbox/', '.gauntlet/history/', '.gauntlet/scorecard.json', '.gauntlet/*.tmp', '.claude/harness/debug.log', '.claude/settings.local.json'];
const missing = add.filter((l) => !giText.split(/\r?\n/).includes(l));
if (missing.length) {
  fs.writeFileSync(gi, giText.replace(/\s*$/, '\n') + '\n# harness\n' + missing.join('\n') + '\n');
  done.push('updated .gitignore');
}

// CLAUDE.md block
const cm = path.join(proj, 'CLAUDE.md');
const block = '## Harness\n\nHarness ativo (ver `.gauntlet/RUNBOOK.md`). Mensagens `[HARNESS]` ou `[CIRCUIT BREAKER]` sao intencionais: nao tente contornar, informe o usuario. Nunca edite arquivos em `.gauntlet/` fora de `.gauntlet/inbox/`. Gauntlet Loop: `/gauntlet:gauntlet <componente> <referencia>`.\n';
const cmText = fs.existsSync(cm) ? fs.readFileSync(cm, 'utf8') : '';
if (!cmText.includes('## Harness')) {
  fs.writeFileSync(cm, (cmText ? cmText.replace(/\s*$/, '\n\n') : '') + block);
  done.push('added Harness block to CLAUDE.md');
}

console.log(done.map((d) => ' - ' + d).join('\n'));
console.log(`gauntlet harness enabled in ${proj}. Restart the Claude session so the plugin hooks apply.`);
