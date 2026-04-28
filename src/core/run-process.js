import { spawn } from 'node:child_process';

function trimTail(text, max = 12000) {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

export async function runWithStderrTail(cmd, args, env = process.env) {
  const start = Date.now();
  const captureStdout = !process.stdout.isTTY;
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env,
      stdio: ['inherit', captureStdout ? 'pipe' : 'inherit', 'pipe']
    });

    let stdoutTail = '';
    let stderrTail = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const s = String(chunk);
        process.stdout.write(chunk);
        stdoutTail = trimTail(stdoutTail + s);
      });
    }

    child.stderr.on('data', (chunk) => {
      const s = String(chunk);
      process.stderr.write(chunk);
      stderrTail = trimTail(stderrTail + s);
    });

    child.on('error', (error) => {
      const stderrWithError = trimTail(`${stderrTail}\n${error.message}`);
      resolve({
        exitCode: 1,
        signal: null,
        stdoutTail,
        stderrTail: stderrWithError,
        outputTail: trimTail(`${stdoutTail}\n${stderrWithError}`),
        elapsedSeconds: (Date.now() - start) / 1000
      });
    });

    child.on('exit', (code, signal) => {
      const outputTail = trimTail(`${stdoutTail}\n${stderrTail}`);
      resolve({
        exitCode: code ?? 1,
        signal,
        stdoutTail,
        stderrTail,
        outputTail,
        elapsedSeconds: (Date.now() - start) / 1000
      });
    });
  });
}
