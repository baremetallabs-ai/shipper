import { execFileSync } from 'node:child_process';

export function getRepoNwo(): string {
  try {
    return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      'Error: Could not determine repository. Run this command from inside a GitHub repository.'
    );
    console.error(`Underlying error: ${msg}`);
    process.exit(1);
  }
}
