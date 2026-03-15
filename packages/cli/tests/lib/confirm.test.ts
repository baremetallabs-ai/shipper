import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

import { confirm } from '../../src/lib/confirm.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('confirm', () => {
  it('returns true for "y"', async () => {
    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('y');
    });
    expect(await confirm('Proceed?')).toBe(true);
  });

  it('returns true for "Y"', async () => {
    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('Y');
    });
    expect(await confirm('Proceed?')).toBe(true);
  });

  it('returns false for "n"', async () => {
    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('n');
    });
    expect(await confirm('Proceed?')).toBe(false);
  });

  it('returns false for "N"', async () => {
    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('N');
    });
    expect(await confirm('Proceed?')).toBe(false);
  });

  it('returns false for empty string', async () => {
    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('');
    });
    expect(await confirm('Proceed?')).toBe(false);
  });

  it('returns false for arbitrary input', async () => {
    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('yes');
    });
    expect(await confirm('Proceed?')).toBe(false);
  });

  it('closes the readline interface after answering', async () => {
    mockQuestion.mockImplementation((_msg: string, cb: (answer: string) => void) => {
      cb('y');
    });
    await confirm('Proceed?');
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
