-- 004 — Adopt the final KilelePro naming for staff invitations.
--
-- Why this is a migration and not an edit of 001: applied migrations are checksum-locked, and a
-- database that already ran 001 must reach the same shape as one that runs 001..004 in order.
--
-- The table was created as `user_invites` in 001 to mirror the legacy SQLite schema. The product
-- name is `staff_invitations`, served at `/api/staff/invitations`. Renaming now - before any
-- invitation code runs against PostgreSQL - means the temporary name never reaches an API client,
-- a report or an export, so nothing has to be broken later.
--
-- Three details matter and are handled explicitly:
--   1. `ALTER TABLE ... RENAME` does not rename the table's constraints, indexes or triggers, so
--      the auto-generated `user_invites_pkey`, `user_invites_*_fkey` and `idx_invites_*` names
--      would survive and misdescribe the table forever. They are renamed too.
--   2. PostgreSQL 18 names NOT NULL constraints; earlier versions do not. The loop renames
--      whatever exists, so PostgreSQL 16 (CI and Supabase) and 18 reach the same result.
--   3. Everything is guarded and re-runnable: a database where the rename already happened is
--      left alone rather than failing.
--
-- The SQLite ledger keeps `user_invites` and `/api/invites` for now; the data-copy tool must map
-- `user_invites` -> `staff_invitations` (documented in docs/POSTGRES_MIGRATION.md).

DO $$
DECLARE
  constraint_row RECORD;
  index_row RECORD;
  trigger_row RECORD;
BEGIN
  IF to_regclass('user_invites') IS NOT NULL AND to_regclass('staff_invitations') IS NULL THEN
    ALTER TABLE user_invites RENAME TO staff_invitations;
  END IF;

  IF to_regclass('staff_invitations') IS NULL THEN
    RAISE EXCEPTION 'staff_invitations is missing after the rename; refusing to continue';
  END IF;

  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = to_regclass('staff_invitations')
      AND conname LIKE 'user\_invites%'
    ORDER BY conname
  LOOP
    EXECUTE format(
      'ALTER TABLE staff_invitations RENAME CONSTRAINT %I TO %I',
      constraint_row.conname,
      replace(constraint_row.conname, 'user_invites', 'staff_invitations')
    );
  END LOOP;

  FOR index_row IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'staff_invitations'
      AND (indexname LIKE 'user\_invites%' OR indexname LIKE 'idx\_invites%')
    ORDER BY indexname
  LOOP
    EXECUTE format(
      'ALTER INDEX %I RENAME TO %I',
      index_row.indexname,
      replace(replace(index_row.indexname, 'user_invites', 'staff_invitations'), 'idx_invites', 'idx_staff_invitations')
    );
  END LOOP;

  -- The three invitation guards keep their behaviour and their exact error messages; only the
  -- names change, so the protection registry in server/postgres/integrity.ts reads as one scheme.
  FOR trigger_row IN
    SELECT tgname
    FROM pg_trigger
    WHERE tgrelid = to_regclass('staff_invitations')
      AND NOT tgisinternal
      AND tgname LIKE 'invite\_%'
    ORDER BY tgname
  LOOP
    EXECUTE format(
      'ALTER TRIGGER %I ON staff_invitations RENAME TO %I',
      trigger_row.tgname,
      replace(trigger_row.tgname, 'invite_', 'staff_invitation_')
    );
  END LOOP;
END $$;
