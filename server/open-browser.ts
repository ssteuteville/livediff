import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";

const exec = promisify(execFile);

/**
 * The command that turns a URL into something the user can look at, as argv.
 *
 * LIVEDIFF_BROWSER may carry arguments — `cmux open-window`, `code --open-url`, `wezterm start` —
 * so it is split rather than treated as a single binary name. It is deliberately split on
 * whitespace instead of run through a shell: this is a "where do I open things" setting, not a
 * place to want globbing or pipelines, and no shell means no quoting surprises around the URL.
 */
type CommandArgv = [command: string, ...args: string[]];

function openerArgv(): CommandArgv {
  const configured = loadConfig().browser.opener;
  if (configured) {
    const command = configured[0];
    if (command === undefined) throw new Error("browser opener must name an executable");
    const args = configured.slice(1);
    return [command, ...args];
  }
  if (process.platform === "darwin") return ["open"];
  if (process.platform === "win32") return ["explorer"];
  return ["xdg-open"];
}

/**
 * Launch a browser, resolving to whether it worked. Never throws: a failed launch is worth
 * reporting but never worth failing a command over — the workspace is registered either way.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const configured = loadConfig().browser.opener;
  const [command, ...args] = openerArgv();
  try {
    await exec(command, [...args, url]);
    return true;
  } catch {
    // `explorer` exits non-zero even when it succeeds, so its status carries no information.
    // An explicit LIVEDIFF_BROWSER is still reported honestly.
    return process.platform === "win32" && configured === null;
  }
}
