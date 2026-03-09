import { setTimeout } from 'node:timers/promises';

export async function sleepMs(ms: number): Promise<void> {
  await setTimeout(ms);
}
