/**
 * What every tool needs, passed in once when the server starts (this keeps the tools easy to test with fakes).
 */
import { z } from 'zod';
import type { Confirm } from '../confirm/confirm.ts';
import type { ItemDefaults } from '../store/ids.ts';
import { ITEM_ID_PATTERN, PUBLISHER_ID_PATTERN } from '../store/ids.ts';
import type { StoreClient } from '../store/client.ts';

export interface ToolContext {
  client: StoreClient;
  defaults: ItemDefaults;
  confirm: Confirm;
  /** The maintenance reminder, or null. Read once per call so a long-running server notices the date passing. */
  notice: () => string | null;
}

/** The two optional arguments every tool accepts. Both fall back to CWS_ITEM_ID and CWS_PUBLISHER_ID. */
export const itemArgs = {
  itemId: z.string().regex(ITEM_ID_PATTERN).optional().describe('The 32-letter item ID. Defaults to CWS_ITEM_ID.'),
  publisherId: z.string().regex(PUBLISHER_ID_PATTERN).optional().describe('Your publisher ID. Defaults to CWS_PUBLISHER_ID.'),
};
