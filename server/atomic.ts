import { writeFile, rename, mkdir, rm } from "node:fs/promises";
import { ID_LENGTH } from "./constants.js";
import { randomUUID } from "node:crypto";
import { dirname, join, basename } from "node:path";

/**
 * rename(2) is atomic on POSIX, so a reader sees either the previous file or the complete new
 * one — never a truncated write from a crash mid-flush.
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeTextAtomic(file, JSON.stringify(data, null, 2) + "\n");
}

export async function writeTextAtomic(file: string, content: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${randomUUID().slice(0, ID_LENGTH)}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
