/**
 * Workers-safe brand environment variable lookup.
 * Prefers `FICHE_<SUFFIX>` and falls back to legacy `INKLING_<SUFFIX>` so
 * existing deployments and test harnesses keep working without breakage.
 * Zero `node:` imports.
 */

export function readBrandEnv(suffix: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  const ficheVal = process.env[`FICHE_${suffix}`];
  if (ficheVal !== undefined) return ficheVal;
  return process.env[`INKLING_${suffix}`];
}
