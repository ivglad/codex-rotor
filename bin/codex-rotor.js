#!/usr/bin/env node
import { runAdminCli } from '../src/cli/admin.js';

try {
  const code = await runAdminCli(process.argv.slice(2));
  process.exit(code);
} catch (err) {
  console.error(`codex-rotor: ${err?.message || String(err)}`);
  process.exit(1);
}
