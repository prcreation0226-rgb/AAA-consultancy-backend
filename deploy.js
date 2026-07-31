/**
 * deploy.js — Railway Production Startup Script
 *
 * Handles the P3005 "database schema is not empty" Prisma error.
 * When the DB was originally created with `prisma db push` (no migration history),
 * `prisma migrate deploy` refuses to run. This script:
 *   1. Creates the _prisma_migrations table if missing
 *   2. Applies Phase 2 SQL if the new columns don't exist yet
 *   3. Records the migration as applied
 *   4. Starts the Express server
 */

'use strict';

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATION_NAME = '20260731000000_phase2_resubmission_flow';
const MIGRATION_SQL_PATH = path.join(
  __dirname,
  'prisma/migrations',
  MIGRATION_NAME,
  'migration.sql'
);

const prisma = new PrismaClient();

async function ensureMigrationsTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`_prisma_migrations\` (
      \`id\`                  VARCHAR(36)  NOT NULL,
      \`checksum\`            VARCHAR(64)  NOT NULL,
      \`finished_at\`         DATETIME(3)  NULL,
      \`migration_name\`      VARCHAR(255) NOT NULL,
      \`logs\`                TEXT         NULL,
      \`rolled_back_at\`      DATETIME(3)  NULL,
      \`started_at\`          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`applied_steps_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (\`id\`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);
}

async function isMigrationApplied() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS cnt FROM \`_prisma_migrations\`
     WHERE migration_name = ? AND finished_at IS NOT NULL`,
    MIGRATION_NAME
  );
  return Number(rows[0].cnt) > 0;
}

async function columnExists(table, column) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name   = ?
       AND column_name  = ?`,
    table,
    column
  );
  return Number(rows[0].cnt) > 0;
}

async function tableExists(table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name   = ?`,
    table
  );
  return Number(rows[0].cnt) > 0;
}

async function applyPhase2SQL() {
  const sql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');

  // Split on semicolons, skip blank lines and comment-only lines
  const statements = sql
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    // Skip pure comment blocks
    const nonComment = stmt.replace(/--[^\n]*/g, '').trim();
    if (!nonComment) continue;
    try {
      await prisma.$executeRawUnsafe(stmt);
    } catch (err) {
      // "Duplicate column" / "already exists" errors are safe to ignore
      if (
        err.message.includes('Duplicate column') ||
        err.message.includes('already exists') ||
        err.message.includes("Can't DROP") ||
        err.message.includes('already has')
      ) {
        console.log(`[Deploy] Skipping (already applied): ${nonComment.substring(0, 80)}...`);
      } else {
        throw err;
      }
    }
  }
}

async function recordMigration() {
  const id  = crypto.randomUUID();
  const now = new Date();
  await prisma.$executeRawUnsafe(
    `INSERT INTO \`_prisma_migrations\`
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES (?, 'phase2-baseline-manual', ?, ?, NULL, NULL, ?, 1)`,
    id, now, MIGRATION_NAME, now
  );
}

async function main() {
  console.log('[Deploy] ===== AAA Backend Startup =====');
  console.log('[Deploy] Checking Phase 2 migration status...');

  try {
    await ensureMigrationsTable();
    console.log('[Deploy] _prisma_migrations table: OK');

    const alreadyApplied = await isMigrationApplied();

    if (alreadyApplied) {
      console.log('[Deploy] Phase 2 migration already applied. Nothing to do.');
    } else {
      // Check if the key Phase 2 column already exists in DB
      // (e.g. if someone ran db push previously)
      const hasChecklistItemId = await columnExists('documents', 'checklistItemId');
      const hasChecklistTable  = await tableExists('resubmission_checklist_items');

      if (hasChecklistItemId && hasChecklistTable) {
        console.log('[Deploy] Phase 2 columns already exist in DB (prior db push). Recording migration baseline only.');
      } else {
        console.log('[Deploy] Applying Phase 2 migration SQL...');
        await applyPhase2SQL();
        console.log('[Deploy] Phase 2 SQL applied successfully.');
      }

      await recordMigration();
      console.log('[Deploy] Migration recorded in _prisma_migrations.');
    }
  } catch (err) {
    console.error('[Deploy] Migration failed:', err.message);
    console.error('[Deploy] Proceeding to start server anyway...');
  } finally {
    await prisma.$disconnect();
  }

  console.log('[Deploy] Starting Express server...');
  require('./src/app');
}

main();
