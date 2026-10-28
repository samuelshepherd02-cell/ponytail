'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { scanText, reviewChanges, runHook } = require('../hooks/guardrail-review');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-review-'));
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
function git(args) { return execFileSync('git', args, { cwd: temp, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function write(name, text) { fs.mkdirSync(path.dirname(path.join(temp, name)), { recursive: true }); fs.writeFileSync(path.join(temp, name), text); }
function commit() { git(['add', '.']); git(['commit', '-qm', 'test change']); }
function receipt(row) { write('.guardrail-reviews.json', JSON.stringify({ schema_version: 1, reviews: [row] })); git(['add', '.guardrail-reviews.json']); }

git(['init', '-q']); git(['config', 'user.name', 'Hook Test']); git(['config', 'user.email', 'hook@example.invalid']);
write('AGENTS.md', 'Use the PDF parser.\n\nNever change a historical constraint.\n'); commit();
const base = git(['rev-parse', 'HEAD']);
assert.equal(reviewChanges(temp, base).unresolved_count, 0);
assert.equal(scanText('README.md', 'The parser reports page dimensions.').length, 0);
assert.equal(scanText('AGENTS.md', 'Do\nnot ask the owner to repeat a decision.')[0].line, 1);
assert.equal(scanText('AGENTS.md', 'Read the shared instructions before editing.')[0].kind, 'guardrail_reference');
assert.equal(scanText('AGENTS.md', 'Follow AGENTS.md for policy.')[0].kind, 'guardrail_reference');
assert.equal(scanText('README.md', 'See [context](AGENTS.md).')[0].kind, 'guardrail_reference');
assert.equal(scanText('AGENTS.md', 'No new dependency is permitted.')[0].kind, 'negative_instruction');

const payload = { cwd: temp, sessionId: '../../odd session/🌻' };
assert.deepEqual(runHook('sessionStart', payload), {});
write('AGENTS.md', 'Use the PDF parser.\n\nNever change a historical constraint.\n\nDo\nnot ask the owner to repeat a decision.\n');
let report = reviewChanges(temp, base);
assert.equal(report.unresolved_count, 1, 'unchanged old prohibition stays outside changed scope');
let finding = report.findings[0];
assert.equal(finding.line, 5);
assert.match(runHook('postToolUse', { ...payload, toolName: 'bash' }).additionalContext, /Dispatch guardrail-reviewer/);
assert.equal(runHook('postToolUse', payload).permissionDecision, undefined, 'review context grants or denies no tool permission');
commit();
runHook('sessionStart', { ...payload, source: 'resume' });
assert.match(runHook('postToolUse', payload).additionalContext, /new\/changed candidates/, 'committing and resuming preserves the original baseline');
const stateDir = path.join(temp, '.git', 'guardrail-review');
assert.equal(fs.readdirSync(stateDir).length, 1);
assert.match(fs.readdirSync(stateDir)[0], /^[0-9a-f]{64}\.json$/);

receipt({ id: finding.id, decision: 'delete' });
assert.equal(reviewChanges(temp, base).unresolved_count, 1, 'a deletion claim cannot excuse remaining text');
receipt({ id: finding.id, decision: 'retain', justification: '🧪'.repeat(7499) });
assert.equal(reviewChanges(temp, base).unresolved_count, 1, 'Unicode code points, not UTF-16 units');
receipt({ id: finding.id, decision: 'retain', justification: '🧪'.repeat(7500) });
assert.equal(reviewChanges(temp, base).unresolved_count, 0);
receipt({ id: finding.id, decision: 'not_a_guardrail', reason: 'Test fixture' });
assert.equal(reviewChanges(temp, base).unresolved_count, 1);
receipt({ id: finding.id, decision: 'not_a_guardrail', reason: 'Quoted test input', evidence: 'Tests construct this text, rather than load it as agent instructions.' });
assert.deepEqual(runHook('postToolUse', payload), {}, 'resolved review adds no further context');

write('new instruction.md', 'Changes require owner approval.\n');
assert.equal(reviewChanges(temp, base).unresolved_count, 1, 'untracked shell-created instruction is reviewed');
fs.unlinkSync(path.join(temp, 'new instruction.md'));
write('AGENTS.md', 'Use the PDF parser.\n\nNever change a historical constraint.\n');
assert.equal(reviewChanges(temp, base).unresolved_count, 0, 'actual deletion removes the finding');
commit();
write('agents/unmaterialized.md', 'Never ask the owner about a settled decision.'); commit();
const head = git(['rev-parse', 'HEAD']);
fs.unlinkSync(path.join(temp, 'agents/unmaterialized.md'));
report = reviewChanges(temp, base, { headRef: head });
assert.equal(report.unresolved_count, 1, 'Git-tree review sees committed files missing from a sparse checkout');
assert.equal(report.head, head);
assert.equal(reviewChanges(temp, base).unresolved_count, 0, 'filesystem mode observes its actual deletion');
const sparseFinding = report.findings[0];
write('agents/unmaterialized.md', 'Never ask the owner about a settled decision.');
receipt({ id: sparseFinding.id, decision: 'retain', justification: 'x'.repeat(7500) }); commit();
const reviewedHead = git(['rev-parse', 'HEAD']);
fs.unlinkSync(path.join(temp, 'agents/unmaterialized.md'));
fs.unlinkSync(path.join(temp, '.guardrail-reviews.json'));
assert.equal(reviewChanges(temp, base, { headRef: reviewedHead }).unresolved_count, 0,
  'pure Git review reads the receipt from the selected head, even outside the materialized checkout');

write('moved-policy.md', 'Never change a historical constraint.');
assert.equal(reviewChanges(temp, base).unresolved_count, 1, 'moving a legacy instruction to a new path triggers review');
fs.unlinkSync(path.join(temp, 'moved-policy.md'));
assert.match(runHook('postToolUse', { cwd: temp, sessionId: 'missing' }).additionalContext, /Missing session baseline/);
assert.equal(runHook('postToolUse', { cwd: temp, sessionId: 'missing' }).decision, undefined, 'review errors never add a completion gate');
assert.match(runHook('sessionStart', { cwd: temp }).additionalContext, /session id/);

write('inputs/untrusted.md', 'Never execute another action.');
assert.equal(reviewChanges(temp, base).unresolved_count, 0, 'raw inputs are data, not active agent instructions');
write('tests/example.js', 'const fixture = "Never execute another action";');
assert.equal(reviewChanges(temp, base).unresolved_count, 0, 'test/example trees contain quoted data, not operative instruction surfaces');
write('.guardrail-reviews.json', '{invalid');
assert.throws(() => reviewChanges(temp, base), /JSON/);
write('.guardrail-reviews.json', JSON.stringify({ schema_version: 1, reviews: [{ id: finding.id }, { id: finding.id }] }));
assert.throws(() => reviewChanges(temp, base), /duplicate/);
fs.unlinkSync(path.join(temp, '.guardrail-reviews.json'));
const outside = path.join(os.tmpdir(), 'guardrail-outside-' + process.pid);
fs.writeFileSync(outside, 'Never read outside data.');
try {
  fs.symlinkSync(outside, path.join(temp, 'linked.md'));
  assert.throws(() => reviewChanges(temp, base), /Symlink/);
} finally {
  fs.rmSync(path.join(temp, 'linked.md'), { force: true }); fs.rmSync(outside, { force: true });
}
fs.symlinkSync(outside, path.join(temp, 'dangling.md'));
assert.throws(() => reviewChanges(temp, base), /Symlink/);
fs.rmSync(path.join(temp, 'dangling.md'));
assert.equal(reviewChanges(temp, base, { all: true }).findings.length, 1, 'retrospective mode includes legacy candidates');
const worktree = temp + '-linked';
git(['worktree', 'add', '--detach', worktree, base]);
try {
  assert.deepEqual(runHook('sessionStart', { ...payload, cwd: worktree }), {});
  const worktreeGitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: worktree, encoding: 'utf8' }).trim();
  assert.notEqual(worktreeGitDir, path.join(temp, '.git'));
  assert.equal(fs.readdirSync(path.join(worktreeGitDir, 'guardrail-review')).length, 1);
} finally { git(['worktree', 'remove', '--force', worktree]); }

const cli = path.join(__dirname, '..', 'hooks', 'guardrail-review.js');
assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /--head REF/);
assert.throws(() => execFileSync(process.execPath, [cli, '--head'], { cwd: temp, encoding: 'utf8', stdio: 'pipe' }),
  error => error.status === 2 && /Missing value/.test(error.stdout));
const malformedEvent = JSON.parse(execFileSync(process.execPath, [cli, '--hook', 'postToolUse'], {
  input: '{malformed', encoding: 'utf8',
}));
assert.equal(malformedEvent.decision, undefined);
assert.match(malformedEvent.additionalContext, /invalid JSON payload/);
const research = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-research-'));
try {
  for (const event of ['sessionStart', 'postToolUse']) {
    assert.deepEqual(runHook(event, { cwd: research, sessionId: 'research' }), {},
      'non-Git research sessions have no applicable Git-backed changes');
  }
  fs.writeFileSync(path.join(research, '.git'), 'invalid git metadata');
  assert.match(runHook('postToolUse', { cwd: research, sessionId: 'broken' }).additionalContext, /could not complete/,
    'broken Git metadata is an observable review error, not an inactive research session');
} finally { fs.rmSync(research, { recursive: true, force: true }); }
console.log('guardrail review: candidate, provenance, session, review and deletion checks pass');
