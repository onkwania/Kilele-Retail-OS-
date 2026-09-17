import 'dotenv/config';
import { closePool, ping } from './db.js';
import { migrate, pendingMigrations } from './migrate.js';
import { verifyProtections } from './integrity.js';
import { integrity, runIntegrityReport } from './check.js';
import { bootstrapFromEnv, initialise } from './bootstrap.js';

/**
 * Operator CLI for the PostgreSQL ledger:
 *
 *   npm run db:pg:ping        connection round trip and server version
 *   npm run db:pg:migrate     apply every migration in server/postgres/migrations
 *   npm run db:pg:status      list migrations on disk that have not been applied
 *   npm run db:pg:protections verify every trigger/index/type guard is installed
 *   npm run db:pg:check       recompute the ledger and report inconsistencies
 *   npm run db:pg:bootstrap   migrate + seed + create the owner workspace once
 *
 * Every command exits non-zero on failure so a deploy pipeline cannot continue past a
 * database that did not migrate, did not verify, or does not reconcile.
 */

const USAGE = `Usage: tsx server/postgres/cli.ts <ping|migrate|status|protections|check|bootstrap> [--dry-run]`;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main(): Promise<number> {
  const command = process.argv[2];
  switch (command) {
    case 'ping': {
      console.log(JSON.stringify(await ping(), null, 2));
      return 0;
    }
    case 'migrate': {
      const result = await migrate({ dryRun: flag('dry-run') });
      console.log(
        JSON.stringify(
          {
            dryRun: result.dryRun,
            applied: result.applied,
            alreadyApplied: result.skipped.length,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    case 'status': {
      const pending = await pendingMigrations();
      console.log(JSON.stringify({ pending }, null, 2));
      return pending.length && flag('fail-on-pending') ? 1 : 0;
    }
    case 'protections': {
      const report = await verifyProtections();
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    case 'check': {
      const businessId = option('business');
      const branchId = option('branch');
      if ((businessId && !branchId) || (!businessId && branchId)) {
        console.error('--business and --branch must be given together');
        return 2;
      }
      const result =
        businessId && branchId
          ? await integrity({ business_id: businessId, branch_id: branchId })
          : await runIntegrityReport();
      if (businessId && branchId) console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    case 'bootstrap': {
      if (flag('schema-only')) {
        const result = await initialise();
        console.log(
          JSON.stringify({ ...result, actor: result.actor ? { id: result.actor.id } : null }, null, 2),
        );
        return 0;
      }
      await bootstrapFromEnv();
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

main()
  .then(async (code) => {
    await closePool().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
