import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { fixture, addUser } from './helpers.js';
import { createApp } from '../server/app.js';
import { INVITE_TTL_DAYS } from '../server/invites.js';
import { one, all, id, insert, now, sha, integrity, type DB } from '../server/core.js';

/**
 * Staff invitations: an administrator names a person and a role, the system mints a single-use
 * expiring link, and the invited person creates their own account and password. These tests cover
 * the authority rules, the token lifecycle and the guarantee that no financial record is touched.
 */
let db: DB;
afterEach(() => {
  db?.close();
});
const reason = 'Synthetic onboarding invitation used only in this isolated test';
const strongPassword = 'invitee-chosen-passphrase';
const auth = async (app: ReturnType<typeof createApp>, email: string) => {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send({ email, password: 'test-password-strong' });
  expect(r.status, `sign in ${email}`).toBe(200);
  return { agent, csrf: r.body.csrf };
};
const get = (user: Awaited<ReturnType<typeof auth>>, path: string) =>
  user.agent.get('/api' + path).set('X-CSRF-Token', user.csrf);
const post = (user: Awaited<ReturnType<typeof auth>>, path: string, body?: object) =>
  user.agent
    .post('/api' + path)
    .set('X-CSRF-Token', user.csrf)
    .send(body ?? {});
const publicGet = (app: ReturnType<typeof createApp>, path: string) => request(app).get('/api' + path);
const publicPost = (app: ReturnType<typeof createApp>, path: string, body?: object) =>
  request(app)
    .post('/api' + path)
    .send(body ?? {});
/** Seed an invitation row directly so lifecycle edges can be tested without waiting or faking clocks. */
function seedInvite(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const token = `seed-${id('').replaceAll('-', '')}`,
    row = {
      id: id('inv_'),
      business_id: f.a.business_id,
      branch_id: f.a.branch_id,
      name: 'Seeded Person',
      email: `seeded-${Math.random().toString(36).slice(2, 8)}@test.co.ke`,
      role_id: 'cashier',
      token_hash: sha(token),
      status: 'pending',
      invited_by: f.a.id,
      reason,
      created_at: now(),
      expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString(),
      ...overrides,
    };
  insert(db, 'user_invites', row);
  return { token, row };
}

describe('Staff invitations', () => {
  it('creates a pending invitation and stores only the token hash', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a.email),
      r = await post(owner, '/invites', {
        name: 'Jane Wanjiru',
        email: 'jane@test.co.ke',
        role_id: 'cashier',
        reason,
      });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.accept_path).toBe(`/invite/${r.body.token}`);
    expect(r.body.role_name).toBe('Cashier');
    expect(
      new Date(r.body.expires_at).getTime() - Date.now(),
      'invitation expires in about the documented window',
    ).toBeGreaterThan((INVITE_TTL_DAYS - 1) * 86400_000);
    // No account exists yet: an invitation is a promise, not a user.
    expect(one(db, "SELECT id FROM users WHERE email='jane@test.co.ke'")).toBeUndefined();
    const stored = one(db, 'SELECT * FROM user_invites')!;
    expect(stored.token_hash).toBe(sha(r.body.token));
    expect(JSON.stringify(all(db, 'SELECT * FROM user_invites'))).not.toContain(r.body.token);
    expect(JSON.stringify(all(db, 'SELECT * FROM audit_logs'))).not.toContain(r.body.token);
    const list = await get(owner, '/invites');
    expect(list.status).toBe(200);
    expect(list.body.invites).toHaveLength(1);
    expect(list.body.invites[0]).toMatchObject({
      email: 'jane@test.co.ke',
      role_id: 'cashier',
      status: 'pending',
      open: true,
    });
    expect(JSON.stringify(list.body)).not.toContain('token_hash');
    expect(one(db, "SELECT action FROM audit_logs WHERE action='staff.invite_created'")).toBeTruthy();
    expect(integrity(db).ok).toBe(true);
  });

  it('lets the invited person preview the offer, accept it and sign in with exactly the assigned role', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a.email),
      created = await post(owner, '/invites', {
        name: 'Jane Wanjiru',
        email: 'jane@test.co.ke',
        role_id: 'cashier',
        reason,
      }),
      token = created.body.token;
    const preview = await publicGet(app, `/public/invite/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      name: 'Jane Wanjiru',
      email: 'jane@test.co.ke',
      role_name: 'Cashier',
      min_password_length: 12,
    });
    expect(JSON.stringify(preview.body)).not.toContain(token);
    expect(preview.body.invited_by).toBeUndefined();
    const accepted = await publicPost(app, `/public/invite/${token}/accept`, {
      password: strongPassword,
      confirm: strongPassword,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.user.email).toBe('jane@test.co.ke');
    const user = one(db, "SELECT * FROM users WHERE email='jane@test.co.ke'")!;
    expect(user.role_id).toBe('cashier');
    expect(user.active).toBe(1);
    // They chose this password themselves, so no temporary-password gate is owed.
    expect(user.must_change_password).toBe(0);
    expect(user.business_id).toBe(f.a.business_id);
    expect(user.branch_id).toBe(f.a.branch_id);
    const invite = one(db, 'SELECT * FROM user_invites WHERE id=?', created.body.id)!;
    expect(invite.status).toBe('accepted');
    expect(invite.accepted_user_id).toBe(user.id);
    expect(invite.closed_at).toBeTruthy();
    // The issued session is a real one: same cookie, same CSRF discipline, same role limits.
    const session = request.agent(app);
    await session.post('/api/auth/login').send({ email: 'jane@test.co.ke', password: strongPassword });
    expect((await session.get('/api/auth/me')).body.user.role_id).toBe('cashier');
    expect((await session.get('/api/products')).status).toBe(200);
    expect((await session.get('/api/staff')).status).toBe(403);
    expect(accepted.headers['set-cookie'][0]).toContain('HttpOnly');
    const actions = all(db, 'SELECT action FROM audit_logs').map((r) => r.action);
    for (const expected of [
      'staff.invite_created',
      'staff.created',
      'staff.invite_accepted',
      'auth.invite_session',
    ])
      expect(actions, expected).toContain(expected);
    expect(integrity(db).ok).toBe(true);
  });

  it('refuses to redeem a token twice, after withdrawal, after expiry, or when forged', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a.email);
    const first = await post(owner, '/invites', {
      name: 'Jane Wanjiru',
      email: 'jane@test.co.ke',
      role_id: 'cashier',
      reason,
    });
    const accept = (token: string) =>
      publicPost(app, `/public/invite/${token}/accept`, {
        password: strongPassword,
        confirm: strongPassword,
      });
    expect((await accept(first.body.token)).status).toBe(200);
    const replay = await accept(first.body.token);
    expect(replay.status).toBe(410);
    expect(replay.body.error).toMatch(/already been used/i);
    expect(all(db, "SELECT id FROM users WHERE email='jane@test.co.ke'")).toHaveLength(1);
    // Withdrawn invitation.
    const second = await post(owner, '/invites', {
      name: 'Peter Otieno',
      email: 'peter@test.co.ke',
      role_id: 'inventory',
      reason,
    });
    const revoked = await post(owner, `/invites/${second.body.id}/revoke`, {
      reason: 'Role changed before the invitation was accepted',
    });
    expect(revoked.status).toBe(200);
    const afterRevoke = await accept(second.body.token);
    expect(afterRevoke.status).toBe(410);
    expect(afterRevoke.body.error).toMatch(/withdrawn/i);
    expect(one(db, "SELECT id FROM users WHERE email='peter@test.co.ke'")).toBeUndefined();
    // Expired invitation is closed on first sight of it.
    const expired = seedInvite(f, {
      email: 'late@test.co.ke',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect((await publicGet(app, `/public/invite/${expired.token}`)).status).toBe(410);
    expect(one(db, 'SELECT status FROM user_invites WHERE id=?', expired.row.id)!.status).toBe('expired');
    expect((await accept(expired.token)).status).toBe(410);
    // Forged, unknown and malformed tokens never reach a user row.
    expect((await publicGet(app, `/public/invite/${'A'.repeat(43)}`)).status).toBe(404);
    expect((await accept('A'.repeat(43))).status).toBe(404);
    expect((await accept('short')).status).toBe(404);
    expect(all(db, 'SELECT id FROM users').length, 'only the fixture owner and one accepted invitee').toBe(2);
    expect(integrity(db).ok).toBe(true);
  });

  it('keeps administrator invitations reserved to the super administrator, on issue and on acceptance', async () => {
    const f = fixture();
    db = f.db;
    const manager = addUser(db, f.a, 'admin', 'Branch Manager'),
      app = createApp(db),
      owner = await auth(app, f.a.email),
      boss = await auth(app, manager.email);
    for (const role of ['admin', 'super_admin'])
      expect(
        (
          await post(boss, '/invites', {
            name: 'Escalation',
            email: `x-${role}@test.co.ke`,
            role_id: role,
            reason,
          })
        ).status,
        `administrator may not invite ${role}`,
      ).toBe(403);
    expect(
      (
        await post(boss, '/invites', {
          name: 'Mary Akinyi',
          email: 'mary@test.co.ke',
          role_id: 'cashier',
          reason,
        })
      ).status,
      'administrator may invite ordinary staff',
    ).toBe(201);
    const supervisor = await post(owner, '/invites', {
      name: 'Supervisor One',
      email: 'supervisor@test.co.ke',
      role_id: 'admin',
      reason,
    });
    expect(supervisor.status).toBe(201);
    expect(
      (
        await post(boss, `/invites/${supervisor.body.id}/revoke`, {
          reason: 'Attempted withdrawal by an administrator',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(owner, `/invites/${supervisor.body.id}/revoke`, {
          reason: 'Withdrawn by the super administrator',
        })
      ).status,
    ).toBe(200);
    // Authority is re-checked at acceptance against the inviter's CURRENT role.
    const pending = await post(owner, '/invites', {
      name: 'Supervisor Two',
      email: 'supervisor2@test.co.ke',
      role_id: 'admin',
      reason,
    });
    db.prepare('UPDATE users SET role_id=? WHERE id=?').run('admin', f.a.id);
    const demoted = await publicPost(app, `/public/invite/${pending.body.token}/accept`, {
      password: strongPassword,
      confirm: strongPassword,
    });
    expect(demoted.status).toBe(403);
    expect(demoted.body.error).toMatch(/super administrator/i);
    db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.a.id);
    const deactivated = await publicPost(app, `/public/invite/${pending.body.token}/accept`, {
      password: strongPassword,
      confirm: strongPassword,
    });
    expect(deactivated.status).toBe(403);
    expect(deactivated.body.error).toMatch(/no longer manages staff access/i);
    expect(one(db, "SELECT id FROM users WHERE email='supervisor2@test.co.ke'")).toBeUndefined();
    expect(one(db, 'SELECT status FROM user_invites WHERE id=?', pending.body.id)!.status).toBe('pending');
    expect(integrity(db).ok).toBe(true);
  });

  it('denies invitations to staff without access rights and never crosses branch boundaries', async () => {
    const f = fixture();
    db = f.db;
    const cashier = addUser(db, f.a, 'cashier', 'Till Operator'),
      accountant = addUser(db, f.a, 'accountant', 'Books Keeper'),
      app = createApp(db);
    for (const person of [cashier, accountant]) {
      const session = await auth(app, person.email);
      expect((await get(session, '/invites')).status, `${person.role_id} list`).toBe(403);
      expect(
        (
          await post(session, '/invites', {
            name: 'Nobody',
            email: 'nobody@test.co.ke',
            role_id: 'cashier',
            reason,
          })
        ).status,
        `${person.role_id} create`,
      ).toBe(403);
    }
    const owner = await auth(app, f.a.email),
      mine = await post(owner, '/invites', {
        name: 'Jane Wanjiru',
        email: 'jane@test.co.ke',
        role_id: 'cashier',
        reason,
      }),
      otherBranch = id('br_');
    insert(db, 'branches', {
      id: otherBranch,
      business_id: f.a.business_id,
      name: 'Second branch',
      location: '',
    });
    const elsewhere = seedInvite(f, { branch_id: otherBranch, email: 'other-branch@test.co.ke' });
    const list = await get(owner, '/invites');
    expect(list.body.invites.map((i: any) => i.id)).toEqual([mine.body.id]);
    expect(list.body.invites.map((i: any) => i.id)).not.toContain(elsewhere.row.id);
    expect(
      (await post(owner, `/invites/${elsewhere.row.id}/revoke`, { reason: 'Attempt across branch boundary' }))
        .status,
    ).toBe(404);
    // A token issued for another branch cannot be redeemed here, even by the person who seeded it.
    const elsewhereAccepted = await publicPost(app, `/public/invite/${elsewhere.token}/accept`, {
      password: strongPassword,
      confirm: strongPassword,
    });
    expect(elsewhereAccepted.status).toBe(403);
    expect(elsewhereAccepted.body.error).toMatch(/branch/i);
    expect(one(db, "SELECT id FROM users WHERE email='other-branch@test.co.ke'")).toBeUndefined();
    expect(one(db, 'SELECT status FROM user_invites WHERE id=?', elsewhere.row.id)!.status).toBe('pending');
    expect(integrity(db).ok).toBe(true);
  });

  it('replaces a duplicate pending invitation and refuses emails that already hold an account', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a.email);
    const inviteBody = { name: 'Jane Wanjiru', email: 'jane@test.co.ke', role_id: 'cashier', reason };
    expect(
      (await post(owner, '/invites', { ...inviteBody, email: f.a.email.toLowerCase() })).status,
      'existing account',
    ).toBe(409);
    const first = await post(owner, '/invites', inviteBody);
    expect(first.status).toBe(201);
    const second = await post(owner, '/invites', { ...inviteBody, role_id: 'inventory' });
    expect(second.status).toBe(201);
    expect(
      all(db, "SELECT id FROM user_invites WHERE email='jane@test.co.ke' AND status='pending'"),
      'one live invitation per email address',
    ).toHaveLength(1);
    expect(one(db, 'SELECT status FROM user_invites WHERE id=?', first.body.id)!.status).toBe('revoked');
    const stale = await publicPost(app, `/public/invite/${first.body.token}/accept`, {
      password: strongPassword,
      confirm: strongPassword,
    });
    expect(stale.status).toBe(410);
    // Acceptance fails safely if an account appeared after the invitation was sent.
    addUser(db, f.a, 'cashier', 'Jane Wanjiru');
    db.prepare('UPDATE users SET email=? WHERE name=?').run('jane@test.co.ke', 'Jane Wanjiru');
    const raced = await publicPost(app, `/public/invite/${second.body.token}/accept`, {
      password: strongPassword,
      confirm: strongPassword,
    });
    expect(raced.status).toBe(409);
    expect(one(db, 'SELECT status FROM user_invites WHERE id=?', second.body.id)!.status).toBe('pending');
    expect(all(db, "SELECT id FROM users WHERE email='jane@test.co.ke'")).toHaveLength(1);
    expect(integrity(db).ok).toBe(true);
  });

  it('validates the invitation form, the chosen password and refuses a short reason or unknown role', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a.email),
      valid = { name: 'Jane Wanjiru', email: 'jane@test.co.ke', role_id: 'cashier', reason };
    for (const body of [
      { ...valid, reason: 'no' },
      { ...valid, role_id: 'supervisor' },
      { ...valid, name: 'J' },
      { ...valid, email: 'not-an-email' },
      { ...valid, branch_id: id('br_') },
      { ...valid, role_id: 'cashier', password: 'should-not-be-accepted' },
    ])
      expect((await post(owner, '/invites', body)).status, JSON.stringify(body)).toBe(400);
    const created = await post(owner, '/invites', valid);
    expect(created.status).toBe(201);
    const accept = (body: object) => publicPost(app, `/public/invite/${created.body.token}/accept`, body);
    for (const body of [
      { password: 'short', confirm: 'short' },
      { password: strongPassword, confirm: 'a-different-passphrase' },
      { password: strongPassword },
      { password: strongPassword, confirm: strongPassword, role_id: 'super_admin' },
      { password: strongPassword, confirm: strongPassword, email: 'someone-else@test.co.ke' },
    ])
      expect((await accept(body)).status, JSON.stringify(body)).toBe(400);
    expect(one(db, "SELECT id FROM users WHERE email='jane@test.co.ke'")).toBeUndefined();
    expect(one(db, 'SELECT role_id FROM user_invites WHERE id=?', created.body.id)!.role_id).toBe('cashier');
    // The role and email on the invitation cannot be edited after issue.
    expect(() =>
      db.prepare("UPDATE user_invites SET role_id='super_admin' WHERE id=?").run(created.body.id),
    ).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM user_invites WHERE id=?').run(created.body.id)).toThrow(
      /cannot be deleted/,
    );
    expect((await post(owner, `/invites/${created.body.id}/revoke`, { reason: 'no' })).status).toBe(400);
    expect(integrity(db).ok).toBe(true);
  });

  it('carries the accountant report-access override through to the created account', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a.email),
      created = await post(owner, '/invites', {
        name: 'Grace Achieng',
        email: 'grace@test.co.ke',
        role_id: 'accountant',
        reports_access: false,
        reason,
      });
    expect(created.status).toBe(201);
    const accepted = await publicPost(app, `/public/invite/${created.body.token}/accept`, {
      password: strongPassword,
      confirm: strongPassword,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.user.permissions).not.toContain('reports.read');
    expect(accepted.body.user.permissions).toContain('reports.inventory');
    expect(
      one(
        db,
        "SELECT allowed FROM user_permissions WHERE user_id=? AND permission_id='reports.read'",
        accepted.body.user.id,
      )!.allowed,
    ).toBe(0);
    expect(integrity(db).ok).toBe(true);
  });

  it('leaves every financial record untouched while provisioning people', async () => {
    const f = fixture();
    db = f.db;
    const app = createApp(db),
      owner = await auth(app, f.a.email),
      before = one(db, 'SELECT COUNT(*) n FROM journal_lines')!.n,
      stockBefore = one(db, 'SELECT quantity,value_cents FROM inventory WHERE product_id=?', f.p.id);
    for (const [index, role] of ['cashier', 'inventory', 'accountant', 'admin'].entries()) {
      const created = await post(owner, '/invites', {
        name: `Team Member ${index}`,
        email: `team-${index}@test.co.ke`,
        role_id: role,
        ...(role === 'accountant' ? { reports_access: true } : {}),
        reason,
      });
      expect(created.status).toBe(201);
      expect(
        (
          await publicPost(app, `/public/invite/${created.body.token}/accept`, {
            password: strongPassword,
            confirm: strongPassword,
          })
        ).status,
      ).toBe(200);
    }
    expect(one(db, 'SELECT COUNT(*) n FROM journal_lines')!.n).toBe(before);
    expect(one(db, 'SELECT quantity,value_cents FROM inventory WHERE product_id=?', f.p.id)).toEqual(
      stockBefore,
    );
    expect(all(db, "SELECT id FROM users WHERE role_id='admin'")).toHaveLength(1);
    const result = integrity(db);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
