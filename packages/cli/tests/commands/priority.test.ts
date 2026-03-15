import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGh } = vi.hoisted(() => ({
  mockGh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
}));

vi.mock('@dnsquared/shipper-core', () => ({
  gh: (args: string[]) => mockGh(args),
  PRIORITY_HIGH_LABEL: 'shipper:priority-high',
  PRIORITY_LOW_LABEL: 'shipper:priority-low',
  STAGE_LABEL_NAMES: [
    'shipper:new',
    'shipper:groomed',
    'shipper:designed',
    'shipper:planned',
    'shipper:implemented',
    'shipper:pr-open',
    'shipper:pr-reviewed',
    'shipper:ready',
  ],
}));

import { priorityCommand } from '../../src/commands/priority.js';

const repo = 'owner/repo';
const _exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

function mockOpenIssue(labels: string[], state = 'OPEN'): void {
  mockGh.mockImplementation((args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') {
      return Promise.resolve({
        stdout: JSON.stringify({
          number: 42,
          state,
          labels: labels.map((name) => ({ name })),
        }),
        stderr: '',
      });
    }

    if (args[0] === 'pr' && args[1] === 'view') {
      throw new Error('not a PR');
    }

    return Promise.resolve({ stdout: '', stderr: '' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('priorityCommand', () => {
  it('sets high priority and removes low priority', async () => {
    mockOpenIssue(['shipper:planned', 'shipper:priority-low']);

    await priorityCommand(repo, '42', 'high');

    expect(mockGh).toHaveBeenCalledWith([
      'issue',
      'edit',
      '42',
      '-R',
      repo,
      '--add-label',
      'shipper:priority-high',
      '--remove-label',
      'shipper:priority-low',
    ]);
    expect(logSpy).toHaveBeenCalledWith('Issue #42 priority set to high.');
  });

  it('sets low priority and removes high priority', async () => {
    mockOpenIssue(['shipper:planned', 'shipper:priority-high']);

    await priorityCommand(repo, '42', 'low');

    expect(mockGh).toHaveBeenCalledWith([
      'issue',
      'edit',
      '42',
      '-R',
      repo,
      '--add-label',
      'shipper:priority-low',
      '--remove-label',
      'shipper:priority-high',
    ]);
    expect(logSpy).toHaveBeenCalledWith('Issue #42 priority set to low.');
  });

  it('removes both priority labels when setting normal priority', async () => {
    mockOpenIssue(['shipper:planned', 'shipper:priority-high']);

    await priorityCommand(repo, '42', 'normal');

    expect(mockGh).toHaveBeenCalledWith([
      'issue',
      'edit',
      '42',
      '-R',
      repo,
      '--remove-label',
      'shipper:priority-high',
      '--remove-label',
      'shipper:priority-low',
    ]);
    expect(logSpy).toHaveBeenCalledWith('Issue #42 priority set to normal.');
  });

  it('prints a no-op message when the issue is already normal priority', async () => {
    mockOpenIssue(['shipper:planned']);

    await priorityCommand(repo, '42', 'normal');

    expect(logSpy).toHaveBeenCalledWith('Issue #42 is already at normal priority.');
    const editCalls = mockGh.mock.calls.filter(
      ([args]) => args[0] === 'issue' && args[1] === 'edit'
    );
    expect(editCalls).toHaveLength(0);
  });

  it('strips a leading # from the issue reference', async () => {
    mockOpenIssue(['shipper:planned']);

    await priorityCommand(repo, '#42', 'high');

    expect(mockGh).toHaveBeenCalledWith([
      'issue',
      'view',
      '42',
      '-R',
      repo,
      '--json',
      'number,state,labels',
    ]);
  });

  it('rejects pull requests', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return Promise.resolve({
          stdout: JSON.stringify({
            number: 42,
            state: 'OPEN',
            labels: [{ name: 'shipper:planned' }],
          }),
          stderr: '',
        });
      }

      if (args[0] === 'pr' && args[1] === 'view') {
        return Promise.resolve({
          stdout: JSON.stringify({ number: 42, url: 'https://example.test/pr/42' }),
          stderr: '',
        });
      }

      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(priorityCommand(repo, '42', 'high')).rejects.toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalledWith('Error: #42 is a pull request, not an issue.');
  });

  it('rejects closed issues', async () => {
    mockOpenIssue(['shipper:planned'], 'CLOSED');

    await expect(priorityCommand(repo, '42', 'high')).rejects.toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalledWith('Error: Issue #42 is not open.');
  });

  it('rejects open issues that are not in the shipper workflow', async () => {
    mockOpenIssue(['bug']);

    await expect(priorityCommand(repo, '42', 'high')).rejects.toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalledWith('Error: Issue #42 is not in the shipper workflow.');
  });

  it('rejects invalid issue numbers', async () => {
    await expect(priorityCommand(repo, 'abc', 'high')).rejects.toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalledWith('Error: Please provide a valid issue number.');
    expect(errorSpy).toHaveBeenCalledWith('Usage: shipper priority <issue> <high|normal|low>');
  });
});
