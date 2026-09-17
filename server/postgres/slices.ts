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
  'operations',
] as const;

export type Slice = (typeof SLICES)[number];

/**
 * What each slice covers, in the plan's own words, so an operator reading /api/engine knows what is
 * missing and which slice will bring it. Two registry entries belong to plan Slice 2 (bootstrap and
 * authentication) because they were converted together and are separately observable.
 */
export const SLICE_SCOPE: Record<Slice, string> = {
  health: 'Slice 1 - connection, health, migrations, guard verification',
  bootstrap: 'Slice 2 - one-time workspace bootstrap and environment provenance',
  auth: 'Slice 2 - authentication, sessions, CSRF and lockout',
  staff: 'Slice 3 - staff, roles, permissions and tenant scope',
  products: 'Slice 4 - products, catalogue, pricing and barcodes',
  inventory: 'Slice 5 - inventory, stock locking and weighted-average costing',
  sales: 'Slice 6 - POS sales, payments, journals, receipts and idempotency',
  purchases: 'Slice 7 - purchases, expenses and reconciliation',
  approvals: 'Slice 8 - approvals, reversals, reports and analytics',
  operations: 'Slice 9 - documents, backups, restore and production operations',
};

/** The plan's slice number, so progress can be read against the migration plan directly. */
export const SLICE_PLAN: Record<Slice, number> = {
  health: 1,
  bootstrap: 2,
  auth: 2,
  staff: 3,
  products: 4,
  inventory: 5,
  sales: 6,
  purchases: 7,
  approvals: 8,
  operations: 9,
};

/** Which plan slice is next, and what it covers. */
export function nextSlice(): { slice: Slice; plan: number; scope: string } | null {
  const pending = pendingSlices();
  if (!pending.length) return null;
  const first = pending[0];
  return { slice: first.slice, plan: SLICE_PLAN[first.slice], scope: first.scope };
}

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
