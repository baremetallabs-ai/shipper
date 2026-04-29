import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const ghMock = vi.hoisted(() =>
  vi.fn<
    (args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>
  >()
);

vi.mock('../../src/lib/gh.js', () => ({
  gh: (args: string[], options?: { cwd?: string }) => ghMock(args, options),
}));

const { GhPayloadError, ghJson, parseGhJson } = await import('../../src/lib/gh-json.js');
const { IssueSchema, parseIssue } = await import('../../src/lib/gh-schemas.js');

function readFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/gh/${name}`, import.meta.url), 'utf-8');
}

describe('parseGhJson', () => {
  it('formats field paths consistently for schema validation failures', () => {
    expect(() =>
      parseGhJson(
        JSON.stringify({
          number: 638,
          title: 'Consolidate gh CLI JSON parsing into a single validation layer',
          state: 'OPEN',
          labels: [{}],
          body: '',
          comments: [],
          author: { login: 'dnsquared' },
          createdAt: '2026-04-17T17:53:47Z',
        }),
        IssueSchema,
        'Issue'
      )
    ).toThrow('gh returned an invalid Issue payload: expected string at labels[0].name');
  });

  it('formats enum value validation failures with the allowed values', () => {
    const schema = z.object({ status: z.enum(['new', 'planned']) });

    expect(() => parseGhJson(JSON.stringify({ status: 'ready' }), schema, 'Status')).toThrow(
      'gh returned an invalid Status payload: expected one of "new", "planned" at status'
    );
  });

  it('formats literal value validation failures with the expected value', () => {
    const schema = z.object({ state: z.literal('OPEN') });

    expect(() => parseGhJson(JSON.stringify({ state: 'CLOSED' }), schema, 'State')).toThrow(
      'gh returned an invalid State payload: expected "OPEN" at state'
    );
  });

  it('wraps invalid JSON in GhPayloadError', () => {
    expect(() => parseGhJson('not json', IssueSchema, 'Issue')).toThrow(GhPayloadError);
    expect(() => parseGhJson('not json', IssueSchema, 'Issue')).toThrow(
      'gh returned an invalid Issue payload: not valid JSON'
    );
  });
});

describe('ghJson', () => {
  it('parses stdout with the provided canonical parser', async () => {
    ghMock.mockResolvedValueOnce({ stdout: readFixture('issue-view.json'), stderr: '' });

    const parsed = await ghJson(
      ['issue', 'view', '638', '-R', 'dnsquared/shipper-cli', '--json', 'number,title'],
      parseIssue
    );

    expect(parsed.number).toBe(638);
    expect(parsed.labels[0]).toEqual({ name: 'shipper:planned' });
  });
});
