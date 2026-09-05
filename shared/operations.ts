/** Recovery metadata for existing financial routes; actual writes still pass their normal route/domain permissions. */
const rules = [
  { pattern: /^\/sales$/, permission: 'sales.create', label: 'Checkout', page: '/pos' },
  { pattern: /^\/expenses$/, permission: 'expenses.create', label: 'Expense', page: '/expenses' },
  {
    pattern: /^\/purchases$/,
    permission: 'inventory.receive',
    label: 'Purchase receiving',
    page: '/purchases',
  },
  {
    pattern: /^\/purchases\/[\w-]+\/payments$/,
    permission: 'expenses.create',
    label: 'Supplier payment',
    page: '/purchases',
  },
  {
    pattern: /^\/inventory\/opening$/,
    permission: 'inventory.opening',
    label: 'Opening stock',
    page: '/inventory',
  },
  {
    pattern: /^\/inventory\/requests$/,
    permission: 'inventory.request',
    label: 'Stock request',
    page: '/approvals',
  },
  { pattern: /^\/sessions$/, permission: 'sessions.own', label: 'Open register', page: '/reconciliation' },
  {
    pattern: /^\/sessions\/[\w-]+\/close$/,
    permission: 'sessions.own',
    label: 'Daily closing',
    page: '/reconciliation',
  },
  {
    pattern: /^\/approvals$/,
    permission: 'requests.create',
    label: 'Correction request',
    page: '/approvals',
  },
  {
    pattern: /^\/approvals\/[\w-]+\/review$/,
    permission: 'approvals.review',
    label: 'Approval decision',
    page: '/approvals',
  },
  {
    pattern: /^\/approvals\/[\w-]+\/reply$/,
    permission: 'requests.create',
    label: 'Clarification',
    page: '/approvals',
  },
];
export function financialOperation(method: string, path: string) {
  return method === 'POST' ? rules.find((r) => r.pattern.test(path)) : undefined;
}

export function validFinancialResult(method: string, path: string, data: unknown): boolean {
  const rule = financialOperation(method, path);
  if (!rule) return true;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const value = data as Record<string, any>,
    identifier = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (value.ok !== true) return false;
  if (path === '/sessions') return !!value.session && identifier(value.session.id);
  if (/^\/purchases\/[\w-]+\/payments$/.test(path)) return !!value.payment && identifier(value.payment.id);
  if (!identifier(value.id)) return false;
  if (path === '/sales')
    return (
      identifier(value.ref) &&
      Number.isSafeInteger(value.total_cents) &&
      value.total_cents > 0 &&
      Number.isSafeInteger(value.change_cents)
    );
  return true;
}
