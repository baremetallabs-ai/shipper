import { createInterface } from 'node:readline';

export function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed === 'y' || trimmed === 'Y');
    });
  });
}
