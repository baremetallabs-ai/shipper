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
