import fs from 'node:fs';
import path from 'node:path';
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

function resolvePackageLocalCodex() {
  const local = fileURLToPath(new URL('../../node_modules/@openai/codex/bin/codex.js', import.meta.url));
  if (isExecutable(local) || fs.existsSync(local)) {
    return local;
  }
  return null;
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

export function findRealCodex(wrapperArgv0 = process.argv[1]) {
  const wrapperBinRealPath = resolveWrapperCodexBin();

  if (process.env.CODEX_REAL_BIN) {
    const fromEnv = process.env.CODEX_REAL_BIN;
    if (safeRealpath(fromEnv) === wrapperBinRealPath) {
      throw new Error('CODEX_REAL_BIN points to codex-rotor wrapper. Set it to upstream codex binary.');
    }
    return process.env.CODEX_REAL_BIN;
  }

  // Prefer package-local upstream Codex binary first.
  // This prevents recursion when PATH points `codex` to this wrapper shim.
  const packageLocal = resolvePackageLocalCodex();
  if (packageLocal) {
    return packageLocal;
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

  throw new Error('Unable to resolve real codex binary. Set CODEX_REAL_BIN explicitly.');
}
