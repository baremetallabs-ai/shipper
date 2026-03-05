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

export function promptChoice(message: string, valid: string[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const ask = () => {
      rl.question(message, (answer) => {
        const trimmed = answer.trim();
        if (valid.includes(trimmed)) {
          rl.close();
          resolve(trimmed);
        } else {
          ask();
        }
      });
    };
    ask();
  });
}
