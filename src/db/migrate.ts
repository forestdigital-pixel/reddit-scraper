import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

const { Pool } = pg;

/**
 * Reads and executes all SQL migration files in order.
 * Migration files are expected in src/db/migrations/ and sorted alphabetically.
 */
async function runMigrations(): Promise<void> {
  dotenv.config();

  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL environment variable is not set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    // Create a migrations tracking table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found.');
      return;
    }

    // Check which migrations have already been applied
    const applied = await pool.query('SELECT filename FROM _migrations');
    const appliedSet = new Set(applied.rows.map((r: { filename: string }) => r.filename));

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`Skipping already applied migration: ${file}`);
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`Applying migration: ${file}`);
      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [file]
        );
        await pool.query('COMMIT');
        console.log(`Migration applied: ${file}`);
      } catch (err) {
        await pool.query('ROLLBACK');
        console.error(`Migration failed: ${file}`, err);
        throw err;
      }
    }

    console.log('All migrations applied successfully.');
  } finally {
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error('Migration runner failed:', err);
  process.exit(1);
});
