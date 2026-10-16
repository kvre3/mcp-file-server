# mcp-file-server: Technical Documentation

This document describes how the server works, how each tool behaves, and how to operate and troubleshoot it. For setup, see [README.md](README.md). For design reasoning and security tradeoffs, see [REPORT.md](REPORT.md).

## 1. Architecture

```
Claude / Inspector / Claude Code
        |  HTTPS
        v
   ngrok tunnel (static domain)
        |  HTTP
        v
   Express app on localhost:3000   <- run by pm2
        |  auth check (Bearer token or URL secret)
        v
   MCP server (built fresh per request)
        |
        v
   tool wrapper (logging) -> tool implementation -> sandbox -> workspace folder
```

The server is **stateless**. For every POST, `handleMcp` builds a new `McpServer` and a new `StreamableHTTPServerTransport` with no session ID, handles the request, and closes both when the response ends. There is no session state to lose on restart.

## 2. Endpoints

| Method | Path | Behavior |
|---|---|---|
| POST | `/mcp` | MCP requests. Requires `Authorization: Bearer <MCP_TOKEN>` |
| POST | `/s/:secret/mcp` | MCP requests. Requires `:secret` to equal `URL_SECRET` |
| GET | `/mcp`, `/s/:secret/mcp` | 405 Method Not Allowed |
| DELETE | `/mcp`, `/s/:secret/mcp` | 405 Method Not Allowed |

A 405 on GET is expected. Clients try to open an optional streaming channel and the stateless server declines it. A wrong token or secret returns 401 `{"error":"Unauthorized"}`.

## 3. Configuration

All configuration is through environment variables, loaded from `.env` by `node --env-file=.env` (set in `ecosystem.config.cjs`).

| Variable | Required | Description |
|---|---|---|
| `MCP_TOKEN` | Yes | Bearer token for `/mcp`. Server exits if unset |
| `URL_SECRET` | Yes | Secret for `/s/:secret/mcp`. Must be at least 32 characters. Server exits if unset or too short |
| `PORT` | No | Listen port. Defaults to 3000 |

The workspace root (`ROOT`) is defined in `src/sandbox.ts` and created at startup if missing. The startup log prints it.

### pm2 config (`ecosystem.config.cjs`)

```js
module.exports = {
  apps: [{
    name: "mcp-file-server",
    script: "dist/server.js",
    cwd: __dirname,
    node_args: "--env-file=.env",
    autorestart: true,
  }],
};
```

## 4. Sandbox

Every tool resolves its path argument against `ROOT` before touching the disk. A path that resolves outside `ROOT` (for example one using `..`) is rejected with an error. Handoff files have extra rules (section 6).

## 5. Tool reference

All inputs are validated with zod schemas (`src/schemas.ts`). Errors come back as readable messages with `isError` set. Each call passes through the `wrap` function, which logs it.

### Reading

**`list_files`**: List files and folders inside the workspace. Directories end with `/`. Output is capped at 200 entries. Use it first to see what exists.

**`read_file`**: Read a text file in line chunks (default 200 lines). Use `offset` and `limit` to page through large files.

**`search_files`**: Find lines containing a plain-text query across the workspace, or within one file or folder. Returns `path:line: text`, capped at `max_results`. Prefer this to reading whole files.

### Writing

**`write_file`**: Create or overwrite a whole file. Use for new files. It cannot overwrite `PLAN_LOG.md` or `CHECKPOINTS.md`.

**`append_file`**: Add text to the end of a file, creating it if missing, without reading it first. Use it for `PLAN_LOG.md` and `CHECKPOINTS.md`.

**`str_replace`**: Replace one exact piece of text. `old_str` must match exactly once. With zero or several matches, the error explains how to fix it. Read the file first so you can copy the text exactly.

### Deleting

**`delete_file`**: Delete a single file. Requires `confirm: true`, and every call is logged. It cannot delete directories or the four handoff files.

### Git

**`git_status`**: Show changed and untracked files in the workspace repo. The repo is created on first use.

**`git_commit`**: Stage and commit with a clear message. Pass `paths` to commit specific files, or omit to commit everything. Commits are authored by `mcp-agent`.

**`git_log`**: Show recent commits, one line each. Use it at the start of a session to see what was done.

## 6. Handoff protocol

| File | Rules |
|---|---|
| `PROJECT_STATE.md` | Current state of the project |
| `PLAN_LOG.md` | Append-only. Cannot be overwritten by `write_file`. Cannot be deleted |
| `CHECKPOINTS.md` | Append-only. Cannot be overwritten by `write_file`. Cannot be deleted |
| `DECISIONS.md` | Choices and reasons. Cannot be deleted |

**Recommended session routine for an agent:**

1. `git_log` and `list_files` to orient.
2. `read_file` on `PROJECT_STATE.md`, then recent entries of `PLAN_LOG.md`.
3. Do the work, reading before writing and using `search_files` instead of reading large files.
4. `append_file` to `PLAN_LOG.md` (what was done, what is next) and to `CHECKPOINTS.md` (what was verified).
5. `git_commit` with a clear message.

## 7. Operations

| Task | Command |
|---|---|
| Build | `npm run build` |
| Start under pm2 | `pm2 start ecosystem.config.cjs` |
| Check status | `pm2 status` |
| View logs | `pm2 logs mcp-file-server --lines 20` |
| Restart after a code or `.env` change | `pm2 restart mcp-file-server --update-env` |
| Save process list | `pm2 save` |
| Restore after reboot (Windows) | `pm2 resurrect` |
| Stop | `pm2 stop mcp-file-server` |
| Start tunnel | `ngrok http 3000 --url=<static-domain>` |

**Rotating the URL secret:** generate a new value, update `URL_SECRET` in `.env`, run `pm2 restart mcp-file-server --update-env`, then update the connector URL in Claude.

## 8. Manual tests

Create a request file:

```powershell
Set-Content init.json '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
```

| Case | Expected |
|---|---|
| POST `/s/wrong/mcp` | 401 |
| POST `/s/<URL_SECRET>/mcp` | 200 |
| POST `/mcp` with correct Bearer header | 200 |
| POST `/mcp` with no header | 401 |
| GET `/mcp` | 405 |

Example:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://localhost:3000/s/wrong/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "@init.json"
```

Delete `init.json` afterward so it is not committed.

## 9. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| pm2 shows `errored` or the restart count keeps rising | Run `pm2 logs mcp-file-server`. Usually a missing `MCP_TOKEN` or `URL_SECRET`, or Node older than 20.6 |
| Log says `URL_SECRET is missing or shorter than 32 chars` | Add or lengthen `URL_SECRET` in `.env`, save, then `pm2 restart mcp-file-server --update-env` |
| 401 in Inspector | Header is missing the `Bearer ` prefix, or the token is wrong |
| 401 on the connector URL | The secret in the URL does not match `URL_SECRET` |
| Connector says it requires sign-in | The URL probed returned 401. Use the `/s/<secret>/mcp` URL with **No sign-in** |
| Cannot connect or times out | ngrok is not running, or pm2 shows the server is not `online` |
| Browser shows an ngrok warning page | Add the header `ngrok-skip-browser-warning: true` |
| Server gone after reboot | Windows has no `pm2 startup`. Run `pm2 resurrect` and restart ngrok |
| Edits to `src/` have no effect | You need to `npm run build` before restarting. pm2 runs `dist/server.js` |
| `git push` rejected | Run `git pull`, then push again |

## 10. Security notes

- Never commit `.env`. Check `git status` before every commit.
- Blur the URL secret in screenshots and do not paste it in chat.
- ngrok's request log (terminal and `http://127.0.0.1:4040`) shows the secret in the path.
- If the secret may have leaked, rotate it right away (section 7).
