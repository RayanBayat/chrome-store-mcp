/**
 * Turns what a tool produced (or the error it threw) into the result format MCP expects.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describeError, redact } from '../errors.ts';

/** Very large answers are cut so they do not flood the model's context. */
export const MAX_OUTPUT_CHARS = 60_000;

export function render(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [cut at ${String(MAX_OUTPUT_CHARS)} characters; ask for a smaller page]`;
}

/**
 * Runs a tool body and always returns a result: the text on success, a safe error message on failure.
 * `notice` (the maintenance reminder) is appended to every result while it is set.
 */
export async function runTool(body: () => Promise<string>, notice: string | null): Promise<CallToolResult> {
  const withNotice = (text: string): string => (notice ? `${text}\n\n${notice}` : text);
  try {
    return { content: [{ type: 'text', text: withNotice(await body()) }] };
  } catch (error) {
    const message = describeError(error);
    if (message.startsWith('Unexpected error')) {
      process.stderr.write(`chrome-store-mcp: ${redact(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
    }
    return { content: [{ type: 'text', text: withNotice(message) }], isError: true };
  }
}
