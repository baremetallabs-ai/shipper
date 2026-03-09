import { gh } from './gh.js';

export async function getRepoNwo(): Promise<string> {
  try {
    const { stdout } = await gh([
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '-q',
      '.nameWithOwner',
    ]);
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      'Could not determine repository. Run this command from inside a GitHub repository.\n' +
        `Underlying error: ${msg}`
    );
  }
}
