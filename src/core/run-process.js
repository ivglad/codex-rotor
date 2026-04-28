import { spawn } from 'node:child_process';

function trimTail(text, max = 12000) {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

export async function runWithStderrTail(cmd, args, env = process.env) {
  const start = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env,
      stdio: ['inherit', 'inherit', 'pipe']
    });

    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      const s = String(chunk);
      process.stderr.write(chunk);
      stderrTail = trimTail(stderrTail + s);
    });

    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        signal: null,
        stderrTail: trimTail(`${stderrTail}\n${error.message}`),
        elapsedSeconds: (Date.now() - start) / 1000
      });
    });

    child.on('exit', (code, signal) => {
      resolve({
        exitCode: code ?? 1,
        signal,
        stderrTail,
        elapsedSeconds: (Date.now() - start) / 1000
      });
    });
  });
}
