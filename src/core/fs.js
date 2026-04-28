import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

export async function readJson(filePath, fallback) {
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return structuredClone(fallback);
    }
    if (err && err.name === 'SyntaxError') {
      const parseErr = new Error(`Invalid JSON in ${filePath}: ${err.message}`);
      parseErr.code = 'EJSONPARSE';
      throw parseErr;
    }
    throw err;
  }
}

export async function writeJsonAtomic(filePath, data) {
  await ensureParent(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    return false;
  }
}

async function readLockOwnerPid(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function acquireFileLock(lockPath, options = {}) {
  const retryMs = Number(options.retryMs ?? 50);
  const timeoutMs = Number(options.timeoutMs ?? 10_000);
  const staleMs = Number(options.staleMs ?? 0);
  const unknownOwnerStaleMs = Number(options.unknownOwnerStaleMs ?? 5 * 60_000);
  const deadline = Date.now() + timeoutMs;

  await ensureParent(lockPath);

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString()
        })}\n`);
      } catch (writeErr) {
        try {
          await handle.close();
        } catch {
          // ignore cleanup close failure
        }
        try {
          await fs.rm(lockPath, { force: true });
        } catch {
          // ignore cleanup unlink failure
        }
        throw writeErr;
      }
      return handle;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw err;
      }

      const ownerPid = await readLockOwnerPid(lockPath);
      if (ownerPid && !isProcessAlive(ownerPid)) {
        try {
          await fs.rm(lockPath, { force: true });
          continue;
        } catch {
          // lock may have changed, continue retry loop
        }
      }

      if (!ownerPid && unknownOwnerStaleMs > 0) {
        try {
          const st = await fs.stat(lockPath);
          if ((Date.now() - st.mtimeMs) > unknownOwnerStaleMs) {
            await fs.rm(lockPath, { force: true });
            continue;
          }
        } catch {
          // lock may have changed, continue retry loop
        }
      }

      if (staleMs > 0) {
        try {
          const st = await fs.stat(lockPath);
          if ((Date.now() - st.mtimeMs) > staleMs) {
            await fs.rm(lockPath, { force: true });
            continue;
          }
        } catch {
          // Best-effort stale lock cleanup only.
        }
      }

      if (Date.now() >= deadline) {
        const timeoutErr = new Error(`Timed out waiting for lock: ${lockPath}. Remove stale lock only if no codex-rotor process is running.`);
        timeoutErr.code = 'ELOCKTIMEOUT';
        throw timeoutErr;
      }
      await sleep(retryMs);
    }
  }
}

export async function withFileLock(lockPath, fn, options = {}) {
  const handle = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {
      // ignore lock fd close errors
    }
    try {
      await fs.rm(lockPath, { force: true });
    } catch {
      // ignore lock file cleanup errors
    }
  }
}
