import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT, safePath } from "./sandbox.js";

const execFileAsync = promisify(execFile);

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const MAX_ENTRIES = 200;
const MAX_WRITE_BYTES = 200_000;
const MAX_READ_BYTES = 2_000_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_SEARCH_FILES = 2000;

// Handoff files at the workspace root
const PROTECTED = new Set(["project_state.md", "plan_log.md", "checkpoints.md", "decisions.md"]);
const APPEND_ONLY = new Set(["plan_log.md", "checkpoints.md"]);

const posix = (p: string) => p.split(path.sep).join("/");

// ---- Logging: evidence for the "agent efficiency" rubric rows ----
function summarize(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args || typeof args !== "object") return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v.length > 80 ? `${v.slice(0, 80)}…(${v.length} chars)` : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else out[k] = JSON.stringify(v)?.slice(0, 80);
  }
  return out;
}

async function logCall(name: string, args: unknown, isError: boolean) {
  const line = JSON.stringify({ ts: new Date().toISOString(), tool: name, args: summarize(args), isError }) + "\n";
  await fs.mkdir("logs", { recursive: true });
  await fs.appendFile("logs/tool_calls.jsonl", line);
}

export function wrap<T>(
  name: string,
  fn: (args: T) => Promise<ToolResult>,
  opts: { logArgs?: boolean } = {}
) {
  return async (args: T): Promise<ToolResult> => {
    let result: ToolResult;
    try {
      result = await fn(args);
    } catch (e: any) {
      result = fail(`${name} failed: ${e.message ?? String(e)}`);
    }
    await logCall(name, opts.logArgs === false ? {} : args, !!result.isError).catch(() => {});
    return result;
  };
}

// ---- Path guard: sandbox + block .git ----
async function resolveGuarded(p: string) {
  const abs = await safePath(p);
  const rel = path.relative(ROOT, abs);
  const segs = rel.split(path.sep).filter(Boolean);
  if (segs.some((s) => s.toLowerCase() === ".git")) {
    throw new Error("Access to .git is not allowed. Use the git_* tools instead.");
  }
  const base = segs.length === 1 ? segs[0].toLowerCase() : "";
  return { abs, rel: posix(rel), base };
}

const APPEND_ONLY_MSG = (p: string) =>
  `${p} is append-only. Use append_file to add to it.`;

// ---- File tools ----
export async function listFiles({ path: p, depth }: { path: string; depth: number }): Promise<ToolResult> {
  const { abs } = await resolveGuarded(p);
  const out: string[] = [];

  async function walk(d: string, level: number) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_ENTRIES) return;
      if (e.name === ".git") continue;
      const rel = posix(path.relative(ROOT, path.join(d, e.name)));
      out.push(e.isDirectory() ? rel + "/" : rel);
      if (e.isDirectory() && level < depth) await walk(path.join(d, e.name), level + 1);
    }
  }

  try {
    await walk(abs, 1);
  } catch (e: any) {
    if (e.code === "ENOENT") return fail(`Directory not found: ${p}. Try list_files on "." first.`);
    if (e.code === "ENOTDIR") return fail(`${p} is a file, not a directory. Use read_file instead.`);
    throw e;
  }
  const note = out.length >= MAX_ENTRIES ? `\n[truncated at ${MAX_ENTRIES} entries; narrow the path]` : "";
  return ok((out.join("\n") || "(empty directory)") + note);
}

export async function readFile({ path: p, offset, limit }: { path: string; offset: number; limit: number }): Promise<ToolResult> {
  const { abs } = await resolveGuarded(p);
  let text: string;
  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) return fail(`${p} is a directory. Use list_files instead.`);
    if (st.size > MAX_READ_BYTES) {
      return fail(`${p} is too large to read (${st.size} bytes). Use search_files to find the part you need.`);
    }
    text = await fs.readFile(abs, "utf8");
  } catch (e: any) {
    if (e.code === "ENOENT") return fail(`File not found: ${p}. Use list_files to see what exists.`);
    throw e;
  }
  const lines = text.split("\n");
  const start = offset - 1;
  const slice = lines.slice(start, start + limit);
  const end = start + slice.length;
  const more = end < lines.length ? ` Call again with offset=${end + 1} for more.` : "";
  return ok(`[lines ${start + 1}-${end} of ${lines.length}.${more}]\n${slice.join("\n")}`);
}

export async function writeFile({ path: p, content }: { path: string; content: string }): Promise<ToolResult> {
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
    return fail(`Content too large (max ${MAX_WRITE_BYTES} bytes). Split it across files.`);
  }
  const { abs, base } = await resolveGuarded(p);
  if (APPEND_ONLY.has(base)) return fail(APPEND_ONLY_MSG(p));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return ok(`Wrote ${Buffer.byteLength(content)} bytes to ${p}`);
}

export async function appendFile({ path: p, content }: { path: string; content: string }): Promise<ToolResult> {
  const { abs } = await resolveGuarded(p);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const text = content.endsWith("\n") ? content : content + "\n";
  await fs.appendFile(abs, text, "utf8");
  return ok(`Appended ${Buffer.byteLength(text)} bytes to ${p}`);
}

export async function strReplace(
  { path: p, old_str, new_str }: { path: string; old_str: string; new_str: string }
): Promise<ToolResult> {
  if (old_str.length === 0) return fail("old_str must not be empty.");
  const { abs, base } = await resolveGuarded(p);
  if (APPEND_ONLY.has(base)) return fail(APPEND_ONLY_MSG(p));
  let text: string;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch (e: any) {
    if (e.code === "ENOENT") return fail(`File not found: ${p}. Use list_files to see what exists.`);
    if (e.code === "EISDIR") return fail(`${p} is a directory.`);
    throw e;
  }
  const first = text.indexOf(old_str);
  if (first === -1) {
    return fail(`old_str not found in ${p}. Call read_file to see the current content, then copy the text exactly.`);
  }
  const count = text.split(old_str).length - 1;
  if (count > 1) {
    return fail(`old_str matches ${count} times in ${p}. Include more surrounding text so it matches exactly once.`);
  }
  const updated = text.slice(0, first) + new_str + text.slice(first + old_str.length);
  if (Buffer.byteLength(updated) > MAX_WRITE_BYTES) {
    return fail(`Result would exceed ${MAX_WRITE_BYTES} bytes. Split the file.`);
  }
  await fs.writeFile(abs, updated, "utf8");
  const line = text.slice(0, first).split("\n").length;
  return ok(`Replaced 1 occurrence in ${p} (starting at line ${line}).`);
}

export async function deleteFile({ path: p, confirm }: { path: string; confirm: boolean }): Promise<ToolResult> {
  if (confirm !== true) {
    return fail(`delete_file is destructive and needs confirm: true. Re-call with confirm: true if you are sure.`);
  }
  const { abs, base } = await resolveGuarded(p);
  if (PROTECTED.has(base)) return fail(`${p} is a protected handoff file and cannot be deleted.`);
  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) return fail(`${p} is a directory. delete_file only deletes single files.`);
    await fs.unlink(abs);
  } catch (e: any) {
    if (e.code === "ENOENT") return fail(`File not found: ${p}. Nothing deleted.`);
    throw e;
  }
  return ok(`Deleted ${p}`);
}

export async function searchFiles(
  { query, path: p, max_results, case_sensitive }:
  { query: string; path: string; max_results: number; case_sensitive: boolean }
): Promise<ToolResult> {
  const { abs } = await resolveGuarded(p);
  const needle = case_sensitive ? query : query.toLowerCase();
  const hits: string[] = [];
  let scanned = 0;
  let capped = false;

  async function scanFile(file: string) {
    if (scanned >= MAX_SEARCH_FILES) { capped = true; return; }
    scanned++;
    const st = await fs.stat(file);
    if (st.size > MAX_SEARCH_FILE_BYTES) return;
    const buf = await fs.readFile(file);
    if (buf.includes(0)) return; // binary
    const lines = buf.toString("utf8").split("\n");
    const rel = posix(path.relative(ROOT, file));
    for (let i = 0; i < lines.length; i++) {
      const hay = case_sensitive ? lines[i] : lines[i].toLowerCase();
      if (hay.includes(needle)) {
        hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (hits.length >= max_results) return;
      }
    }
  }

  async function walk(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (hits.length >= max_results || capped) return;
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) await scanFile(full);
    }
  }

  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) await walk(abs);
    else await scanFile(abs);
  } catch (e: any) {
    if (e.code === "ENOENT") return fail(`Path not found: ${p}. Use list_files to see what exists.`);
    throw e;
  }

  if (hits.length === 0) return ok(`No matches for "${query}" in ${p} (${scanned} files scanned).`);
  const notes: string[] = [];
  if (hits.length >= max_results) notes.push(`stopped at ${max_results} results; narrow the query or path`);
  if (capped) notes.push(`stopped after scanning ${MAX_SEARCH_FILES} files`);
  return ok(hits.join("\n") + (notes.length ? `\n[${notes.join("; ")}]` : ""));
}

// ---- git-lite: runs git inside the workspace only, fixed arguments, no shell ----
const GIT_ID = ["-c", "user.name=mcp-agent", "-c", "user.email=mcp-agent@localhost"];

async function git(args: string[]) {
  return execFileAsync("git", [...GIT_ID, ...args], {
    cwd: ROOT,
    timeout: 15_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

async function ensureRepo() {
  try {
    await fs.stat(path.join(ROOT, ".git"));
  } catch {
    await git(["init", "-b", "main"]);
  }
}

function gitError(e: any): ToolResult {
  if (e?.code === "ENOENT") return fail("git is not installed or not on PATH on the server.");
  const msg = (e?.stderr || e?.stdout || e?.message || String(e)).toString().trim();
  return fail(`git error: ${msg.slice(0, 500)}`);
}

export async function gitStatus(): Promise<ToolResult> {
  try {
    await ensureRepo();
    const { stdout } = await git(["status", "--short", "--branch"]);
    return ok(stdout.trim() || "(clean)");
  } catch (e) {
    return gitError(e);
  }
}

export async function gitCommit(
  { message, paths }: { message: string; paths?: string[] }
): Promise<ToolResult> {
  // Validate paths first so sandbox violations are reported as such, not as git errors
  const rels: string[] = [];
  for (const p of paths ?? []) rels.push((await resolveGuarded(p)).rel || ".");
  try {
    await ensureRepo();
    if (rels.length > 0) {
      await git(["add", "--", ...rels]);
    } else {
      await git(["add", "-A"]);
    }
    try {
      await git(["commit", "-m", message]);
    } catch (e: any) {
      const out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
      if (/nothing (added )?to commit|no changes added/i.test(out)) {
        return ok("Nothing to commit (no staged changes).");
      }
      throw e;
    }
    const { stdout } = await git(["log", "-1", "--oneline"]);
    return ok(`Committed: ${stdout.trim()}`);
  } catch (e) {
    return gitError(e);
  }
}

export async function gitLog({ limit }: { limit: number }): Promise<ToolResult> {
  try {
    await ensureRepo();
    const { stdout } = await git(["log", "--oneline", "-n", String(limit)]);
    return ok(stdout.trim() || "(no commits yet)");
  } catch (e: any) {
    if (/does not have any commits yet|bad default revision/i.test(`${e?.stderr ?? ""}`)) {
      return ok("(no commits yet)");
    }
    return gitError(e);
  }
}
