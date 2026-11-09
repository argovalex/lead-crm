// Usage: node scripts/import-gmdss.js <path-to-csv> [--dry-run]
// Needs DATABASE_URL (use `railway run node scripts/import-gmdss.js ...` for the production DB).
// Safe to re-run: rows already present are skipped, never duplicated.
const fs = require('fs');
const { parseCsv, importRows } = require('../src/services/gmdss');

(async () => {
  const file = process.argv[2];
  const dry = process.argv.includes('--dry-run');
  if (!file) { console.error('Usage: node scripts/import-gmdss.js <csv> [--dry-run]'); process.exit(1); }
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (dry) {
    const s = { read: rows.length, noEmail: rows.filter((r) => !r.email).length, noPhone: rows.filter((r) => !r.phone).length };
    console.log('DRY RUN (no database access):', s);
    return;
  }
  const prisma = require('../src/db');
  try {
    console.log('Import result:', await importRows(prisma, rows));
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
