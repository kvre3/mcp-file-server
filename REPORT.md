# Midterms Pt 1: Build Your Own MCP File Server

**Project:** mcp-file-server
**Repository:** https://github.com/kvre3/mcp-file-server
**Author:** Clement Cortes

## 1. Summary

I built and deployed an MCP file-server connector that gives an AI agent a sandboxed workspace with ten tools: seven file operations plus git status, commit and log. It is served over HTTPS through an ngrok tunnel and kept alive by pm2. I connected it to a real client (Claude) and ran a multi-step task across two sessions using handoff files (`PROJECT_STATE`, `PLAN_LOG`, `CHECKPOINTS`, `DECISIONS`) to carry context between them.

## 2. Stack and why

| Layer | Choice | Reason |
|---|---|---|
| Runtime and SDK | Node.js with the official TypeScript MCP SDK | The reference SDK, best documented, and types catch mistakes in tool schemas at build time |
| Transport | Streamable HTTP, stateless | Works through a tunnel to remote clients. Stateless means a fresh server per request, so a restart loses nothing and there is no session state to leak |
| Validation | zod schemas on every tool input | Bad input is rejected with a clear message before any file is touched |
| Exposure | ngrok with a static domain | Free, quick to set up, and a stable URL means the Claude connector keeps working across restarts |
| Process manager | pm2 | Keeps the server running after the terminal closes and restarts it on a crash. `.env` is loaded through `node_args: "--env-file=.env"` so secrets never appear in the config file |
| Version control | git on the host | The agent's work is committed with a clear history |
| Testing | MCP Inspector, then a real client | Inspector checks the protocol and schemas, and Claude confirms the tools work in practice |

**Configuration.** The token, URL secret and port come from environment variables. The server refuses to start without them, so it cannot run with an open endpoint by accident.

## 3. Tool design choices

- **Single purpose per tool.** Each tool does one thing, so the agent's choice is obvious and a wrong call is cheap.
- **Descriptions tell the agent when to use the tool.** For example, `read_file` points to `search_files` for large files, and `write_file` points to `str_replace` for small edits.
- **Output is capped and chunked** to keep the agent's context small. `read_file` returns 200 lines by default with offset and limit. `list_files` is capped at 200 entries. `search_files` is capped at `max_results`.
- **Append-only handoff files.** `append_file` adds to the end without reading first, which saves a call. `PLAN_LOG.md` and `CHECKPOINTS.md` cannot be overwritten with `write_file`, so one agent cannot erase another's history.
- **`str_replace` demands an exact single match.** Zero or several matches return an error that says how to fix it, which prevents accidental edits.
- **Helpful errors.** Failures return a readable message through `isError` instead of a raw stack trace, so the agent can correct itself without retrying blindly.
- **Git-lite.** `git_status`, `git_commit` and `git_log` let the agent checkpoint its work. Commits are authored by `mcp-agent`, so agent work is easy to tell apart from mine.
- **Logging.** Tool calls go through one `wrap` function that logs them, which gives an audit trail and evidence for the transcript.

## 4. Handoff protocol

Context persists in four files in the workspace, not in the chat:

| File | Role |
|---|---|
| `PROJECT_STATE.md` | Current state and goals |
| `PLAN_LOG.md` | Append-only record of actions and next steps |
| `CHECKPOINTS.md` | Append-only verified milestones |
| `DECISIONS.md` | Choices and reasons |

A new session reads these first and continues without being re-briefed. None of the four can be deleted.

## 5. Security tradeoffs

**Controls in place**

1. **Sandbox root.** Every path is resolved against the workspace root, and paths that escape it are rejected. Agents cannot reach files outside the workspace.
2. **Authenticated endpoint.** The public URL needs a secret. There are two routes:
   - `/mcp` needs `Authorization: Bearer <MCP_TOKEN>` (Inspector, Claude Code).
   - `/s/<URL_SECRET>/mcp` carries the secret in the path (Claude connector).
3. **Secrets compared safely.** The URL secret is checked with a constant-time comparison.
4. **Fail closed.** The server will not start if `MCP_TOKEN` is missing, or if `URL_SECRET` is missing or under 32 characters.
5. **Gated destructive actions.** `delete_file` needs `confirm: true`, works on single files only, is logged, and cannot touch the four handoff files.
6. **No GET or DELETE on the endpoint.** Both return 405.
7. **Secrets kept out of Git.** They live in `.env`, which is git-ignored. `ecosystem.config.cjs` contains no secrets.

**Tradeoffs and known risks**

- **URL secret versus header.** Claude's custom connector on the free plan has no field for a custom `Authorization` header. When I tried the URL with **No sign-in**, Claude detected a 401 and warned that the connection would likely fail. I added the URL-secret route so the connector could work without OAuth. The cost is that a secret in a URL can leak through ngrok's request log, browser history and screenshots. It is acceptable for a demo, and I blur it in screenshots.
- **Rotation.** If the secret leaks, I change `URL_SECRET` in `.env` and run `pm2 restart mcp-file-server --update-env`. The old URL stops working immediately.
- **Production answer.** OAuth would be the correct approach for production: short-lived tokens, per-user sign-in and revocation. It was outside the scope of this project.
- **No rate limiting.** A guessed secret is unlikely at 48 hex characters, but the server does not throttle attempts.
- **Tunnel dependency.** Traffic passes through ngrok, a third party, and the free plan may show an interstitial page to browsers.
- **Windows and reboots.** `pm2 startup` is not supported on Windows, so the server does not restart on its own after a reboot. I run `pm2 resurrect` and restart ngrok manually. A Linux host with systemd or Docker would fix this.
- **Agent trust.** An agent can still do damage inside the workspace (for example, overwrite a normal file). Git commits make that recoverable, and the sandbox limits the blast radius.

## 6. Verification

- **Survives a restart:** `pm2 restart mcp-file-server` was run, then Inspector reconnected and listed the tools. After closing every terminal except ngrok, `pm2 status` still showed `online`.
- **Auth routes:** a wrong URL secret returns 401, the correct secret returns 200, and the Bearer header on `/mcp` still returns 200.
- **Real client:** Claude connected through the connector and called the tools to create and read files.
- **Multi-session task:** two separate chats completed a task, with the second continuing from the handoff files. Transcripts, `PLAN_LOG.md` and `CHECKPOINTS.md` are included as evidence.

## 7. What I would improve

- Replace the URL secret with OAuth.
- Add rate limiting and failed-attempt logging.
- Run on a small VPS with systemd or Docker, and a reserved domain, so it survives reboots.
- Add `if_version` locking so two agents cannot overwrite each other's edits, plus a `search_code` tool and a repo map.
