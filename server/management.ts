import type { Express } from 'express';
import { z } from 'zod';
import {
  type DB,
  type Actor,
  type Row,
  one,
  all,
  requireThat,
  insert,
  id,
  scope,
  now,
  scoped,
  audit,
  cents,
  moneyInput,
  reasonInput,
  can,
  demand,
  sha,
} from './core.js';
import { protect } from './auth.js';
import { mutate } from './mutate.js';
import { hashPassword, actorFor } from './db.js';
import { ROLE_NAMES, ROLE_PERMISSIONS, PERMISSIONS } from './permissions.js';
const userSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(200),
  role_id: z.enum(['super_admin', 'admin', 'accountant', 'cashier', 'inventory']),
  active: z.boolean().default(true),
  reports_access: z.boolean().optional(),
  reason: reasonInput,
});
export function saveUser(db: DB, a: Actor, input: unknown, userId?: string) {
  demand(a, 'staff.write');
  const schema = userId
    ? userSchema.strict()
    : userSchema.extend({ password: z.string().min(12).max(200) }).strict();
  const b = schema.parse(input) as z.infer<typeof userSchema> & { password?: string };
  const original = userId ? scoped(db, 'users', userId, a) : null;
  requireThat(
    a.role_id === 'super_admin' ||
      (!['super_admin', 'admin'].includes(b.role_id) &&
        !['super_admin', 'admin'].includes(original?.role_id)),
    'Only the super administrator may manage administrator accounts.',
    403,
  );
  if (userId === a.id)
    requireThat(
      b.active && b.role_id === a.role_id,
      'You cannot deactivate yourself or change your own role.',
      403,
    );
  if (original?.role_id === 'super_admin' && (!b.active || b.role_id !== 'super_admin'))
    requireThat(
      one(
        db,
        "SELECT COUNT(*) n FROM users WHERE business_id=? AND role_id='super_admin' AND active=1",
        a.business_id,
      )!.n > 1,
      'The last super administrator cannot be removed.',
      409,
    );
  const rid = userId ?? id('usr_'),
    row = { name: b.name, email: b.email.toLowerCase(), role_id: b.role_id, active: b.active ? 1 : 0 };
  if (original) {
    db.prepare('UPDATE users SET name=?,email=?,role_id=?,active=? WHERE id=?').run(
      row.name,
      row.email,
      row.role_id,
      row.active,
      rid,
    );
    db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(rid);
  } else
    insert(db, 'users', {
      id: rid,
      ...scope(a),
      ...row,
      password_hash: hashPassword(b.password!),
      must_change_password: 1,
      created_at: now(),
    });
  const previousOverrides = all(
    db,
    'SELECT permission_id,allowed FROM user_permissions WHERE user_id=?',
    rid,
  );
  // A metadata-only update must not silently remove an explicit permission denial.
  if (!original || original.role_id !== b.role_id)
    db.prepare('DELETE FROM user_permissions WHERE user_id=?').run(rid);
  if (b.role_id === 'accountant' && b.reports_access !== undefined) {
    db.prepare("DELETE FROM user_permissions WHERE user_id=? AND permission_id='reports.read'").run(rid);
  }
  if (b.role_id === 'accountant' && b.reports_access !== undefined)
    insert(db, 'user_permissions', {
      user_id: rid,
      permission_id: 'reports.read',
      allowed: b.reports_access ? 1 : 0,
    });
  const safeOriginal = original
    ? {
        name: original.name,
        email: original.email,
        role_id: original.role_id,
        active: original.active,
        permission_overrides: previousOverrides,
      }
    : null;
  audit(
    db,
    a,
    original ? 'staff.updated' : 'staff.created',
    'users',
    rid,
    safeOriginal,
    {
      ...row,
      reports_access: b.reports_access,
      effective_permissions: actorFor(db, rid)?.permissions ?? [],
      temporary_password: !original,
    },
    b.reason,
  );
  return { ok: true, id: rid };
}
export function documentAccess(a: Actor, doc: Row) {
  const purpose = doc.purpose ?? 'request';
  return (
    doc.user_id === a.id ||
    can(a, 'approvals.read') ||
    (purpose === 'product' && can(a, 'products.read')) ||
    (purpose === 'expense' && can(a, 'expenses.read')) ||
    (purpose === 'purchase' && can(a, 'inventory.receive'))
  );
}
export function installManagement(app: Express, db: DB) {
  app.get('/api/staff', protect('staff.read'), (req, res) =>
    res.json({
      users: all(
        db,
        'SELECT id,name,email,role_id,active,must_change_password,created_at FROM users WHERE business_id=? AND branch_id=? ORDER BY name',
        req.actor.business_id,
        req.actor.branch_id,
      ).map((u) => ({ ...u, permissions: actorFor(db, u.id)?.permissions ?? [] })),
      roles: ROLE_NAMES,
      role_permissions: ROLE_PERMISSIONS,
      permissions: PERMISSIONS,
    }),
  );
  app.post('/api/staff', protect('staff.write'), (req, res) =>
    res.status(201).json(mutate(db, req, () => saveUser(db, req.actor, req.body))),
  );
  app.patch('/api/staff/:id', protect('staff.write'), (req, res) =>
    res.json(mutate(db, req, () => saveUser(db, req.actor, req.body, String(req.params.id)))),
  );
  app.post('/api/staff/:id/reset-password', protect('staff.write'), (req, res) => {
    const b = z
      .object({ password: z.string().min(12).max(200), reason: reasonInput })
      .strict()
      .parse(req.body);
    res.json(
      mutate(db, req, () => {
        const user = scoped(db, 'users', String(req.params.id), req.actor);
        requireThat(user.id !== req.actor.id, 'Use your own change-password screen.');
        requireThat(
          req.actor.role_id === 'super_admin' || !['admin', 'super_admin'].includes(user.role_id),
          'Only a super administrator may reset an administrator password.',
          403,
        );
        db.prepare('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?').run(
          hashPassword(b.password),
          user.id,
        );
        db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id);
        audit(
          db,
          req.actor,
          'staff.password_reset',
          'users',
          user.id,
          null,
          { must_change_password: true, sessions_revoked: true },
          b.reason,
        );
        return { ok: true };
      }),
    );
  });
  app.get('/api/settings', protect('settings.write'), (req, res) =>
    res.json({
      business: one(db, 'SELECT * FROM businesses WHERE id=?', req.actor.business_id),
      branch: one(db, 'SELECT * FROM branches WHERE id=?', req.actor.branch_id),
      controls: {
        currency: 'KES',
        timezone: 'Africa/Nairobi',
        session_hours: 12,
        costing: 'Moving weighted average',
        inventory: 'Atomic ledger-controlled balances',
        retention: 'Append-only financial records',
        payment_mode: 'Manually recorded, provider-confirmed references',
        tax_mode: 'Product-level configuration; no eTIMS connector',
      },
    }),
  );
  app.patch('/api/settings', protect('settings.write'), (req, res) => {
    const b = z
      .object({
        name: z.string().trim().min(2).max(150),
        address: z.string().max(250),
        phone: z.string().max(40),
        tax_pin: z.string().max(40),
        receipt_footer: z.string().max(500),
        variance_threshold: moneyInput,
        branch_name: z.string().trim().min(2).max(100),
        location: z.string().max(150),
        reason: reasonInput,
      })
      .strict()
      .parse(req.body);
    res.json(
      mutate(db, req, () => {
        const previous = one(db, 'SELECT * FROM businesses WHERE id=?', req.actor.business_id),
          branch = one(db, 'SELECT * FROM branches WHERE id=?', req.actor.branch_id);
        db.prepare(
          'UPDATE businesses SET name=?,address=?,phone=?,tax_pin=?,receipt_footer=?,variance_threshold_cents=? WHERE id=?',
        ).run(
          b.name,
          b.address,
          b.phone,
          b.tax_pin,
          b.receipt_footer,
          cents(b.variance_threshold),
          req.actor.business_id,
        );
        db.prepare('UPDATE branches SET name=?,location=? WHERE id=? AND business_id=?').run(
          b.branch_name,
          b.location,
          req.actor.branch_id,
          req.actor.business_id,
        );
        audit(
          db,
          req.actor,
          'settings.updated',
          'businesses',
          req.actor.business_id,
          { business: previous, branch },
          b,
          b.reason,
        );
        return { ok: true };
      }),
    );
  });
  app.post('/api/documents', protect(), (req, res) => {
    const b = z
      .object({
        name: z.string().min(1).max(150),
        mime: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
        data: z.string().max(4_000_000),
        purpose: z.enum(['request', 'expense', 'purchase', 'product']),
      })
      .strict()
      .parse(req.body);
    const permission = {
      request: 'requests.create',
      expense: 'expenses.create',
      purchase: 'inventory.receive',
      product: 'products.write',
    }[b.purpose];
    demand(req.actor, permission);
    requireThat(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.data),
      'Invalid base64 document encoding.',
    );
    const buffer = Buffer.from(b.data, 'base64');
    requireThat(
      buffer.length > 0 && buffer.length <= 3_000_000,
      'Supporting documents must be 3 MB or smaller.',
    );
    const signature =
      b.mime === 'application/pdf'
        ? buffer.subarray(0, 5).toString() === '%PDF-'
        : b.mime === 'image/png'
          ? buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
          : b.mime === 'image/jpeg'
            ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
            : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
    requireThat(signature, 'File content does not match its declared type.');
    res.status(201).json(
      mutate(db, req, () => {
        const rid = id('doc_'),
          name = b.name.replace(/[^\p{L}\p{N} ._()-]/gu, '_');
        insert(db, 'documents', {
          id: rid,
          ...scope(req.actor),
          user_id: req.actor.id,
          name,
          mime: b.mime,
          purpose: b.purpose,
          sha256: sha(buffer),
          content: buffer,
          created_at: now(),
        });
        audit(
          db,
          req.actor,
          'document.uploaded',
          'documents',
          rid,
          null,
          { name, mime: b.mime, sha256: sha(buffer), size: buffer.length, purpose: b.purpose },
          'Supporting evidence uploaded',
        );
        return { ok: true, id: rid, url: `/api/documents/${rid}`, name };
      }),
    );
  });
  app.get('/api/documents/:id', protect(), (req, res) => {
    const doc = scoped(db, 'documents', String(req.params.id), req.actor);
    requireThat(documentAccess(req.actor, doc), 'You do not have access to this document.', 403);
    res
      .set('Content-Type', doc.mime)
      .set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`)
      .set('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(doc.content);
  });
  app.get('/api/customers', protect('sales.create'), (req, res) =>
    res.json({
      customers: all(
        db,
        'SELECT * FROM customers WHERE business_id=? ORDER BY name LIMIT 2000',
        req.actor.business_id,
      ),
    }),
  );
  app.post('/api/customers', protect('sales.create'), (req, res) => {
    const b = z
      .object({
        name: z.string().trim().min(2).max(150),
        phone: z.string().max(40).default(''),
        email: z.union([z.literal(''), z.string().email()]).default(''),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(
      mutate(db, req, () => {
        const row = { id: id('cus_'), business_id: req.actor.business_id, ...b, created_at: now() };
        insert(db, 'customers', row);
        audit(
          db,
          req.actor,
          'customer.created',
          'customers',
          row.id,
          null,
          { name: row.name },
          'Customer account created',
        );
        return { ok: true, customer: row };
      }),
    );
  });
}
