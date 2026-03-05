import { runPrompt } from '../lib/prompt-runner.js';

export function setupCommand() {
  const code = runPrompt('setup', {});
  process.exit(code);
}
