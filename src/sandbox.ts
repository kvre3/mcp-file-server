import path from "node:path";
import fs from "node:fs/promises";

export const ROOT = path.resolve(process.env.WORKSPACE_ROOT ?? "./workspace");

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

/**
 * Resolve a user-supplied path against the workspace root.
 * Throws if it escapes the root, lexically or through a symlink.
 * Works for paths that don't exist yet (so write_file can create them).
 */
export async function safePath(userPath: string, root: string = ROOT): Promise<string> {
  if (userPath.includes("\0")) throw new Error("Invalid path (null byte)");
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, userPath);
  if (!inside(absRoot, resolved)) {
    throw new Error(`Path escapes workspace: ${userPath}`);
  }

  // Symlink check: realpath the nearest existing ancestor
  const realRoot = await fs.realpath(absRoot);
  let probe = resolved;
  while (true) {
    try {
      const real = await fs.realpath(probe);
      if (!inside(realRoot, real)) {
        throw new Error(`Symlink escapes workspace: ${userPath}`);
      }
      break;
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return resolved;
}
