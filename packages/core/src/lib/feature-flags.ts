export const MCP_GROOMING_FLAG = 'SHIPPER_EXPERIMENTAL_MCP_GROOMING';
export const DESIGN_ADVERSARY_FLAG = 'SHIPPER_EXPERIMENTAL_DESIGN_ADVERSARY';

function isFlagSet(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed !== '' && trimmed !== '0' && trimmed !== 'false' && trimmed !== 'no';
}

/**
 * MCP-driven grooming is gated behind an experimental env var. Interactive grooming
 * (CLI / desktop PTY) works regardless. When this flag is set:
 *
 *   - `shipper groom --mode headless` is allowed (the CLI's TTY/mode guards step aside).
 *   - `resolveMode('groom', undefined)` defaults to `'headless'` instead of `'default'`.
 *   - The `shipper_groom` MCP tool is functional; with the flag unset it returns a
 *     clear error pointing at the env var.
 *
 * With the flag unset, behaviour is unchanged.
 */
export function isMcpGroomingEnabled(): boolean {
  return isFlagSet(MCP_GROOMING_FLAG);
}

/**
 * Adversarial design review is gated behind an experimental env var. When set, the
 * design stage runs designer → adversary → designer (three agent invocations in one
 * stage) instead of a single designer pass, with each intermediate comment posted to
 * the issue thread before the next agent reads it.
 *
 * With the flag unset, behaviour is unchanged.
 */
export function isDesignAdversaryEnabled(): boolean {
  return isFlagSet(DESIGN_ADVERSARY_FLAG);
}
