/**
 * Settings read from environment variables when the server starts. None of them is secret: credentials are read
 * separately (see src/auth/credentials.ts).
 *
 *   CWS_PUBLISHER_ID   default publisher ID for every tool (optional)
 *   CWS_ITEM_ID        default item ID for every tool (optional)
 *   CWS_CONFIRM        how write actions are confirmed by a person:
 *                        auto   (default) a desktop dialog if one is available, else a prompt in the MCP client
 *                        dialog only a desktop dialog (kdialog or zenity)
 *                        elicit only a prompt in the MCP client (MCP "elicitation")
 *                        none   no confirmation at all: only for automation you fully trust
 */
import { SetupError } from './errors.ts';
import { ITEM_ID_PATTERN, PUBLISHER_ID_PATTERN } from './store/ids.ts';

export const CONFIRM_MODES = ['auto', 'dialog', 'elicit', 'none'] as const;
export type ConfirmMode = (typeof CONFIRM_MODES)[number];

export interface Config {
  publisherId: string | undefined;
  itemId: string | undefined;
  confirm: ConfirmMode;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publisherId = env.CWS_PUBLISHER_ID || undefined;
  const itemId = env.CWS_ITEM_ID || undefined;
  const confirm = env.CWS_CONFIRM || 'auto';

  // Fail at start-up, not at the first tool call, so a typo in the MCP settings is noticed straight away.
  if (publisherId !== undefined && !PUBLISHER_ID_PATTERN.test(publisherId)) {
    throw new SetupError('CWS_PUBLISHER_ID is not a valid publisher ID.');
  }
  if (itemId !== undefined && !ITEM_ID_PATTERN.test(itemId)) {
    throw new SetupError('CWS_ITEM_ID must be a 32-letter item ID (letters a to p).');
  }
  if (!isConfirmMode(confirm)) {
    throw new SetupError(`CWS_CONFIRM must be one of: ${CONFIRM_MODES.join(', ')}.`);
  }
  return { publisherId, itemId, confirm };
}

function isConfirmMode(value: string): value is ConfirmMode {
  return (CONFIRM_MODES as readonly string[]).includes(value);
}
