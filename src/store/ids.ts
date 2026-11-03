/**
 * Checks for the values that end up inside request URLs. Every ID is checked against a strict pattern before it is
 * used, so a tool argument can never change which Google address a request goes to (no `../`, no `/`, no `:`).
 */
import { InputError } from '../errors.ts';

/** A Chrome extension ID: exactly 32 letters, each from `a` to `p`. */
export const ITEM_ID_PATTERN = /^[a-p]{32}$/;

/** A publisher ID from the Developer Dashboard. Letters, digits, `-` and `_` only. */
export const PUBLISHER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** An extension version as Chrome accepts it: one to four numbers separated by dots, e.g. `1.2.3`. */
export const VERSION_PATTERN = /^\d{1,5}(?:\.\d{1,5}){0,3}$/;

/** Builds the API's resource name for one item, after checking both IDs. */
export function itemName(publisherId: string, itemId: string): string {
  if (!PUBLISHER_ID_PATTERN.test(publisherId)) {
    throw new InputError('publisherId must be your publisher ID from the Developer Dashboard (letters, digits, - and _).');
  }
  if (!ITEM_ID_PATTERN.test(itemId)) {
    throw new InputError('itemId must be the 32-letter item ID (letters a to p) from the dashboard URL.');
  }
  return `publishers/${publisherId}/items/${itemId}`;
}

export interface ItemDefaults {
  publisherId?: string | undefined;
  itemId?: string | undefined;
}

/** Uses the IDs passed to the tool, or else the defaults from the environment. */
export function resolveItemName(args: ItemDefaults, defaults: ItemDefaults): string {
  const publisherId = args.publisherId ?? defaults.publisherId;
  const itemId = args.itemId ?? defaults.itemId;
  if (!publisherId) throw new InputError('No publisher ID: pass publisherId or set CWS_PUBLISHER_ID.');
  if (!itemId) throw new InputError('No item ID: pass itemId or set CWS_ITEM_ID.');
  return itemName(publisherId, itemId);
}
