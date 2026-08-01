import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function opener() {
  if (process.env.LIVEDIFF_BROWSER) return process.env.LIVEDIFF_BROWSER;
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "explorer";
  return "xdg-open";
}

/**
 * Launch a browser, resolving to whether it worked. Never throws: a failed launch is worth
 * reporting but never worth failing a command over — the workspace is registered either way.
 */
export async function openBrowser(url) {
  const command = opener();
  try {
    await exec(command, [url]);
    return true;
  } catch {
    // `explorer` exits non-zero even when it succeeds, so its status carries no information.
    // An explicit LIVEDIFF_BROWSER is still reported honestly.
    return process.platform === "win32" && !process.env.LIVEDIFF_BROWSER;
  }
}
