import { describe, it, expect } from 'vitest';
import { formatIssue, formatPR } from '../../src/lib/github.js';

describe('formatIssue', () => {
  it('formats a basic issue with comments', () => {
    const result = formatIssue({
      number: 42,
      title: 'Fix login bug',
      state: 'OPEN',
      labels: [{ name: 'bug' }, { name: 'shipper:groomed' }],
      body: 'Login fails on Safari.',
      comments: [
        {
          author: { login: 'alice' },
          body: 'Can reproduce on iOS too.',
          createdAt: '2025-01-15T10:30:00Z',
        },
      ],
      author: { login: 'bob' },
      createdAt: '2025-01-14T08:00:00Z',
    });

    expect(result).toContain('# Issue #42: Fix login bug');
    expect(result).toContain('**State:** OPEN');
    expect(result).toContain('bug, shipper:groomed');
    expect(result).toContain('@bob');
    expect(result).toContain('Login fails on Safari.');
    expect(result).toContain('## Comments');
    expect(result).toContain('@alice');
    expect(result).toContain('Can reproduce on iOS too.');
  });

  it('formats an issue with no comments', () => {
    const result = formatIssue({
      number: 1,
      title: 'Add feature',
      state: 'OPEN',
      labels: [],
      body: 'We need this.',
      comments: [],
      author: { login: 'dan' },
      createdAt: '2025-01-01T00:00:00Z',
    });

    expect(result).toContain('# Issue #1: Add feature');
    expect(result).toContain('**Labels:** none');
    expect(result).not.toContain('## Comments');
  });

  it('handles missing body', () => {
    const result = formatIssue({
      number: 5,
      title: 'Empty',
      state: 'CLOSED',
      labels: [],
      body: '',
      comments: [],
      author: { login: 'x' },
      createdAt: '2025-01-01T00:00:00Z',
    });

    expect(result).toContain('*No description provided.*');
  });
});

describe('formatPR', () => {
  it('formats a PR with reviews and comments', () => {
    const result = formatPR({
      number: 10,
      title: 'Fix the thing',
      state: 'OPEN',
      labels: [{ name: 'enhancement' }],
      body: 'This fixes the thing.',
      comments: [
        {
          author: { login: 'reviewer' },
          body: 'Looks good overall.',
          createdAt: '2025-02-01T12:00:00Z',
        },
      ],
      author: { login: 'dev' },
      createdAt: '2025-01-30T09:00:00Z',
      headRefName: 'fix/thing',
      baseRefName: 'main',
      reviews: [
        {
          author: { login: 'reviewer' },
          body: 'Approved with minor notes.',
          state: 'APPROVED',
          createdAt: '2025-02-01T11:00:00Z',
        },
      ],
    });

    expect(result).toContain('# PR #10: Fix the thing');
    expect(result).toContain('**Branch:** fix/thing → main');
    expect(result).toContain('## Reviews');
    expect(result).toContain('APPROVED');
    expect(result).toContain('Approved with minor notes.');
    expect(result).toContain('## Comments');
    expect(result).toContain('Looks good overall.');
  });

  it('formats a PR with no reviews or comments', () => {
    const result = formatPR({
      number: 3,
      title: 'Simple change',
      state: 'OPEN',
      labels: [],
      body: 'Just a small fix.',
      comments: [],
      author: { login: 'dev' },
      createdAt: '2025-01-01T00:00:00Z',
      headRefName: 'patch-1',
      baseRefName: 'main',
      reviews: [],
    });

    expect(result).toContain('# PR #3: Simple change');
    expect(result).toContain('**Branch:** patch-1 → main');
    expect(result).not.toContain('## Reviews');
    expect(result).not.toContain('## Comments');
  });
});
