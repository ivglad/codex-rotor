const LIMIT_PATTERNS = [
  /\b429\b/i,
  /rate\s*limit/i,
  /usage\s*limit/i,
  /limit\s*(reached|exceeded|exhausted)/i,
  /quota\s*(reached|exceeded|exhausted)/i,
  /token\s*budget\s*exceeded/i
];

const AUTH_PATTERNS = [
  /not\s+logged\s+in/i,
  /please\s+sign\s+in\s+again/i,
  /refresh\s*token\s*(expired|reused|revoked|invalidated)/i,
  /invalid_grant/i,
  /login\s+is\s+required/i,
  /authentication\s+failed/i
];

function combineOutput(stderrTail, stdoutTail, outputTail) {
  if (outputTail) return String(outputTail);
  const stderr = String(stderrTail || '');
  const stdout = String(stdoutTail || '');
  if (stderr && stdout) return `${stdout}\n${stderr}`;
  return stderr || stdout;
}

export function classifyFailure({ exitCode, signal, stderrTail = '', stdoutTail = '', outputTail = '', elapsedSeconds = 0 }) {
  const hay = combineOutput(stderrTail, stdoutTail, outputTail);
  if (LIMIT_PATTERNS.some((re) => re.test(hay))) {
    return 'limit_exhausted';
  }
  if (AUTH_PATTERNS.some((re) => re.test(hay))) {
    return 'auth_invalid';
  }
  if (signal || exitCode === 130) {
    return 'interrupt';
  }
  if (exitCode === 0) {
    return 'ok';
  }
  if (elapsedSeconds < 3) {
    return 'startup_failure';
  }
  return 'unknown_failure';
}
