#!/usr/bin/env node
import { runCodexWrapper } from '../src/cli/codex-wrapper.js';

try {
  const code = await runCodexWrapper(process.argv.slice(2));
  process.exit(code);
} catch (err) {
  console.error(`codex-rotor: ${err?.message || String(err)}`);
  process.exit(1);
}
