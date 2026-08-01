import { execFile } from "node:child_process";

/** Best-effort: launching a browser is a convenience, never a reason to fail a command. */
export function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => {});
}
