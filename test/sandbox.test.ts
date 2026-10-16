import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safePath } from "../src/sandbox.js";

let base: string;
let root: string;

before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-"));
  root = path.join(base, "workspace");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "ok.txt"), "hi");
  await fs.writeFile(path.join(base, "secret.txt"), "nope");
});

after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

test("allows normal relative paths", async () => {
  assert.equal(await safePath("ok.txt", root), path.join(root, "ok.txt"));
});

test("allows not-yet-existing nested paths", async () => {
  await safePath("new/dir/file.md", root);
});

test("allows root itself", async () => {
  assert.equal(await safePath(".", root), root);
});

test("rejects ../ traversal", async () => {
  await assert.rejects(safePath("../secret.txt", root), /escapes workspace/);
});

test("rejects deep traversal", async () => {
  await assert.rejects(safePath("a/../../../etc/passwd", root), /escapes workspace/);
});

test("rejects absolute paths outside root", async () => {
  await assert.rejects(safePath(path.join(base, "secret.txt"), root), /escapes workspace/);
});

test("rejects sibling dir with same prefix", async () => {
  await fs.mkdir(path.join(base, "workspace-evil"));
  await assert.rejects(safePath("../workspace-evil/x", root), /escapes workspace/);
});

test("rejects null bytes", async () => {
  await assert.rejects(safePath("ok.txt\0.png", root), /Invalid path/);
});

test("rejects symlink pointing outside", async (t) => {
  try {
    await fs.symlink(base, path.join(root, "link"));
  } catch {
    t.skip("symlinks not permitted on this OS/user");
    return;
  }
  await assert.rejects(safePath("link/secret.txt", root), /Symlink escapes/);
});
