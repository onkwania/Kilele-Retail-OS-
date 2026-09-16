import type { Express, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import {
  type DB,
  type Actor,
  type Row,
  all,
  audit,
  can,
  id,
  insert,
  now,
  one,
  reasonInput,
  requireThat,
  scoped,
  sha,
} from './core.js';
import { protect, issueSession, sessionCookieOptions } from './auth.js';
import { actorFor } from './db.js';
import { saveUser } from './management.js';
import { ROLE_NAMES } from './permissions.js';

/** Invitations expire so a forwarded or leaked link cannot be redeemed indefinitely. */
export const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 86400_000;
const MAX_OUTSTANDING = 50;
const ADMINISTRATOR_ROLES = ['super_admin', 'admin'];
const inviteRoles = ['super_admin', 'admin', 'accountant', 'cashier', 'inventory'] as const;
const CLOSED_MESSAGE: Record<string, string> = {
  accepted: 'This invitation has already been used to create an account. Sign in instead.',
  revoked: 'This invitation was withdrawn by your administrator. Ask for a new one.',
  expired: 'This invitation has expired. Ask your administrator to send a new one.',
};
const inviteSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z.string().email().max(200),
    role_id: z.enum(inviteRoles),
    reports_access: z.boolean().optional(),
    reason: reasonInput,
  })
  .strict();

export function listInvites(db: DB, a: Actor) {
  return {
    invites: all(
      db,
      `SELECT i.id,i.name,i.email,i.role_id,i.status,i.reason,i.created_at,i.expires_at,i.closed_at,
              i.closed_reason,i.accepted_user_id,i.invited_by,u.name invited_by_name
       FROM user_invites i LEFT JOIN users u ON u.id=i.invited_by
       WHERE i.business_id=? AND i.branch_id=? ORDER BY i.created_at DESC LIMIT 500`,
      a.business_id,
      a.branch_id,
    ).map((i) => ({ ...i, open: i.status === 'pending' && i.expires_at > now() })),
    roles: ROLE_NAMES,
    ttl_days: INVITE_TTL_DAYS,
  };
}

/** Close a pending invitation. The row is never deleted and its terms are never edited. */
function close(db: DB, invite: Row, status: 'accepted' | 'revoked' | 'expired', reason: string, userId = '') {
  db.prepare(
    'UPDATE user_invites SET status=?,closed_at=?,closed_reason=?,accepted_user_id=? WHERE id=? AND status=?',
  ).run(status, now(), reason, userId || null, invite.id, 'pending');
}

/**
 * Create an invitation. The bearer token is returned exactly once and only its hash is stored, so a
 * database copy cannot be used to sign somebody in. Any older pending invitation for the same email
 * address is withdrawn first, which also makes a double submission settle on one live invitation.
 */
export function createInvite(db: DB, a: Actor, input: unknown) {
  requireThat(can(a, 'staff.write'), 'You do not have permission for this action.', 403);
  const b = inviteSchema.parse(input),
    email = b.email.toLowerCase();
  requireThat(
    !one(db, 'SELECT id FROM users WHERE email=? COLLATE NOCASE', email),
    'An account already exists for that email address. Reset their password instead of inviting them.',
    409,
  );
  requireThat(
    a.role_id === 'super_admin' || !ADMINISTRATOR_ROLES.includes(b.role_id),
    'Only the super administrator may invite administrator accounts.',
    403,
  );
  const outstanding = one(
    db,
    "SELECT COUNT(*) n FROM user_invites WHERE business_id=? AND branch_id=? AND status='pending' AND expires_at>?",
    a.business_id,
    a.branch_id,
    now(),
  )!.n;
  requireThat(
    outstanding < MAX_OUTSTANDING,
    `At most ${MAX_OUTSTANDING} invitations can be outstanding. Withdraw some first.`,
    409,
  );
  return db
    .transaction(() => {
      for (const previous of all(
        db,
        "SELECT * FROM user_invites WHERE business_id=? AND branch_id=? AND email=? COLLATE NOCASE AND status='pending'",
        a.business_id,
        a.branch_id,
        email,
      )) {
        close(db, previous, 'revoked', 'Replaced by a newer invitation for the same email address');
        audit(
          db,
          a,
          'staff.invite_revoked',
          'user_invites',
          previous.id,
          { status: 'pending' },
          { status: 'revoked' },
          'Replaced by a newer invitation for the same email address',
        );
      }
      const token = randomBytes(32).toString('base64url'),
        inviteId = id('inv_'),
        expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
      insert(db, 'user_invites', {
        id: inviteId,
        business_id: a.business_id,
        branch_id: a.branch_id,
        name: b.name,
        email,
        role_id: b.role_id,
        reports_access:
          b.role_id === 'accountant' && b.reports_access !== undefined ? (b.reports_access ? 1 : 0) : null,
        token_hash: sha(token),
        status: 'pending',
        invited_by: a.id,
        reason: b.reason,
        created_at: now(),
        expires_at: expiresAt,
      });
      // The token is deliberately absent from the audit payload: it is a secret, shown once.
      audit(
        db,
        a,
        'staff.invite_created',
        'user_invites',
        inviteId,
        null,
        {
          name: b.name,
          email,
          role_id: b.role_id,
          expires_at: expiresAt,
          token_stored: 'hash only',
        },
        b.reason,
      );
      return {
        ok: true,
        id: inviteId,
        name: b.name,
        email,
        role_id: b.role_id,
        role_name: ROLE_NAMES[b.role_id] ?? b.role_id,
        token,
        accept_path: `/invite/${token}`,
        created_at: now(),
        expires_at: expiresAt,
      };
    })
    .immediate();
}

export function revokeInvite(db: DB, a: Actor, inviteId: string, input: unknown) {
  requireThat(can(a, 'staff.write'), 'You do not have permission for this action.', 403);
  const b = z.object({ reason: reasonInput }).strict().parse(input);
  return db
    .transaction(() => {
      const invite = scoped(db, 'user_invites', inviteId, a);
      requireThat(
        invite.status === 'pending',
        CLOSED_MESSAGE[invite.status] ?? 'This invitation is closed.',
        409,
      );
      requireThat(
        a.role_id === 'super_admin' || !ADMINISTRATOR_ROLES.includes(invite.role_id),
        'Only the super administrator may withdraw an administrator invitation.',
        403,
      );
      close(db, invite, 'revoked', b.reason);
      audit(
        db,
        a,
        'staff.invite_revoked',
        'user_invites',
        invite.id,
        { status: 'pending', email: invite.email, role_id: invite.role_id },
        { status: 'revoked' },
        b.reason,
      );
      return { ok: true, id: invite.id, status: 'revoked' };
    })
    .immediate();
}

/** Resolve a bearer token to a still-redeemable invitation, marking it expired if the clock passed it. */
function openInvite(db: DB, token: string) {
  requireThat(
    typeof token === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(token),
    'This invitation link is not valid.',
    404,
  );
  const invite = one(db, 'SELECT * FROM user_invites WHERE token_hash=?', sha(token));
  requireThat(invite, 'This invitation link is not valid. Ask your administrator to send a new one.', 404);
  if (invite.status === 'pending' && invite.expires_at <= now()) {
    db.transaction(() => close(db, invite, 'expired', 'The invitation expired before it was accepted'))();
    invite.status = 'expired';
  }
  requireThat(
    invite.status === 'pending',
    CLOSED_MESSAGE[invite.status] ?? 'This invitation is no longer available.',
    410,
  );
  return invite;
}

/** What an unauthenticated invitee is allowed to see before choosing a password. No token, no IDs. */
export function invitePreview(db: DB, token: string) {
  const invite = openInvite(db, token),
    business = one(db, 'SELECT name FROM businesses WHERE id=?', invite.business_id),
    branch = one(db, 'SELECT name,location FROM branches WHERE id=?', invite.branch_id);
  return {
    name: invite.name,
    email: invite.email,
    role_id: invite.role_id,
    role_name: ROLE_NAMES[invite.role_id] ?? invite.role_id,
    business: business?.name ?? '',
    branch: branch?.name ?? '',
    location: branch?.location ?? '',
    expires_at: invite.expires_at,
    min_password_length: 12,
  };
}

/**
 * Redeem an invitation. The account is created inside the same transaction that closes the invitation,
 * so a token can never mint two users. Authority is re-checked against the inviter's CURRENT role: an
 * administrator who was demoted or deactivated after sending an invitation cannot have it honoured.
 */
export function acceptInvite(db: DB, token: string, input: unknown, meta: { ip?: string; device?: string }) {
  const b = z
    .object({ password: z.string().min(12).max(200), confirm: z.string().min(12).max(200) })
    .strict()
    .parse(input);
  requireThat(b.password === b.confirm, 'The two passwords do not match.', 400);
  return db
    .transaction(() => {
      const invite = openInvite(db, token);
      requireThat(
        !one(db, 'SELECT id FROM users WHERE email=? COLLATE NOCASE', invite.email),
        'An account already exists for this email address. Sign in, or ask your administrator to reset the password.',
        409,
      );
      const inviter = one(db, 'SELECT * FROM users WHERE id=?', invite.invited_by),
        actor = inviter?.active ? actorFor(db, inviter.id) : null;
      requireThat(
        actor && can(actor, 'staff.write'),
        'The person who invited you no longer manages staff access. Ask an administrator for a new invitation.',
        403,
      );
      // An invitation belongs to the branch that issued it, even if the inviter has since moved.
      requireThat(
        actor!.business_id === invite.business_id && actor!.branch_id === invite.branch_id,
        'This invitation was issued for a different branch. Ask an administrator there to send a new one.',
        403,
      );
      requireThat(
        actor!.role_id === 'super_admin' || !ADMINISTRATOR_ROLES.includes(invite.role_id),
        'Only the super administrator may create administrator accounts. Ask for a new invitation.',
        403,
      );
      const onBehalf: Actor = { ...actor!, ip: meta.ip, device: meta.device },
        created = saveUser(
          db,
          onBehalf,
          {
            name: invite.name,
            email: invite.email,
            role_id: invite.role_id,
            active: true,
            // The password the invited person just chose; the administrator never sees or sets it.
            password: b.password,
            ...(invite.reports_access === null ? {} : { reports_access: !!invite.reports_access }),
            reason: `Invitation accepted: ${invite.reason}`.slice(0, 2000),
          },
          undefined,
          'invitation',
        );
      // The invited person chose this password themselves, so no temporary-password change is owed.
      db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(created.id);
      close(
        db,
        invite,
        'accepted',
        'The invited person created their account and chose their own password',
        created.id,
      );
      audit(
        db,
        onBehalf,
        'staff.invite_accepted',
        'users',
        created.id,
        null,
        {
          invite_id: invite.id,
          role_id: invite.role_id,
          must_change_password: false,
          password_chosen_by: 'invited person',
        },
        'Invitation redeemed; account created with a self-chosen password',
      );
      return { ok: true, id: created.id };
    })
    .immediate();
}

export function installInvites(app: Express, db: DB, options: { preview: boolean; production: boolean }) {
  const cookieOptions = sessionCookieOptions(options);
  // Public, unauthenticated and token-bearing: throttle it far below the authenticated API budget.
  const inviteLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 12,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts on this invitation link. Try again in 15 minutes.' },
  });
  app.get('/api/invites', protect('staff.read'), (req, res) => res.json(listInvites(db, req.actor)));
  app.post('/api/invites', protect('staff.write'), (req, res) =>
    res.status(201).json(createInvite(db, req.actor, req.body)),
  );
  app.post('/api/invites/:id/revoke', protect('staff.write'), (req, res) =>
    res.json(revokeInvite(db, req.actor, String(req.params.id), req.body)),
  );
  app.get('/api/public/invite/:token', inviteLimit, (req, res) =>
    res.json(invitePreview(db, String(req.params.token))),
  );
  app.post('/api/public/invite/:token/accept', inviteLimit, (req: Request, res: Response) => {
    const meta = { ip: req.ip, device: String(req.headers['user-agent'] ?? '') },
      created = acceptInvite(db, String(req.params.token), req.body, meta),
      csrf = issueSession(db, req, res, created.id, cookieOptions),
      user = actorFor(db, created.id)!;
    // A lockout recorded against this address before the account existed must not lock out its new owner.
    db.prepare('DELETE FROM login_attempts WHERE email=?').run(user.email);
    audit(
      db,
      { ...user, ...meta },
      'auth.invite_session',
      'users',
      user.id,
      null,
      null,
      'Signed in immediately after accepting an invitation',
    );
    res.json({ ok: true, csrf, user });
  });
}
