import express, { type Request, type Response, type NextFunction } from "express";
import fs from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ROOT } from "./sandbox.js";
import {
  wrap, listFiles, readFile, writeFile, appendFile, strReplace, deleteFile, searchFiles,
  gitStatus, gitCommit, gitLog,
} from "./tools.js";
import {
  listFilesSchema, readFileSchema, writeFileSchema, appendFileSchema, strReplaceSchema,
  deleteFileSchema, searchFilesSchema, gitCommitSchema, gitLogSchema,
} from "./schemas.js";

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.MCP_TOKEN;
if (!TOKEN) {
  console.error("MCP_TOKEN is not set. Refusing to start with an open endpoint.");
  process.exit(1);
}

const URL_SECRET = process.env.URL_SECRET;
if (!URL_SECRET || URL_SECRET.length < 32) {
  console.error("URL_SECRET is missing or shorter than 32 chars. Refusing to start.");
  process.exit(1);
}

function secretMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(URL_SECRET!);
  return a.length === b.length && timingSafeEqual(a, b);
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "mcp-file-server", version: "0.2.0" });

  server.registerTool("list_files", {
    description:
      "List files and folders inside the workspace. Use first to discover what exists. Directories end with '/'. Output is capped at 200 entries.",
    inputSchema: listFilesSchema,
  }, wrap("list_files", listFiles));

  server.registerTool("read_file", {
    description:
      "Read a text file from the workspace in line chunks (default 200 lines). Use offset/limit to page through large files instead of reading everything. To find something in a big file, prefer search_files.",
    inputSchema: readFileSchema,
  }, wrap("read_file", readFile));

  server.registerTool("write_file", {
    description:
      "Create or overwrite a whole file in the workspace. Use for new files; for small changes to an existing file use str_replace. Cannot overwrite PLAN_LOG.md or CHECKPOINTS.md (use append_file).",
    inputSchema: writeFileSchema,
  }, wrap("write_file", writeFile));

  server.registerTool("append_file", {
    description:
      "Add text to the end of a file (created if missing) without reading it first. Use this for PLAN_LOG.md and CHECKPOINTS.md, which are append-only.",
    inputSchema: appendFileSchema,
  }, wrap("append_file", appendFile));

  server.registerTool("str_replace", {
    description:
      "Replace one exact piece of text in a file. old_str must match exactly once; if it matches zero or several times you get an error telling you how to fix it. Read the file first so you can copy the text exactly.",
    inputSchema: strReplaceSchema,
  }, wrap("str_replace", strReplace));

  server.registerTool("delete_file", {
    description:
      "Delete a single file. Destructive: requires confirm: true, and every call is logged. Cannot delete directories or the four handoff files (PROJECT_STATE, PLAN_LOG, CHECKPOINTS, DECISIONS).",
    inputSchema: deleteFileSchema,
  }, wrap("delete_file", deleteFile));

  server.registerTool("search_files", {
    description:
      "Find lines containing a plain-text query across the workspace (or one file/folder). Returns path:line: text, capped at max_results. Use this instead of reading whole files to locate something.",
    inputSchema: searchFilesSchema,
  }, wrap("search_files", searchFiles));

  server.registerTool("git_status", {
    description: "Show changed and untracked files in the workspace's git repo. The repo is created on first use.",
    inputSchema: {},
  }, wrap("git_status", async () => gitStatus(), { logArgs: false }));

  server.registerTool("git_commit", {
    description:
      "Stage and commit changes in the workspace repo. Give a clear message. Pass paths to commit only specific files, or omit to commit everything. Commits are authored by 'mcp-agent'.",
    inputSchema: gitCommitSchema,
  }, wrap("git_commit", gitCommit));

  server.registerTool("git_log", {
    description: "Show recent commits (one line each) from the workspace repo. Use at the start of a session to see what was done.",
    inputSchema: gitLogSchema,
  }, wrap("git_log", gitLog));

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

function auth(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function urlSecretAuth(req: Request, res: Response, next: NextFunction) {
  if (!secretMatches(String(req.params.secret ?? ""))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Stateless Streamable HTTP: a fresh server + transport per request
async function handleMcp(req: Request, res: Response) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// Option 1: Authorization: Bearer header (Inspector, Claude Code)
app.post("/mcp", auth, handleMcp);

// Option 2: secret in the URL path (Claude connector, which can't send headers)
app.post("/s/:secret/mcp", urlSecretAuth, handleMcp);

for (const path of ["/mcp", "/s/:secret/mcp"]) {
  app.get(path, (_req, res) => res.status(405).json({ error: "Method not allowed" }));
  app.delete(path, (_req, res) => res.status(405).json({ error: "Method not allowed" }));
}

await fs.mkdir(ROOT, { recursive: true });
app.listen(PORT, () => console.log(`MCP server on http://localhost:${PORT}/mcp  (root: ${ROOT})`));