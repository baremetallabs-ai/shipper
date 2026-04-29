import type { core, z } from 'zod';
import { toErrorMessage } from './errors.js';
import { gh } from './gh.js';

export class GhPayloadError extends Error {
  constructor(
    public readonly shapeName: string,
    public readonly fieldPath: string,
    message: string
  ) {
    super(message);
    this.name = 'GhPayloadError';
  }
}

export function formatZodPath(path: PropertyKey[]): string {
  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') {
      return `${result}[${segment}]`;
    }

    const key = String(segment);
    return result ? `${result}.${key}` : key;
  }, '');
}

function lowercaseFirst(value: string): string {
  return value ? `${value[0]?.toLowerCase() ?? ''}${value.slice(1)}` : value;
}

function formatZodIssue(issue: core.$ZodIssue): string {
  if (issue.code === 'invalid_type') {
    return `expected ${issue.expected}`;
  }

  if (issue.code === 'invalid_value') {
    if (issue.values.length === 1) {
      return `expected ${JSON.stringify(issue.values[0])}`;
    }

    return `expected one of ${issue.values.map((value) => JSON.stringify(value)).join(', ')}`;
  }

  return lowercaseFirst(issue.message);
}

export function parseGhJson<TOutput, TInput = unknown>(
  json: string,
  schema: z.ZodType<TOutput, TInput>,
  shapeName: string
): TOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new GhPayloadError(
      shapeName,
      '',
      `gh returned an invalid ${shapeName} payload: not valid JSON (${toErrorMessage(error)})`
    );
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  if (!issue) {
    throw new GhPayloadError(
      shapeName,
      '',
      `gh returned an invalid ${shapeName} payload: validation failed`
    );
  }

  const fieldPath = formatZodPath(issue.path);
  const detail = formatZodIssue(issue);
  throw new GhPayloadError(
    shapeName,
    fieldPath,
    `gh returned an invalid ${shapeName} payload: ${detail}${fieldPath ? ` at ${fieldPath}` : ''}`
  );
}

export async function ghJson<T>(
  args: string[],
  parse: (json: string) => T,
  options?: { cwd?: string }
): Promise<T> {
  const { stdout } = await gh(args, options);
  return parse(stdout);
}
