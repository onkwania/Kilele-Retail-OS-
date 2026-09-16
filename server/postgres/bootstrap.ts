import 'dotenv/config';
import { z } from 'zod';
import { id, now, type Actor } from '../core.js';
import { PERMISSIONS, ROLE_NAMES, ROLE_PERMISSIONS } from '../permissions.js';
import { hashPassword } from '../passwords.js';
import { closePool, getPool } from './db.js';
import { insert, one } from './query.js';
import { transaction, type Tx } from './transaction.js';
import { migrate } from './migrate.js';
import { assertProtections } from './integrity.js';
import { actorFor, audit } from './audit.js';

/**
 * First-run bootstrap for a PostgreSQL deployment.
 *
 * It is idempotent in the only sense that is safe for a ledger: the schema and reference data
 * can be re-applied at any time, but a workspace is created exactly once. If the database
 * already contains a user, bootstrap refuses - it will not overwrite, rename or re-seed an
 * existing business. Pointing this at a live database is therefore a no-op or an error, never
 * a destructive migration.
 */

export type BootstrapDetails = { name: string; email: string; password: string; business?: string };

const detailsSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(12),
  business: z.string().min(2),
});

/** Roles, permissions and their mapping - the PostgreSQL form of db.ts's INSERT OR IGNORE seeding. */
export async function seedReferenceData(
  tx: Tx,
): Promise<{ permissions: number; roles: number; rolePermissions: number }> {
  let permissions = 0;
  let roles = 0;
  let rolePermissions = 0;
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    permissions += await insert(
      tx,
      'permissions',
      { id: key, description },
      { onConflict: '(id) DO NOTHING' },
    );
  }
  for (const [key, name] of Object.entries(ROLE_NAMES)) {
    roles += await insert(tx, 'roles', { id: key, name }, { onConflict: '(id) DO NOTHING' });
    for (const permission of ROLE_PERMISSIONS[key]) {
      rolePermissions += await insert(
        tx,
        'role_permissions',
        { role_id: key, permission_id: permission },
        { onConflict: '(role_id, permission_id) DO NOTHING' },
      );
    }
  }
  return { permissions, roles, rolePermissions };
}

export type InitialiseResult = {
  migrations: { applied: string[]; alreadyApplied: number };
  seeded: { permissions: number; roles: number; rolePermissions: number };
  protections: { triggers: number; uniqueIndexes: number; foreignKeys: number; tables: number };
  workspace: 'created' | 'already-present';
  actor: Actor | null;
};

/**
 * Applies migrations, seeds reference data, verifies every financial protection is installed,
 * and creates the owner workspace if - and only if - the database has no users yet.
 */
export async function initialise(details?: BootstrapDetails): Promise<InitialiseResult> {
  const migrations = await migrate();
  const seeded = await transaction((tx) => seedReferenceData(tx));
  const protections = await assertProtections();

  const existing = await one<{ id: string }>(getPool(), 'SELECT id FROM users ORDER BY created_at LIMIT 1');
  if (existing) {
    return {
      migrations: { applied: migrations.applied, alreadyApplied: migrations.skipped.length },
      seeded,
      protections: protections.counts,
      workspace: 'already-present',
      actor: null,
    };
  }
  if (!details) {
    return {
      migrations: { applied: migrations.applied, alreadyApplied: migrations.skipped.length },
      seeded,
      protections: protections.counts,
      workspace: 'already-present',
      actor: null,
    };
  }
  const actor = await createWorkspace(details);
  return {
    migrations: { applied: migrations.applied, alreadyApplied: migrations.skipped.length },
    seeded,
    protections: protections.counts,
    workspace: 'created',
    actor,
  };
}

/** Creates the business, its first branch and the owner user. Mirrors db.ts bootstrap(). */
export async function createWorkspace(details: BootstrapDetails): Promise<Actor> {
  const input = detailsSchema.parse({
    name: details.name,
    email: details.email,
    password: details.password,
    business: details.business ?? 'My beverage business',
  });
  if (await one(getPool(), 'SELECT id FROM users LIMIT 1')) {
    throw new Error('Database is already initialised. Bootstrap is one-time only.');
  }
  return transaction(async (tx) => {
    // Serialises two simultaneous bootstrap attempts; released at COMMIT/ROLLBACK.
    await tx.client.query('SELECT pg_advisory_xact_lock($1)', [7_423_003]);
    if (await one(tx, 'SELECT id FROM users LIMIT 1')) {
      throw new Error('Database is already initialised. Bootstrap is one-time only.');
    }
    const businessId = id('biz_');
    const branchId = id('br_');
    const userId = id('usr_');
    await insert(tx, 'businesses', { id: businessId, name: input.business, created_at: now() });
    await insert(tx, 'branches', {
      id: branchId,
      business_id: businessId,
      name: 'Main branch',
      location: '', // Owner supplies the actual branch location; do not infer an address.
    });
    await insert(tx, 'users', {
      id: userId,
      business_id: businessId,
      branch_id: branchId,
      role_id: 'super_admin',
      name: input.name,
      email: input.email.toLowerCase(),
      password_hash: hashPassword(input.password),
      created_at: now(),
    });
    const actor = await actorFor(tx, userId);
    if (!actor) throw new Error('Bootstrap created the owner but could not load their permissions');
    await audit(
      tx,
      actor,
      'workspace.created',
      'businesses',
      businessId,
      null,
      { name: input.business },
      'Initial owner bootstrap',
    );
    return actor;
  });
}

/** Reads bootstrap credentials from the environment, exactly like server/bootstrap.ts. */
export function detailsFromEnv(env: NodeJS.ProcessEnv = process.env): BootstrapDetails {
  return detailsSchema.parse({
    name: env.BOOTSTRAP_NAME,
    email: env.BOOTSTRAP_EMAIL,
    password: env.BOOTSTRAP_PASSWORD,
    business: env.BUSINESS_NAME,
  });
}

/** CLI entry: bootstrap a workspace, then tell the operator to remove the credentials. */
export async function bootstrapFromEnv(): Promise<InitialiseResult> {
  const details = detailsFromEnv();
  const result = await initialise(details);
  if (result.workspace === 'created') {
    console.log(
      `Workspace created for ${details.email}. Remove bootstrap credentials from your environment.`,
    );
  } else {
    console.log('Database already contains a workspace; nothing was created or changed.');
  }
  await closePool();
  return result;
}
