export const MCP_GROOMING_FLAG = 'SHIPPER_EXPERIMENTAL_MCP_GROOMING';

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
  const raw = process.env[MCP_GROOMING_FLAG];
  if (raw === undefined) return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed !== '' && trimmed !== '0' && trimmed !== 'false' && trimmed !== 'no';
}
