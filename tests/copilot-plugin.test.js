#!/usr/bin/env node
// Smoke test for the Copilot plugin adapter: keep command wiring minimal and
// ensure the debt command is part of the shared command surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const REQUIRED_COMMAND_FILES = [
  'ponytail.toml',
  'ponytail-review.toml',
  'ponytail-audit.toml',
  'ponytail-debt.toml',
  'ponytail-gain.toml',
  'ponytail-help.toml',
];

function readJSON(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));
}

test('copilot plugin command directory includes ponytail-debt', () => {
  const manifest = readJSON('.github/plugin/plugin.json');
  assert.equal(manifest.name, 'ponytail');
  assert.equal(manifest.commands, 'commands/');

  for (const file of REQUIRED_COMMAND_FILES) {
    assert.ok(
      fs.existsSync(path.join(root, manifest.commands, file)),
      `missing command file: ${manifest.commands}${file}`,
    );
  }
});

test('Copilot highest-priority manifest exposes components without changing the Grok adapter', () => {
  // GitHub's legacy lookup chooses .plugin/plugin.json before the root manifest.
  const locations = ['.plugin/plugin.json', 'plugin.json', '.github/plugin/plugin.json', '.claude-plugin/plugin.json'];
  const effective = locations.find(location => fs.existsSync(path.join(root, location)));
  assert.equal(effective, '.plugin/plugin.json');
  const manifest = readJSON(effective);
  const adapter = readJSON('.github/plugin/plugin.json');
  for (const component of ['commands', 'skills', 'hooks', 'agents']) {
    assert.equal(manifest[component], adapter[component], component);
    assert.ok(fs.existsSync(path.join(root, manifest[component])), component);
  }
  assert.equal(manifest.agents, 'agents/');
  assert.ok(fs.existsSync(path.join(root, manifest.agents, 'guardrail-reviewer.agent.md')));
  const pkg = readJSON('package.json');
  assert.ok(pkg.files.includes('agents/'));
  assert.ok(pkg.files.includes('commands/'));
  assert.ok(pkg.files.includes('.plugin/'));
  assert.equal(readJSON('plugin.json').hooks, undefined);
});

test('Copilot review hooks supply context at session start and after tools', () => {
  const { hooks } = readJSON('hooks/copilot-hooks.json');
  assert.match(hooks.sessionStart[0].bash, /ponytail-activate\.js/);
  assert.match(hooks.userPromptSubmitted[0].bash, /ponytail-mode-tracker\.js/);
  assert.equal(hooks.agentStop, undefined);
  assert.equal(Object.values(hooks).flat().filter(entry => entry.bash.includes('guardrail-review.js')).length, 2);
  for (const event of ['sessionStart', 'postToolUse']) {
    const entries = hooks[event].filter(entry => entry.bash.includes('guardrail-review.js'));
    assert.equal(entries.length, 1, event);
    assert.equal(entries[0].type, 'command');
    assert.match(entries[0].bash, new RegExp(`--hook ${event}$`));
    assert.match(entries[0].powershell, new RegExp(`--hook ${event}$`));
  }
});

test('removing canonical skill removes its instructions instead of replaying a fallback', t => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-canonical-'));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  fs.mkdirSync(path.join(isolated, 'hooks'));
  fs.mkdirSync(path.join(isolated, 'skills', 'ponytail'), { recursive: true });
  for (const name of ['ponytail-config.js', 'ponytail-instructions.js']) {
    fs.copyFileSync(path.join(root, 'hooks', name), path.join(isolated, 'hooks', name));
  }
  const skill = path.join(isolated, 'skills', 'ponytail', 'SKILL.md');
  fs.writeFileSync(skill, 'A unique canonical instruction for this isolated fixture.');
  const instructions = require(path.join(isolated, 'hooks', 'ponytail-instructions.js'));
  assert.match(instructions.getPonytailInstructions('full'), /unique canonical instruction/);

  fs.unlinkSync(skill);
  const missing = instructions.getPonytailInstructions('full');
  assert.match(missing, /INSTRUCTIONS UNAVAILABLE — source_missing/);
  assert.match(missing, /skills\/ponytail\/SKILL\.md/);
  assert.doesNotMatch(missing, /MODE ACTIVE|unique canonical|## Rules|Never simplify/);
  assert.match(instructions.getPonytailInstructions('review'), /Behavior defined by \/ponytail-review skill/);

  fs.mkdirSync(skill);
  assert.match(instructions.getPonytailInstructions('full'), /INSTRUCTIONS UNAVAILABLE — source_unavailable/);
});
