/**
 * The kinds of error this server reports, and the one function that cleans error text before anyone sees it.
 *
 * Each class tells the person (or the model) something different:
 * - InputError: the tool was called with a bad value. Fix the arguments and try again.
 * - SetupError: something is not set up yet (no sign-in, no confirmation method). The message says what to run.
 * - ApiError: Google answered with an error.
 * - DeclinedError: a person said "no" to a confirmation dialog, or did not answer in time.
 */

export class InputError extends Error {
  override name = 'InputError';
}

export class SetupError extends Error {
  override name = 'SetupError';
}

export class ApiError extends Error {
  override name = 'ApiError';
}

export class DeclinedError extends Error {
  override name = 'DeclinedError';
}

/**
 * Removes anything shaped like a Google access token (`ya29.…`) or refresh token (`1//…`) from text.
 * Every error message passes through here before it is returned or logged, so a token can never leak through
 * an error, even if Google echoes one back.
 */
export function redact(text: string): string {
  return text.replace(/ya29\.[\w.-]+/g, '[redacted]').replace(/1\/\/[\w.-]+/g, '[redacted]');
}

/** Turns any thrown value into text that is safe to show: our own errors keep their message, others are hidden. */
export function describeError(error: unknown): string {
  if (error instanceof InputError || error instanceof SetupError || error instanceof ApiError || error instanceof DeclinedError) {
    return redact(error.message);
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'The request timed out. Try again.';
  }
  return 'Unexpected error. Details are in the server log (stderr).';
}
