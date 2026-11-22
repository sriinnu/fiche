/**
 * Vitest setup file: strips inherited host `FICHE_*` and `INKLING_*` environment
 * variables before any test module is imported so proxy/daemon env overrides on
 * the host never leak into isolated unit/integration tests.
 *
 * Uses `delete process.env[key]` (never `= ''`) because `src/core/env.ts`
 * treats an explicit empty string as a defined override.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('FICHE_') || key.startsWith('INKLING_')) {
    delete process.env[key];
  }
}
