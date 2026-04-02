import { describe, expect, it } from 'vitest';
import { formatConflictContext } from '../../src/lib/worktree.js';

describe('formatConflictContext', () => {
  it('renders the file list, grouped markers, and prior continue error', () => {
    const formatted = formatConflictContext({
      files: ['src/conflict.ts', 'README.md'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
        },
        {
          path: 'README.md',
          markers: ['<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> origin/main'],
        },
      ],
      continueError: 'No changes - did you forget to stage the resolved files?',
    });

    expect(formatted).toBe(
      [
        '## Merge Conflict Resolution Required',
        '',
        'The following files still have merge conflicts that must be resolved before the rebase can continue:',
        '',
        '- src/conflict.ts',
        '- README.md',
        '',
        'A previous `git rebase --continue` attempt failed with:',
        '',
        '```text',
        'No changes - did you forget to stage the resolved files?',
        '```',
        '',
        '### src/conflict.ts',
        '',
        '```diff',
        '<<<<<<< HEAD',
        'ours',
        '=======',
        'theirs',
        '>>>>>>> origin/main',
        '```',
        '',
        '### README.md',
        '',
        '```diff',
        '<<<<<<< HEAD',
        'left',
        '=======',
        'right',
        '>>>>>>> origin/main',
        '```',
        '',
        'Resolve all conflicts, then stage the resolved files with `git add`. Do not run `git commit`, `git rebase --continue`, `git rebase --abort`, or `git push` yourself.',
      ].join('\n')
    );
  });

  it('explains conflicts that do not have inline markers', () => {
    const formatted = formatConflictContext({
      files: ['assets/logo.png'],
      conflicts: [
        {
          path: 'assets/logo.png',
          markers: [],
        },
      ],
    });

    expect(formatted).toContain(
      'No inline conflict markers were found for this path. It may be a binary or delete/modify conflict. Resolve the file state directly, then stage it with `git add`.'
    );
  });
});
