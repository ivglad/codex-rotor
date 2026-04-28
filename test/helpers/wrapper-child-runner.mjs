import { runCodexWrapper } from '../../src/cli/codex-wrapper.js';

const argv = process.argv.slice(2);
const code = await runCodexWrapper(argv);
process.exitCode = code;
