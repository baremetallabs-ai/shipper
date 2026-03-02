import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('shipper-cli', () => {
  it('shows help with available commands', () => {
    const output = execFileSync('node', ['dist/index.js', '--help'], {
      encoding: 'utf-8',
    });
    expect(output).toContain('init');
    expect(output).toContain('new');
    expect(output).toContain('groom');
    expect(output).toContain('design');
    expect(output).toContain('plan');
    expect(output).toContain('pr');
  });
});
