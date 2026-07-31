import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point XDG_CONFIG_HOME and XDG_STATE_HOME at fresh temp dirs for the duration of `fn`.
 * Tests must never read or write the developer's real livediff state.
 */
export async function withTempXdg(fn) {
  const root = await mkdtemp(join(tmpdir(), "livediff-test-"));
  const config = join(root, "config");
  const state = join(root, "state");
  const prevConfig = process.env.XDG_CONFIG_HOME;
  const prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = config;
  process.env.XDG_STATE_HOME = state;
  try {
    await fn({ config, state, root });
  } finally {
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevConfig;
    if (prevState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevState;
    await rm(root, { recursive: true, force: true });
  }
}
