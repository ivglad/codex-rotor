import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function splitPath() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean);
}

function resolveWrapperCodexBin() {
  const wrapper = fileURLToPath(new URL('../../bin/codex.js', import.meta.url));
  try {
    return fs.realpathSync(wrapper);
  } catch {
    return wrapper;
  }
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function pointsToWrapper(candidate, wrapperBinRealPath) {
  try {
    const body = fs.readFileSync(candidate, 'utf8');
    return body.includes(wrapperBinRealPath);
  } catch {
    return false;
  }
}

function hasFile(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function prefixFromNodeModulesPath(maybePath) {
  const normalized = safeRealpath(maybePath);
  if (!normalized) return null;
  const libNodeModules = `${path.sep}lib${path.sep}node_modules${path.sep}`;
  const plainNodeModules = `${path.sep}node_modules${path.sep}`;

  const libIdx = normalized.lastIndexOf(libNodeModules);
  if (libIdx > 0) {
    return normalized.slice(0, libIdx);
  }
  const plainIdx = normalized.lastIndexOf(plainNodeModules);
  if (plainIdx > 0) {
    return normalized.slice(0, plainIdx);
  }
  return null;
}

function prefixesFromPathLocation(maybePath) {
  if (!maybePath) return [];
  const candidates = [];
  const normalized = safeRealpath(maybePath);
  const raw = path.resolve(maybePath);

  for (const value of [normalized, raw]) {
    if (!value) continue;

    const maybeFromNodeModules = prefixFromNodeModulesPath(value);
    if (maybeFromNodeModules) {
      candidates.push(maybeFromNodeModules);
    }

    const dir = path.dirname(value);
    if (path.basename(dir) === 'bin') {
      candidates.push(path.dirname(dir));
    }
  }

  return candidates;
}

function unique(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item) continue;
    const key = path.resolve(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function codexCandidatesFromPrefix(prefix) {
  return [
    path.join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  ];
}

function discoverPrefixCandidates(wrapperArgv0, wrapperBinRealPath) {
  const prefixes = [];

  if (process.env.npm_config_prefix) {
    prefixes.push(process.env.npm_config_prefix);
  }

  prefixes.push(...prefixesFromPathLocation(wrapperArgv0));
  prefixes.push(...prefixesFromPathLocation(wrapperBinRealPath));

  for (const dir of splitPath()) {
    if (path.basename(dir) !== 'bin') continue;
    prefixes.push(path.dirname(dir));
  }

  for (const globalPath of Module.globalPaths || []) {
    const maybePrefix = prefixFromNodeModulesPath(globalPath);
    if (maybePrefix) {
      prefixes.push(maybePrefix);
    }
  }

  return unique(prefixes);
}

export function findRealCodex(wrapperArgv0 = process.argv[1]) {
  const wrapperBinRealPath = resolveWrapperCodexBin();

  if (process.env.CODEX_REAL_BIN) {
    const fromEnv = process.env.CODEX_REAL_BIN;
    if (safeRealpath(fromEnv) === wrapperBinRealPath) {
      throw new Error('CODEX_REAL_BIN points to codex-rotor wrapper. Set it to upstream codex binary.');
    }
    return process.env.CODEX_REAL_BIN;
  }

  const prefixCandidates = discoverPrefixCandidates(wrapperArgv0, wrapperBinRealPath);
  for (const prefix of prefixCandidates) {
    for (const candidate of codexCandidatesFromPrefix(prefix)) {
      if (!hasFile(candidate)) continue;
      const real = safeRealpath(candidate);
      if (real === wrapperBinRealPath) continue;
      return candidate;
    }
  }

  const self = fs.realpathSync(wrapperArgv0);
  const currentBinDir = path.dirname(self);

  for (const dir of splitPath()) {
    const candidate = path.join(dir, 'codex');
    if (!isExecutable(candidate)) continue;
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (real === self) continue;
    // avoid grabbing neighbor script in same bin dir during recursion.
    if (dir === currentBinDir) continue;
    if (real === wrapperBinRealPath) continue;
    if (pointsToWrapper(candidate, wrapperBinRealPath)) continue;
    return candidate;
  }

  throw new Error('Unable to resolve upstream codex binary. Install @openai/codex globally (same Node prefix) or set CODEX_REAL_BIN.');
}
