#!/usr/bin/env node
// Release tool for VHL Text Overlay.
//
//   node scripts/release.mjs check                 validate the extension (manifest, files, icons, syntax)
//   node scripts/release.mjs build                 check, then build dist/VHL-Text-Overlay.zip
//   node scripts/release.mjs notes [--from <ref>]  write dist/RELEASE_NOTES.md from the git history
//   node scripts/release.mjs bump <patch|minor|major|x.y.z>
//                                                  set the version + add a CHANGELOG.md entry
//   node scripts/release.mjs prepare <patch|minor|major|x.y.z>
//                                                  test, bump, build, write notes, commit and tag
//
// Options: --dry-run (change nothing), --skip-tests, --no-git (prepare: don't commit/tag)
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createZip } from './lib/zip.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// VHL_EXT_DIR lets the mutation check run the tests against a deliberately broken copy.
export const EXT_DIR = process.env.VHL_EXT_DIR ? path.resolve(process.env.VHL_EXT_DIR) : path.join(ROOT, 'extension');
export const DIST = path.join(ROOT, 'dist');
export const ZIP_NAME = 'VHL-Text-Overlay.zip';
// Files go at the top of the zip (no folder inside). Unzipping then gives exactly one
// folder, named after the zip, with manifest.json directly in it: the folder people pick
// in "Load unpacked". (A folder inside the zip turns into a folder-in-a-folder on Windows.)
export const UNZIPPED_FOLDER = 'VHL-Text-Overlay';
const REPO_URL = 'https://github.com/aidanmccants/vhl-overlay';

// Permissions the extension is allowed to ask for. Anything else fails the check,
// so a new permission is always a deliberate change.
export const ALLOWED_PERMISSIONS = ['activeTab', 'storage', 'clipboardWrite'];
export const ALLOWED_HOSTS = ['*://*.vhlcentral.com/*'];

const log = (...a) => console.log(...a);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
}

export function listExtensionFiles(dir = EXT_DIR, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('.') || ent.name === 'Thumbs.db') continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listExtensionFiles(path.join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out;
}

export function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Returns a list of problems (empty = OK). */
export function validate() {
  const problems = [];
  const fail = (m) => problems.push(m);
  let m;
  try {
    m = readManifest();
  } catch (e) {
    return [`manifest.json can't be read: ${e.message}`];
  }
  if (m.manifest_version !== 3) fail('manifest_version must be 3');
  if (!SEMVER.test(m.version || '')) fail(`version "${m.version}" must look like 1.2.3`);
  if (!m.name) fail('name is missing');
  if (!m.description || m.description.length > 132) fail('description is missing or longer than 132 characters');

  const exists = (rel, what) => {
    if (!rel || !fs.existsSync(path.join(EXT_DIR, rel))) fail(`${what} points to a missing file: ${rel}`);
  };
  exists(m.background?.service_worker, 'background.service_worker');
  for (const cs of m.content_scripts || []) for (const js of cs.js || []) exists(js, 'content_scripts.js');
  for (const [key, icons] of [['icons', m.icons], ['action.default_icon', m.action?.default_icon]]) {
    for (const [size, rel] of Object.entries(icons || {})) {
      exists(rel, key);
      const file = path.join(EXT_DIR, rel);
      if (fs.existsSync(file)) {
        const { width, height } = pngSize(file);
        if (width !== +size || height !== +size) fail(`${rel} is ${width}x${height}, expected ${size}x${size}`);
      }
    }
  }
  for (const p of m.permissions || []) if (!ALLOWED_PERMISSIONS.includes(p)) fail(`unexpected permission: ${p}`);
  for (const h of m.host_permissions || []) if (!ALLOWED_HOSTS.includes(h)) fail(`unexpected host permission: ${h}`);

  const files = listExtensionFiles();
  for (const rel of files) {
    const file = path.join(EXT_DIR, rel);
    if (rel.endsWith('.js')) {
      try {
        new vm.Script(fs.readFileSync(file, 'utf8'), { filename: rel });
      } catch (e) {
        fail(`${rel} has a syntax error: ${e.message}`);
      }
    }
    if (rel.endsWith('.json')) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        fail(`${rel} is not valid JSON: ${e.message}`);
      }
    }
    if (rel.endsWith('.html')) {
      const html = fs.readFileSync(file, 'utf8');
      // Manifest V3 forbids remote code and inline scripts in extension pages.
      if (/<script[^>]+src=["']https?:/i.test(html)) fail(`${rel} loads a remote script`);
      if (/<script(?![^>]*\ssrc=)[^>]*>\s*\S/i.test(html)) fail(`${rel} has an inline <script>`);
      for (const [, ref] of html.matchAll(/(?:src|href)=["']([^"'#:]+)["']/g)) exists(ref, rel);
    }
  }
  return problems;
}

export function check() {
  const problems = validate();
  if (problems.length) {
    console.error('✗ Extension check failed:\n' + problems.map((p) => '  - ' + p).join('\n'));
    process.exitCode = 1;
    return false;
  }
  log(`✓ Extension check passed (v${readManifest().version}, ${listExtensionFiles().length} files)`);
  return true;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildZip() {
  const entries = listExtensionFiles().map((rel) => ({
    name: rel,
    data: fs.readFileSync(path.join(EXT_DIR, rel)),
  }));
  return createZip(entries);
}

export function build({ dryRun = false } = {}) {
  if (!check()) throw new Error('fix the problems above first');
  const { version } = readManifest();
  const zip = buildZip();
  const sha256 = createHash('sha256').update(zip).digest('hex');
  if (!dryRun) {
    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(path.join(DIST, ZIP_NAME), zip);
    fs.writeFileSync(path.join(DIST, `VHL-Text-Overlay-v${version}.zip`), zip);
    fs.writeFileSync(path.join(DIST, `${ZIP_NAME}.sha256`), `${sha256}  ${ZIP_NAME}\n`);
  }
  log(`✓ Built dist/${ZIP_NAME} (v${version}, ${(zip.length / 1024).toFixed(1)} KB)${dryRun ? ' [dry run, not written]' : ''}`);
  log(`  sha256 ${sha256}`);
  return { version, sha256, size: zip.length };
}

// ---------------------------------------------------------------------------
// Release notes generator
// ---------------------------------------------------------------------------

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const gitOk = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).status === 0;

/** The tag to compare against: the latest v* tag that isn't on HEAD. */
export function previousTag() {
  let tags;
  try {
    tags = git('tag', '--list', 'v*', '--sort=-v:refname', '--merged', 'HEAD').split('\n').filter(Boolean);
  } catch {
    return null;
  }
  const headTags = gitOk('rev-parse', 'HEAD') ? git('tag', '--points-at', 'HEAD').split('\n') : [];
  return tags.find((t) => !headTags.includes(t)) || null;
}

const SECTIONS = [
  ['✨ New', /^(add|new|let|support|create|introduce|allow|show)\b/i],
  ['🐛 Fixes', /\bfix(es|ed)?\b|\bbug\b|^repair|^correct/i],
  ['🎨 Look and feel', /\b(style|design|colou?r|icon|spacing|look|glass|motion|animation|theme)\b/i],
  ['📝 Docs', /\b(readme|docs?|screenshots?|instructions)\b/i],
  ['🔧 Maintenance', /\b(test|tests|ci|release|workflow|build|script|refactor|chore|bump)\b/i],
];

export function categorize(subject) {
  for (const [title, re] of SECTIONS) if (re.test(subject)) return title;
  return '💅 Improvements';
}

/** Commits since `from` (or the previous tag), as { subject, hash }. */
export function commitsSince(from = previousTag()) {
  const range = from ? `${from}..HEAD` : 'HEAD';
  let out = '';
  try {
    out = git('log', range, '--no-merges', '--pretty=format:%s%x1f%h');
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [subject, hash] = l.split('\x1f');
      return { subject, hash };
    })
    .filter((c) => !/^release v?\d/i.test(c.subject) && !/^initial commit$/i.test(c.subject));
}

export function changesMarkdown(commits, { links = true } = {}) {
  const groups = new Map();
  for (const c of commits) {
    const k = categorize(c.subject);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const order = [...SECTIONS.map(([t]) => t), '💅 Improvements'];
  return order
    .filter((t) => groups.has(t))
    .map(
      (t) =>
        `### ${t}\n\n` +
        groups
          .get(t)
          .map((c) => `- ${c.subject}${links ? ` ([${c.hash}](${REPO_URL}/commit/${c.hash}))` : ''}`)
          .join('\n')
    )
    .join('\n\n');
}

export function releaseNotes({ from, sha256 } = {}) {
  const { version } = readManifest();
  const prev = from ?? previousTag();
  const commits = commitsSince(prev);
  const changes = commits.length ? changesMarkdown(commits) : '_No changes recorded._';
  return `# VHL Text Overlay ${version}

## Install / Instalar

1. Download **${ZIP_NAME}** below and unzip it. / Descargue **${ZIP_NAME}** (abajo) y descomprímalo.
2. Follow the [step-by-step instructions](${REPO_URL}#readme). / Siga las [instrucciones paso a paso](${REPO_URL}#español).

Already installed? Replace your old **${UNZIPPED_FOLDER}** folder with the new one, then click ↻ on the
extension at \`chrome://extensions\`.

## What's changed${prev ? ` since ${prev}` : ''}

${changes}
${sha256 ? `\n---\n\nSHA-256 of \`${ZIP_NAME}\`: \`${sha256}\`\n` : ''}`;
}

export function notes({ from, dryRun = false } = {}) {
  const shaFile = path.join(DIST, `${ZIP_NAME}.sha256`);
  const sha256 = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, 'utf8').split(/\s/)[0] : undefined;
  const md = releaseNotes({ from, sha256 });
  if (!dryRun) {
    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(path.join(DIST, 'RELEASE_NOTES.md'), md);
  }
  log(dryRun ? md : '✓ Wrote dist/RELEASE_NOTES.md');
  return md;
}

// ---------------------------------------------------------------------------
// Version bump + changelog
// ---------------------------------------------------------------------------

export function nextVersion(current, kind) {
  if (SEMVER.test(kind)) return kind;
  const [, a, b, c] = current.match(SEMVER).map(Number);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  if (kind === 'patch') return `${a}.${b}.${c + 1}`;
  throw new Error(`unknown version bump "${kind}" (use patch, minor, major or x.y.z)`);
}

function setJsonVersion(file, version) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
}

export function bump(kind, { dryRun = false } = {}) {
  if (!kind) throw new Error('say how to bump: patch, minor, major or x.y.z');
  const current = readManifest().version;
  const version = nextVersion(current, kind);
  const cmp = (v) => v.split('.').map(Number);
  const [x, y] = [cmp(version), cmp(current)];
  if (!(x[0] > y[0] || (x[0] === y[0] && (x[1] > y[1] || (x[1] === y[1] && x[2] > y[2]))))) {
    throw new Error(`new version ${version} must be higher than ${current}`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const entry = `## ${version} (${date})\n\n${changesMarkdown(commitsSince(), { links: false }) || '_No changes recorded._'}\n`;
  if (!dryRun) {
    setJsonVersion(path.join(EXT_DIR, 'manifest.json'), version);
    setJsonVersion(path.join(ROOT, 'package.json'), version);
    const clFile = path.join(ROOT, 'CHANGELOG.md');
    const head = '# Changelog\n\n';
    const old = fs.existsSync(clFile) ? fs.readFileSync(clFile, 'utf8').replace(head, '') : '';
    fs.writeFileSync(clFile, head + entry + (old ? '\n' + old : ''));
  }
  log(`✓ Version ${current} → ${version}${dryRun ? ' [dry run]' : ''}`);
  if (dryRun) log('\n' + entry);
  return version;
}

// ---------------------------------------------------------------------------
// Prepare a full release
// ---------------------------------------------------------------------------

export function runTests() {
  log('• Running tests…');
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/**/*.test.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('tests failed; not releasing');
}

export function prepare(kind, { dryRun = false, skipTests = false, noGit = false } = {}) {
  if (!noGit && !dryRun && git('status', '--porcelain')) {
    throw new Error('you have uncommitted changes; commit or stash them first');
  }
  if (!skipTests) runTests();
  const version = bump(kind, { dryRun });
  if (dryRun) {
    log('[dry run] would build, write notes, commit and tag v' + version);
    return version;
  }
  build();
  notes();
  if (!noGit) {
    git('add', 'extension/manifest.json', 'CHANGELOG.md', ...(fs.existsSync(path.join(ROOT, 'package.json')) ? ['package.json'] : []));
    git('commit', '-m', `Release v${version}`);
    git('tag', '-a', `v${version}`, '-m', `VHL Text Overlay ${version}`);
    log(`✓ Committed and tagged v${version}`);
    log(`\nNext: git push && git push origin v${version}`);
    log('Pushing the tag runs the "Publish release" workflow, which uploads the zip and notes to GitHub Releases.');
  }
  return version;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  const opt = { dryRun: flags.has('--dry-run'), skipTests: flags.has('--skip-tests'), noGit: flags.has('--no-git') };
  const fromIdx = rest.indexOf('--from');
  const from = fromIdx >= 0 ? rest[fromIdx + 1] : undefined;
  switch (cmd) {
    case 'check':
      return check();
    case 'build':
      return build(opt);
    case 'notes':
      return notes({ ...opt, from });
    case 'bump':
      return bump(args[0], opt);
    case 'prepare':
      return prepare(args[0], opt);
    default:
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      if (cmd && cmd !== 'help') process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exitCode = 1;
  }
}
