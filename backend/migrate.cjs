#!/usr/bin/env node

import('./scripts/migrateLegacySqliteToPostgres.mjs')
  .then(({ runLegacyMigration }) => runLegacyMigration())
  .catch((err) => {
  console.error(`Legacy migration refused or failed: ${err.message}`);
  process.exitCode = 1;
});
