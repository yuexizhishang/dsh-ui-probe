#!/usr/bin/env node
// Repository self-check: the invariants that make this package installable and
// the ones that are easy to break by accident. No dependencies, no network.
//
//   node scripts/check.mjs
//
// Exit code 0 means every check passed.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function ok(message) {
  passed += 1;
  console.log('ok    ' + message);
}
function fail(message) {
  failed += 1;
  console.log('error ' + message);
}
function check(condition, message) {
  if (condition) ok(message);
  else fail(message);
}
function read(relative) {
  return readFileSync(join(root, relative), 'utf8');
}

// ---- manifest ------------------------------------------------------------
let pkg = null;
try {
  pkg = JSON.parse(read('package.json'));
  ok('package.json is valid JSON');
} catch (error) {
  fail('package.json is not valid JSON: ' + error.message);
}
if (!pkg) {
  console.log('\n0 checks run: package.json unreadable');
  process.exit(1);
}
check(pkg.type === 'module', 'package.json declares "type": "module"');
check(typeof pkg.name === 'string' && pkg.name.length > 0, 'package name is present');
check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(pkg.version)), 'version looks like semver: ' + pkg.version);
check(pkg.publishConfig && pkg.publishConfig.access === 'public', 'publishConfig.access is public');

const patchPath = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
check(typeof patchPath === 'string' && patchPath.length > 0, 'dsh.bundle.patch is declared');
if (typeof patchPath === 'string' && patchPath.length > 0) {
  check(existsSync(join(root, patchPath)), 'patch file exists: ' + patchPath);
  if (existsSync(join(root, patchPath))) {
    const yaml = read(patchPath);
    const names = [
      "name: '" + pkg.name + "'",
      'name: "' + pkg.name + '"',
      'name: ' + pkg.name,
    ];
    check(names.some((needle) => yaml.includes(needle)), 'patch inserts a row named exactly "' + pkg.name + '"');
  }
}

// ---- host half -----------------------------------------------------------
if (existsSync(join(root, 'index.js'))) {
  const host = read('index.js');
  const hasApply = /export\s+function\s+apply\s*\(/.test(host);
  const hasDefault = /export\s+default\s+/.test(host);
  check(hasApply !== hasDefault, 'index.js exports exactly one of apply() / default');
  check(hasDefault || hasApply, 'index.js has a loadable entry export');
} else {
  fail('index.js is missing');
}

// ---- client half ---------------------------------------------------------
if (existsSync(join(root, 'client.js'))) {
  const client = read('client.js');
  check(client.includes('__ModuleLoader__.load'), 'client.js uses __ModuleLoader__.load');
  check(client.includes("id: '" + pkg.name + "'"), 'client.js factory id equals the package name');
} else {
  fail('client.js is missing');
}

// ---- icon ----------------------------------------------------------------
if (typeof pkg.icon === 'string' && pkg.icon.length > 0) {
  const iconFile = join(root, pkg.icon);
  if (!existsSync(iconFile)) {
    fail('icon file is missing: ' + pkg.icon);
  } else {
    const size = statSync(iconFile).size;
    check(size <= 256 * 1024, 'icon is at most 256 KiB (' + size + ' bytes)');
    check(/\.(svg|png|jpe?g|webp)$/i.test(pkg.icon), 'icon type is SVG/PNG/JPEG/WebP');
  }
} else {
  fail('package.json does not declare an icon');
}

// ---- locale --------------------------------------------------------------
if (existsSync(join(root, 'locale'))) {
  const names = readdirSync(join(root, 'locale')).filter((name) => name.endsWith('.json'));
  check(names.length > 0, 'locale/ has at least one dictionary');
  for (const name of names) {
    try {
      const dict = JSON.parse(readFileSync(join(root, 'locale', name), 'utf8'));
      check(Boolean(dict.meta && dict.meta.title), 'locale/' + name + ' has meta.title');
    } catch (error) {
      fail('locale/' + name + ' is not valid JSON: ' + error.message);
    }
  }
} else {
  fail('locale/ directory is missing');
}

// ---- published files -----------------------------------------------------
const files = Array.isArray(pkg.files) ? pkg.files : [];
check(files.length > 0, 'package.json declares the published file list');
const normalize = (entry) => String(entry).replace(/^\.\//, '');
const published = files.map(normalize);
const requiredFiles = [
  pkg.dsh && pkg.dsh.bundle ? pkg.dsh.bundle.patch : null,
  'index.js',
  'client.js',
  pkg.icon,
  'CHANGELOG.md',
].filter(Boolean).map(normalize);
for (const required of requiredFiles) {
  check(published.includes(required), 'files includes ' + required);
}
for (const entry of files) {
  if (entry.includes('*')) continue; // npm expands globs itself
  check(existsSync(join(root, entry)), 'files entry exists: ' + entry);
}

// ---- summary -------------------------------------------------------------
console.log('');
if (failed === 0) {
  console.log(pkg.name + ': ' + passed + ' checks, 0 error(s)');
} else {
  console.log(pkg.name + ': ' + passed + ' passed, ' + failed + ' error(s)');
}
process.exit(failed === 0 ? 0 : 1);
