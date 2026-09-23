import { resolve } from "node:path";
import type { IntegrationSource } from "./types.js";

/** GitHub repository that hosts both marketplace catalogs and the portable skill. */
export const INTEGRATION_REPOSITORY = "ssteuteville/livediff";

/** The branch releases promote after npm publication; development branches are never stable. */
export const STABLE_REF = "stable";

/** Overrides every integration source with a local checkout, for testing before publication. */
export const SETUP_SOURCE_ENV = "LIVEDIFF_SETUP_SOURCE";

/**
 * Each harness spells a ref differently (see docs/DISTRIBUTION.md): Claude takes a `#ref`
 * fragment, Codex a separate `--ref`, and the skills installer `#ref` — its `@` selects a skill,
 * not a ref. A local checkout carries no ref at all: Claude rejects `path#ref`.
 */
export function integrationSource(env: NodeJS.ProcessEnv): IntegrationSource {
  const local = env[SETUP_SOURCE_ENV];
  if (local !== undefined && local !== "") {
    const path = resolve(local);
    return {
      id: `local:${path}`,
      claudeMarketplace: path,
      codexMarketplace: path,
      codexRef: null,
      skills: path,
    };
  }
  return {
    id: `github:${INTEGRATION_REPOSITORY}#${STABLE_REF}`,
    claudeMarketplace: `https://github.com/${INTEGRATION_REPOSITORY}.git#${STABLE_REF}`,
    codexMarketplace: INTEGRATION_REPOSITORY,
    codexRef: STABLE_REF,
    skills: `${INTEGRATION_REPOSITORY}#${STABLE_REF}`,
  };
}
