import { runPrompt } from '../lib/prompt-runner.js';
import { getSettings } from '../lib/settings.js';

export function newCommand(
  pitchWords: string[],
  options: { headless: boolean } = { headless: false }
) {
  const pitch = pitchWords.join(' ').trim();
  if (!pitch) {
    console.error('Error: Please provide a pitch for the new issue.');
    console.error('Usage: shipper new <pitch>');
    process.exit(1);
  }

  const headless = options.headless || getSettings().headless?.new === true;
  const previousHeadless = process.env.SHIPPER_HEADLESS;

  if (headless) {
    process.env.SHIPPER_HEADLESS = 'true';
  }

  let exitCode: number;
  try {
    exitCode = runPrompt('new', { userInput: pitch });
  } finally {
    if (headless) {
      if (previousHeadless === undefined) {
        delete process.env.SHIPPER_HEADLESS;
      } else {
        process.env.SHIPPER_HEADLESS = previousHeadless;
      }
    }
  }

  process.exit(exitCode);
}
