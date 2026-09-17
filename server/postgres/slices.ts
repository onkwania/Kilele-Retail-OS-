/**
 * The migration's vertical slices, in the order the plan requires and in dependency order.
 *
 * This registry is the single source of truth for "what may run on PostgreSQL today". It is read
 * by the engine guard (server/postgres/db.ts), the PostgreSQL app (which fails closed on anything
 * not registered), the operator CLI and the tests. A slice is registered only when its module has
 * been converted to the async data layer AND its tests pass against a real server.
 */

export const SLICES = [
  'health',
  'bootstrap',
  'auth',
  'staff',
  'products',
  'inventory',
  'sales',
  'purchases',
  'approvals',
  'reports',
] as const;

export type Slice = (typeof SLICES)[number];

/** What each slice covers, so an operator reading /api/engine knows what is missing. */
export const SLICE_SCOPE: Record<Slice, string> = {
  health: 'startup, connection pool, /api/health',
  bootstrap: 'workspace bootstrap and environment markers',
  auth: 'sign-in, sessions, CSRF, lockout, password change',
  staff: 'staff management, permissions, invitations',
  products: 'catalogue, pricing and price history',
  inventory: 'stock engine, movements, counts, wastage',
  sales: 'POS sales, tenders, receipts, cash sessions',
  purchases: 'purchases, receipts, supplier payments, expenses',
  approvals: 'approval requests, decisions and reversals',
  reports: 'reports, analytics, exports and integrity API',
};

const converted = new Set<string>();

/** Registers a slice as converted. Called by the slice's own module, never from configuration. */
export function markSliceConverted(slice: string): void {
  converted.add(slice);
}

export function isSliceConverted(slice: string): boolean {
  return converted.has(slice);
}

export function convertedSlices(): string[] {
  return SLICES.filter((slice) => converted.has(slice));
}

/** Slices that are still on SQLite, with what each one covers. */
export function pendingSlices(): Array<{ slice: Slice; scope: string }> {
  return SLICES.filter((slice) => !converted.has(slice)).map((slice) => ({
    slice,
    scope: SLICE_SCOPE[slice],
  }));
}

/** Test hook: forget every registration. */
export function resetConvertedSlices(): void {
  converted.clear();
}
