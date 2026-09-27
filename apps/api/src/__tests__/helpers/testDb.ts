import knexLib, { type Knex } from "knex";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Migrations directory, resolved from apps/api/src/__tests__/helpers. */
export const migrationsDir = path.resolve(__dirname, "../../../../../packages/db/migrations");

// Arbitrary, stable key for the advisory lock that serializes migrations.
const MIGRATION_LOCK_KEY = 728194;

/**
 * Open a Knex connection to the test database and run `migrate.latest` under a
 * Postgres advisory lock.
 *
 * Vitest runs test files in parallel, so multiple DB-gated integration suites can
 * hit the same test database at once. Each calling `migrate.latest` concurrently
 * races on creating the `knex_migrations` table. A session-level advisory lock —
 * held on a dedicated single-connection Knex instance for the duration of the
 * migration — makes the suites migrate one at a time. Subsequent suites simply
 * find the migrations already applied.
 */
export async function connectAndMigrate(connection: string): Promise<Knex> {
  const locker = knexLib({ client: "pg", connection, pool: { min: 1, max: 1 } });
  await locker.raw("SELECT pg_advisory_lock(?)", [MIGRATION_LOCK_KEY]);
  try {
    const db = knexLib({ client: "pg", connection, migrations: { directory: migrationsDir } });
    await db.migrate.latest();
    return db;
  } finally {
    await locker.raw("SELECT pg_advisory_unlock(?)", [MIGRATION_LOCK_KEY]).catch(() => {});
    await locker.destroy();
  }
}
