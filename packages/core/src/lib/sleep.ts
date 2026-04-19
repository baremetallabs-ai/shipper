import { setTimeout } from 'node:timers/promises';

export async function sleepMs(ms: number): Promise<void> {
  await sleepMsImpl(ms);
}

async function sleepMsDefault(ms: number): Promise<void> {
  await setTimeout(ms);
}

let sleepMsImpl: typeof sleepMsDefault = sleepMsDefault;

export function __setSleepMsImpl(next?: typeof sleepMsDefault): typeof sleepMsDefault {
  const previous = sleepMsImpl;
  sleepMsImpl = next ?? sleepMsDefault;
  return previous;
}
