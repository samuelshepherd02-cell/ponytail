#!/usr/bin/env node
'use strict';

// ponytail: lexical candidates, not semantic verdicts; the reviewer supplies
// context/evidence. Extend these patterns when a missed wording is demonstrated.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RECEIPT = '.guardrail-reviews.json';
const MIN_JUSTIFICATION = 7500;
const NEGATIVE = /\b(?:do\s+not|don[’']t|never|must\s+not|shall\s+not|may\s+not|cannot|can[’']t|forbidden|prohibited|not\s+allowed|only\s+after|only\s+if|must\s+first|no\s+(?:new|additional|unrequested|extra|fallback|retry|recovery|OCR)|requir(?:e|es|ed)\s+(?:owner\s+|human\s+|manual\s+)?approval)\b/i;
const REFERENCE = /\bguardrails?\b|\b(?:AGENTS|CLAUDE|GEMINI)\.md\b|\bcopilot-instructions\.md\b|\b(?:follow|obey|consult|read|apply|governed\s+by)\b.{0,160}\b(?:AGENTS(?:\.md)?|CLAUDE(?:\.md)?|instructions?|polic(?:y|ies)|rules?)\b/i;
const EXTENSIONS = /\.(?:md|mdx|txt|rst|adoc|json|ya?ml|[cm]?js|[cm]?ts|tsx|jsx|py|sh|ps1)$/i;
const EXCLUDED = /(?:^|\/)(?:\.git|node_modules|vendor|\.venv|venv|inputs|artifacts|reports|dist|build|coverage|tests?|__tests__|fixtures|examples)(?:\/|$)/;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const normalized = text => text.replace(/\s+/gu, ' ').trim();

function git(repo, args, options = {}) {
  const { preserveWhitespace = false, ...commandOptions } = options;
  const output = execFileSync('git', ['--no-pager', ...args], {
    cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...commandOptions,
  });
  return preserveWhitespace ? output : output.trimEnd();
}

function instructionSurface(name) {
  return /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|SKILL|HANDOFF)(?:\.md)?$/i.test(name) ||
    /^\.github\/.*instructions.*\.md$/i.test(name) || /^\.github\/agents\/.*\.md$/i.test(name) ||
    /^agents\/(?:.*\/)?instructions\.md$/i.test(name) || /^agents\/.*\.agent\.md$/i.test(name);
}

function eligible(name) {
  return name !== RECEIPT && !EXCLUDED.test(name) &&
    (EXTENSIONS.test(name) || instructionSurface(name));
}

function exists(name) {
  try { fs.lstatSync(name); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function scanText(name, text) {
  const findings = [];
  // Paragraph boundaries retain wrapped prohibitions and their surrounding context.
  const chunks = String(text).split(/\r?\n[\t ]*\r?\n/);
  let offset = 0;
  for (const chunk of chunks) {
    const start = String(text).indexOf(chunk, offset);
    offset = start + chunk.length;
    const value = normalized(chunk);
    const negative = NEGATIVE.test(value);
    if (!negative && !REFERENCE.test(value)) continue;
    findings.push({ id: digest(name + '\0' + value), path: name,
      line: String(text).slice(0, start).split('\n').length,
      kind: negative ? 'negative_instruction' : 'guardrail_reference', text: value });
  }
  return findings;
}

function localText(repo, name, maxBytes = 1024 * 1024) {
  const target = path.resolve(repo, name);
  if (!target.startsWith(repo + path.sep)) throw new Error('Path escapes repository: ' + name);
  let current = repo;
  for (const part of path.relative(repo, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink review input: ' + name);
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Unreviewable file type/size: ' + name);
  const bytes = fs.readFileSync(target);
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

function revisionText(repo, revision, name, maxBytes = 1024 * 1024) {
  const entry = git(repo, ['ls-tree', '-z', revision, '--', name]);
  if (!entry) return null;
  const [mode, type, sha] = entry.slice(0, entry.indexOf('\t')).split(' ');
  if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('Unsupported review input mode: ' + name);
  if (Number(git(repo, ['cat-file', '-s', sha])) > maxBytes) throw new Error('Unreviewable file size: ' + name);
  return git(repo, ['show', revision + ':' + name], { preserveWhitespace: true });
}

function receipts(repo, head) {
  let text;
  if (head) text = revisionText(repo, head, RECEIPT, 8 * 1024 * 1024);
  else {
    if (!exists(path.join(repo, RECEIPT))) return new Map();
    // A newly authored receipt is usable once staged; an untracked receipt is not durable.
    try { git(repo, ['ls-files', '--error-unmatch', '--', RECEIPT]); }
    catch { throw new Error(RECEIPT + ' must be tracked (git add the review result)'); }
    text = localText(repo, RECEIPT, 8 * 1024 * 1024);
  }
  if (text === null) return new Map();
  const raw = JSON.parse(text);
  if (!raw || raw.schema_version !== 1 || !Array.isArray(raw.reviews)) {
    throw new Error('Invalid ' + RECEIPT + ' schema');
  }
  const result = new Map();
  for (const row of raw.reviews) {
    if (!row || !/^[0-9a-f]{64}$/.test(row.id) || result.has(row.id)) {
      throw new Error('Invalid or duplicate review finding id');
    }
    result.set(row.id, row);
  }
  return result;
}

function reviewChanges(repo, baseRef = 'HEAD', options = {}) {
  repo = fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel']));
  const base = options.all ? null : git(repo, ['rev-parse', '--verify', baseRef + '^{commit}']);
  const head = options.headRef ? git(repo, ['rev-parse', '--verify', options.headRef + '^{commit}']) : null;
  const names = options.all ? (head ? git(repo, ['ls-tree', '-rz', '--name-only', head]) :
    git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])) :
    git(repo, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, ...(head ? [head] : []), '--']) +
    (head ? '' : '\0' + git(repo, ['ls-files', '-z', '--others', '--exclude-standard']));
  const reviews = receipts(repo, head);
  const findings = [];
  const changedInstructions = [];
  for (const name of [...new Set(names.split('\0').filter(Boolean))].sort()) {
    if (!eligible(name) || (!head && !exists(path.join(repo, name)))) continue;
    const current = head ? revisionText(repo, head, name) : localText(repo, name);
    if (current === null || current.includes('\0')) continue;
    const old = base ? revisionText(repo, base, name) || '' : '';
    if (instructionSurface(name) && current !== old) changedInstructions.push({ path: name, sha256: digest(current) });
    const prior = new Set(scanText(name, old).map(row => row.id));
    for (const candidate of scanText(name, current)) {
      if (prior.has(candidate.id)) continue;
      const record = reviews.get(candidate.id);
      let resolved = false;
      if (record?.decision === 'retain') {
        resolved = typeof record.justification === 'string' &&
          Array.from(record.justification.trim()).length >= MIN_JUSTIFICATION;
      } else if (record?.decision === 'not_a_guardrail') {
        resolved = typeof record.reason === 'string' && !!record.reason.trim() &&
          typeof record.evidence === 'string' && !!record.evidence.trim();
      }
      findings.push({ ...candidate, resolved,
        decision: record?.decision || null,
        review_requirement: 'delete source, or retain with 7500-character justification, or evidence-backed non-guardrail classification' });
    }
  }
  const unresolved = findings.filter(row => !row.resolved);
  return { schema_version: 1, scope: options.all ? 'all_current_text_candidates' : 'new_or_changed_text_candidates',
    detection: 'lexical_candidates_require_semantic_review', repository: repo,
    base, head, status: unresolved.length ? 'needs_review' : 'pass', findings,
    semantic_scope: 'changed_instruction_surfaces_trigger_review_even_without_lexical_matches; CLI_check_validates_lexical_dispositions',
    changed_instruction_files: changedInstructions,
    unresolved_count: unresolved.length };
}

function stateFile(repo, payload) {
  const session = payload.sessionId || payload.session_id;
  if (typeof session !== 'string' || !session.trim()) throw new Error('Missing hook session id');
  const directory = git(repo, ['rev-parse', '--absolute-git-dir']);
  return path.join(directory, 'guardrail-review', digest(session) + '.json');
}

function message(report) {
  const unresolved = report.findings.filter(row => !row.resolved);
  const rows = unresolved.slice(0, 12).map(row =>
    `${row.path}:${row.line} [${row.id}] ${row.text.slice(0, 180)}`);
  return `Guardrail review: ${unresolved.length} new/changed lexical candidates; ${report.changed_instruction_files.length} changed instruction surfaces. Dispatch guardrail-reviewer to critically review their actual context, including positive paraphrases and referenced restrictions. ` +
    `Delete unnecessary restrictions in their canonical sources and generated/fallback copies. ` +
    `A retained restriction needs its exact finding id and an intrinsic-benefit, necessity, and lack-of-alternatives justification of at least ${MIN_JUSTIFICATION} characters in ${RECEIPT}. ` +
    `A descriptive example needs decision not_a_guardrail with reason and evidence. Stage the receipt. ` +
    `The lexical detector is not a semantic verdict. Full report command argv: ${JSON.stringify([process.execPath, __filename, '--base', report.base, '--check'])}\n` +
    rows.join('\n') + (unresolved.length > 12 ? '\nAdditional candidates are in the full report.' : '') +
    '\nChanged instruction surfaces: ' + report.changed_instruction_files.slice(0, 12).map(row => `${row.path} [${row.sha256}]`).join(', ');
}

function saveState(file, value) {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

function runHook(event, payload) {
  try {
    let top;
    try { top = git(payload.cwd || process.cwd(), ['rev-parse', '--show-toplevel']); }
    catch (error) {
      // Git-backed changes are the hook's scope; ordinary research sessions have none.
      if (error.status === 128 && /fatal: not a git repository\b/.test(String(error.stderr))) return {};
      throw error;
    }
    const repo = fs.realpathSync(top);
    const state = stateFile(repo, payload);
    if (event === 'sessionStart') {
      if (!fs.existsSync(state)) {
        fs.mkdirSync(path.dirname(state), { recursive: true });
        saveState(state, { base: git(repo, ['rev-parse', 'HEAD']) });
      }
      return {};
    }
    if (!fs.existsSync(state)) throw new Error('Missing session baseline; sessionStart hook must run before review');
    const stored = JSON.parse(fs.readFileSync(state, 'utf8'));
    if (!/^[0-9a-f]{40,64}$/.test(stored.base)) throw new Error('Invalid session baseline');
    const report = reviewChanges(repo, stored.base);
    if (event === 'postToolUse') {
      const pending = report.findings.filter(row => !row.resolved).map(row => [row.id, row.text]);
      const key = pending.length || report.changed_instruction_files.length ?
        digest(JSON.stringify([pending, report.changed_instruction_files])) : null;
      if (key === (stored.lastNotification || null)) return {};
      saveState(state, { ...stored, lastNotification: key });
      return key ? { additionalContext: message(report) } : {};
    }
    throw new Error('Unsupported hook event: ' + event);
  } catch (error) {
    const reason = 'Guardrail review could not complete: ' + error.message;
    return { additionalContext: reason };
  }
}

function main(args = process.argv.slice(2)) {
  try {
    if (args.includes('--help')) {
      process.stdout.write('Usage: node guardrail-review.js [--base REF] [--head REF] [--all] [--check]\n' +
        '       node guardrail-review.js --hook sessionStart|postToolUse < event.json\n' +
        'Default: changed filesystem text plus untracked files; --head reads Git trees; --all includes existing candidates.\n');
      return 0;
    }
    for (let i = 0; i < args.length; i++) {
      if (['--base', '--head', '--hook'].includes(args[i])) {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing value for ' + args[i]);
        i++;
      } else if (!['--all', '--check'].includes(args[i])) throw new Error('Unknown argument: ' + args[i]);
    }
    const hook = args.indexOf('--hook');
    if (hook !== -1) {
      let payload;
      try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); }
      catch {
        const reason = 'Guardrail review could not parse hook input: invalid JSON payload';
        process.stdout.write(JSON.stringify({ additionalContext: reason }) + '\n');
        return 0;
      }
      const result = runHook(args[hook + 1], payload);
      process.stdout.write(JSON.stringify(result) + '\n');
      return 0;
    }
    const baseIndex = args.indexOf('--base');
    const headIndex = args.indexOf('--head');
    const report = reviewChanges(process.cwd(), baseIndex === -1 ? 'HEAD' : args[baseIndex + 1], {
      all: args.includes('--all'), headRef: headIndex === -1 ? null : args[headIndex + 1],
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return args.includes('--check') && report.unresolved_count ? 1 : 0;
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'error', error: error.message }) + '\n');
    return 2;
  }
}

module.exports = { scanText, reviewChanges, runHook, main, MIN_JUSTIFICATION };
if (require.main === module) process.exitCode = main();
