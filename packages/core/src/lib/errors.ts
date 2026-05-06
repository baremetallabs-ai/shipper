export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(toErrorMessage(error));
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

export function hasErrorCode(error: unknown, code: string | readonly string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const codes = Array.isArray(code) ? code : [code];
  return codes.includes(String(error.code));
}
