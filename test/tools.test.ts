import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let base: string;
let root: string;
let T: typeof import("../src/tools.js");

const text = (r: { content: { text: string }[] }) => r.content[0].text;

before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "tools-"));
  root = path.join(base, "workspace");
  await fs.mkdir(root);
  process.env.WORKSPACE_ROOT = root; // must be set before tools.js is imported
  T = await import("../src/tools.js");
});

after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

test("write_file + read_file round trip", async () => {
  await T.writeFile({ path: "notes/a.txt", content: "line1\nline2\nline3" });
  const r = await T.readFile({ path: "notes/a.txt", offset: 2, limit: 1 });
  assert.match(text(r), /\[lines 2-2 of 3\./);
  assert.match(text(r), /line2/);
});

test("read_file on missing file gives a helpful isError", async () => {
  const r = await T.readFile({ path: "nope.txt", offset: 1, limit: 10 });
  assert.equal(r.isError, true);
  assert.match(text(r), /list_files/);
});

test("str_replace: unique match succeeds", async () => {
  await T.writeFile({ path: "b.txt", content: "hello world" });
  const r = await T.strReplace({ path: "b.txt", old_str: "world", new_str: "there" });
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(path.join(root, "b.txt"), "utf8"), "hello there");
});

test("str_replace: not found is an error with a hint", async () => {
  const r = await T.strReplace({ path: "b.txt", old_str: "zzz", new_str: "x" });
  assert.equal(r.isError, true);
  assert.match(text(r), /not found/);
});

test("str_replace: multiple matches is an error", async () => {
  await T.writeFile({ path: "c.txt", content: "a a a" });
  const r = await T.strReplace({ path: "c.txt", old_str: "a", new_str: "b" });
  assert.equal(r.isError, true);
  assert.match(text(r), /3 times/);
});

test("str_replace: $ in new_str is literal", async () => {
  await T.writeFile({ path: "d.txt", content: "price: X" });
  await T.strReplace({ path: "d.txt", old_str: "X", new_str: "$& $1" });
  assert.equal(await fs.readFile(path.join(root, "d.txt"), "utf8"), "price: $& $1");
});

test("append_file creates and appends; PLAN_LOG is append-only", async () => {
  await T.appendFile({ path: "PLAN_LOG.md", content: "first" });
  await T.appendFile({ path: "PLAN_LOG.md", content: "second" });
  assert.equal(await fs.readFile(path.join(root, "PLAN_LOG.md"), "utf8"), "first\nsecond\n");
  const w = await T.writeFile({ path: "PLAN_LOG.md", content: "overwrite" });
  assert.equal(w.isError, true);
  assert.match(text(w), /append-only/);
  const s = await T.strReplace({ path: "PLAN_LOG.md", old_str: "first", new_str: "x" });
  assert.equal(s.isError, true);
});

test("delete_file needs confirm and protects handoff files", async () => {
  await T.writeFile({ path: "tmp.txt", content: "x" });
  const no = await T.deleteFile({ path: "tmp.txt", confirm: false });
  assert.equal(no.isError, true);
  await fs.access(path.join(root, "tmp.txt")); // still there
  const prot = await T.deleteFile({ path: "PLAN_LOG.md", confirm: true });
  assert.equal(prot.isError, true);
  assert.match(text(prot), /protected/);
  const yes = await T.deleteFile({ path: "tmp.txt", confirm: true });
  assert.equal(yes.isError, undefined);
  await assert.rejects(fs.access(path.join(root, "tmp.txt")));
});

test("delete_file refuses directories", async () => {
  const r = await T.deleteFile({ path: "notes", confirm: true });
  assert.equal(r.isError, true);
  assert.match(text(r), /directory/);
});

test("delete_file cannot escape the sandbox", async () => {
  await fs.writeFile(path.join(base, "outside.txt"), "keep");
  await assert.rejects(T.deleteFile({ path: "../outside.txt", confirm: true }), /escapes workspace/);
  await fs.access(path.join(base, "outside.txt"));
});

test("search_files finds matches, case-insensitive by default, capped", async () => {
  await T.writeFile({ path: "s/one.txt", content: "Alpha\nbeta\nALPHA again" });
  await T.writeFile({ path: "s/two.txt", content: "alpha in two" });
  const r = await T.searchFiles({ query: "alpha", path: "s", max_results: 20, case_sensitive: false });
  assert.match(text(r), /s\/one\.txt:1: Alpha/);
  assert.match(text(r), /s\/one\.txt:3: ALPHA again/);
  assert.match(text(r), /s\/two\.txt:1/);
  const cs = await T.searchFiles({ query: "alpha", path: "s", max_results: 20, case_sensitive: true });
  assert.doesNotMatch(text(cs), /one\.txt/);
  const cap = await T.searchFiles({ query: "alpha", path: "s", max_results: 1, case_sensitive: false });
  assert.match(text(cap), /stopped at 1 results/);
  const none = await T.searchFiles({ query: "qqq", path: ".", max_results: 5, case_sensitive: false });
  assert.match(text(none), /No matches/);
});

test(".git is blocked for every file tool", async () => {
  await T.gitStatus(); // creates the repo
  await assert.rejects(T.writeFile({ path: ".git/hooks/pre-commit", content: "evil" }), /\.git/);
  await assert.rejects(T.readFile({ path: ".git/config", offset: 1, limit: 5 }), /\.git/);
  await assert.rejects(T.appendFile({ path: ".GIT/config", content: "x" }), /\.git/);
  const l = await T.listFiles({ path: ".", depth: 1 });
  assert.doesNotMatch(text(l), /\.git/);
});

test("git tools: status, commit, log, nothing-to-commit", async () => {
  const st = await T.gitStatus();
  assert.match(text(st), /##/);
  const c = await T.gitCommit({ message: "first commit" });
  assert.equal(c.isError, undefined, text(c));
  assert.match(text(c), /first commit/);
  const log = await T.gitLog({ limit: 5 });
  assert.match(text(log), /first commit/);
  const clean = await T.gitStatus();
  assert.match(text(clean), /^## main$/m);
  const again = await T.gitCommit({ message: "empty" });
  assert.match(text(again), /Nothing to commit/);
});

test("git_commit with paths stages only those files", async () => {
  await T.writeFile({ path: "g1.txt", content: "1" });
  await T.writeFile({ path: "g2.txt", content: "2" });
  const c = await T.gitCommit({ message: "only g1", paths: ["g1.txt"] });
  assert.equal(c.isError, undefined, text(c));
  const st = await T.gitStatus();
  assert.match(text(st), /\?\? g2\.txt/);
  await assert.rejects(T.gitCommit({ message: "x", paths: ["../outside.txt"] }), /escapes workspace/);
});
