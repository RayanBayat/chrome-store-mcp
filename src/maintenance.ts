/**
 * When this project was last reviewed for new or deprecated Google API methods, MCP changes and outdated
 * dependencies. `npm run maintenance -- --record` updates these values after a review (see docs/maintenance.md).
 *
 * While the review is overdue, every tool result ends with a reminder, so whoever uses the server notices.
 */
export const LAST_REVIEWED = '2026-11-03';
export const REVIEW_INTERVAL_DAYS = 30;
/** The `revision` of Google's API description that maintenance/api-surface.json was taken from. */
export const API_REVISION = '20261101';

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysSinceReview(now: Date, lastReviewed: string = LAST_REVIEWED): number {
  return Math.floor((now.getTime() - Date.parse(`${lastReviewed}T00:00:00Z`)) / DAY_MS);
}

/** The reminder to show, or null while the last review is recent enough. */
export function maintenanceNotice(now: Date, lastReviewed: string = LAST_REVIEWED): string | null {
  const days = daysSinceReview(now, lastReviewed);
  if (days <= REVIEW_INTERVAL_DAYS) return null;
  return (
    `Maintenance review overdue: chrome-store-mcp was last reviewed on ${lastReviewed} (${String(days)} days ago). ` +
    'Before relying on it, run `npm run maintenance` in its folder and follow docs/maintenance.md.'
  );
}
