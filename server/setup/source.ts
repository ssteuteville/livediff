import type { IntegrationSource } from "./types.js";

/** GitHub repository that hosts both marketplace catalogs and the portable skill. */
export const INTEGRATION_REPOSITORY = "ssteuteville/livediff";

/** The branch releases promote after npm publication; development branches are never stable. */
export const STABLE_REF = "stable";

/** Overrides every integration source with a local checkout, for testing before publication. */
export const SETUP_SOURCE_ENV = "LIVEDIFF_SETUP_SOURCE";

/** Task 1 confirms the exact per-harness ref syntax; adapters consume only this object. */
export function integrationSource(env: NodeJS.ProcessEnv): IntegrationSource {
  const local = env[SETUP_SOURCE_ENV];
  if (local !== undefined && local !== "") {
    return {
      id: `local:${local}`,
      claudeMarketplace: local,
      codexMarketplace: local,
      codexRef: null,
      skills: local,
    };
  }
  return {
    id: `github:${INTEGRATION_REPOSITORY}@${STABLE_REF}`,
    claudeMarketplace: `https://github.com/${INTEGRATION_REPOSITORY}.git#${STABLE_REF}`,
    codexMarketplace: INTEGRATION_REPOSITORY,
    codexRef: STABLE_REF,
    skills: INTEGRATION_REPOSITORY,
  };
}
