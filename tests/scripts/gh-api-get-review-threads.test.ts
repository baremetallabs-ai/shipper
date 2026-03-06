import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = path.resolve('src/scripts/gh-api-get-review-threads.sh');

let tempDir: string;
let mockBinDir: string;
let mockGh: string;
let argsFile: string;

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'gh-api-get-review-threads-'));
  mockBinDir = path.join(tempDir, 'mock-bin');
  mockGh = path.join(mockBinDir, 'gh');
  argsFile = path.join(tempDir, 'gh-args.json');

  mkdirSync(mockBinDir, { recursive: true });
  writeFileSync(
    mockGh,
    `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
writeFileSync(process.env.MOCK_GH_ARGS_FILE, JSON.stringify(args, null, 2));

if (args[0] !== 'api' || args[1] !== 'graphql') {
  console.error('expected gh api graphql');
  process.exit(1);
}

function getFlagValues(flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      values.push(args[i + 1]);
    }
  }
  return values;
}

const formValues = getFlagValues('-f');
const intValues = getFlagValues('-F');
const jqValues = getFlagValues('--jq');
const owner = formValues.find((value) => value.startsWith('owner='));
const repo = formValues.find((value) => value.startsWith('repo='));
const query = formValues.find((value) => value.startsWith('query='));
const number = intValues.find((value) => value.startsWith('number='));

if (!owner || !repo || !query || !number || jqValues.length !== 1) {
  console.error('missing expected graphql arguments');
  process.exit(1);
}

const response = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              path: 'src/example.ts',
              line: 42,
              isResolved: false,
              isOutdated: true,
              comments: {
                nodes: [
                  {
                    author: { login: 'reviewer-one' },
                    body: 'Please rename this.',
                    createdAt: '2026-03-06T12:00:00Z',
                  },
                  {
                    author: { login: 'author-two' },
                    body: 'Done.',
                    createdAt: '2026-03-06T13:00:00Z',
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
});

const output = execFileSync('jq', [jqValues[0]], { input: response, encoding: 'utf8' });
process.stdout.write(output);
`
  );
  chmodSync(mockGh, 0o755);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function runScript(...args: string[]) {
  return execFileSync('bash', [script, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${mockBinDir}:${process.env.PATH}`,
      MOCK_GH_ARGS_FILE: argsFile,
    },
  });
}

describe('gh-api-get-review-threads.sh', () => {
  it('invokes gh api graphql and returns flattened review thread JSON', () => {
    const stdout = runScript('octo/repo', '123');
    const ghArgs = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    const output = JSON.parse(stdout) as Array<{
      path: string;
      line: number;
      isResolved: boolean;
      isOutdated: boolean;
      comments: Array<{ author: string; body: string; createdAt: string }>;
    }>;

    expect(ghArgs.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(ghArgs).toContain('-f');
    expect(ghArgs).toContain('owner=octo');
    expect(ghArgs).toContain('repo=repo');
    expect(ghArgs).toContain('-F');
    expect(ghArgs).toContain('number=123');

    const queryArg = ghArgs.find((arg) => arg.startsWith('query='));
    expect(queryArg).toContain('reviewThreads(first: 100)');
    expect(queryArg).toContain('comments(first: 100)');
    expect(queryArg).toContain('isResolved');
    expect(queryArg).toContain('isOutdated');

    expect(output).toEqual([
      {
        path: 'src/example.ts',
        line: 42,
        isResolved: false,
        isOutdated: true,
        comments: [
          {
            author: 'reviewer-one',
            body: 'Please rename this.',
            createdAt: '2026-03-06T12:00:00Z',
          },
          {
            author: 'author-two',
            body: 'Done.',
            createdAt: '2026-03-06T13:00:00Z',
          },
        ],
      },
    ]);
  });
});
