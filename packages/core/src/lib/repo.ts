import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function getRepoNwo(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      {
        encoding: 'utf-8',
      }
    );
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      'Error: Could not determine repository. Run this command from inside a GitHub repository.'
    );
    console.error(`Underlying error: ${msg}`);
    process.exit(1);
  }
}
