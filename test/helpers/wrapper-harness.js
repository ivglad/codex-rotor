import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

export function spawnWrapperProcess({ runnerPath, argv = [], env = {}, cwd = process.cwd() }) {
  const child = spawn(process.execPath, [runnerPath, ...argv], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });

  return { child, done };
}

export async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

export async function readJsonl(path) {
  let txt = '';
  try {
    txt = await fs.readFile(path, 'utf8');
  } catch {
    return [];
  }
  return txt
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
