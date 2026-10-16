# mcp-file-server

A sandboxed file-and-git MCP server. It gives AI agents (Claude, Claude Code, MCP Inspector) a safe workspace folder to read, write, search and commit in, and a set of handoff files so work carries over between sessions.

- **Runtime:** Node.js + TypeScript, official MCP SDK
- **Transport:** Streamable HTTP (stateless)
- **Exposure:** ngrok tunnel with a static domain
- **Process manager:** pm2

## Requirements

- Node.js **20.6 or newer** (needed for `--env-file`). Check with `node -v`.
- git installed and on your PATH
- An [ngrok](https://ngrok.com) account (free plan works) with a static domain
- pm2: `npm install -g pm2`

## Setup

```powershell
git clone https://github.com/kvre3/mcp-file-server.git
cd mcp-file-server
npm install
```

Create a `.env` file in the project root (copy `.env.example`):

```
MCP_TOKEN=<long random string>
URL_SECRET=<random string, at least 32 characters>
PORT=3000
```

Generate each secret with:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

The server refuses to start if `MCP_TOKEN` is missing, or if `URL_SECRET` is missing or shorter than 32 characters. `.env` is git-ignored. Never commit it.

## Run

**Development** (stops when the terminal closes):

```powershell
npm run dev
```

**Deployed** (keeps running after you close the terminal):

```powershell
npm run build
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs mcp-file-server --lines 20
```

You should see `MCP server on http://localhost:3000/mcp`.

**Expose it** in a second terminal (use your own static domain):

```powershell
ngrok http 3000 --url=<your-static-domain>.ngrok-free.dev
```

After a code change: `npm run build`, then `pm2 restart mcp-file-server --update-env`.

### Windows note

`pm2 startup` is not supported on Windows, so the server does not come back by itself after a reboot. After rebooting, run `pm2 resurrect` (or `pm2 start ecosystem.config.cjs`), then start ngrok again.

## Connect a client

There are two ways to authenticate. Both reach the same tools.

| Client | URL | Auth |
|---|---|---|
| MCP Inspector, Claude Code | `https://<domain>/mcp` | Header `Authorization: Bearer <MCP_TOKEN>` |
| Claude custom connector | `https://<domain>/s/<URL_SECRET>/mcp` | **No sign-in** (the secret in the path is the credential) |

### MCP Inspector

```powershell
npx @modelcontextprotocol/inspector
```

Open the link it prints. Set Transport to **Streamable HTTP**, enter the URL above, add the `Authorization` header, click **Connect**, then **Tools → List Tools**.

### Claude (claude.ai)

1. Settings → Connectors → **Add custom connector**.
2. Paste the secret-path URL.
3. Choose **No sign-in**.
4. In a new chat, enable the connector and ask Claude to use the tools.

## Tools

| Tool | Purpose |
|---|---|
| `list_files` | List files and folders (directories end with `/`, capped at 200 entries) |
| `read_file` | Read a text file in line chunks (default 200 lines) |
| `write_file` | Create or overwrite a whole file |
| `append_file` | Add text to the end of a file (creates it if missing) |
| `str_replace` | Replace one exact piece of text (must match exactly once) |
| `delete_file` | Delete one file (requires `confirm: true`, logged) |
| `search_files` | Find lines containing a plain-text query |
| `git_status` | Show changed and untracked files |
| `git_commit` | Stage and commit (authored by `mcp-agent`) |
| `git_log` | Show recent commits |

See [DOCUMENTATION.md](DOCUMENTATION.md) for details.

## Handoff protocol

The workspace holds four files that carry context between agent sessions:

- `PROJECT_STATE.md`: what the project is and where it stands
- `PLAN_LOG.md`: append-only log of what was done and what is next
- `CHECKPOINTS.md`: append-only list of verified milestones
- `DECISIONS.md`: choices made and why

A new session should read these first, then continue. `PLAN_LOG.md` and `CHECKPOINTS.md` cannot be overwritten, only appended to. None of the four can be deleted.

## Security summary

- Every path is resolved against a sandbox root, and escapes are rejected.
- The public endpoint requires a secret (Bearer token or URL secret).
- Destructive actions are gated and logged.
- The URL-secret route is weaker than a header (URLs can leak into logs and screenshots). See [REPORT.md](REPORT.md).

## Project layout

```
src/
  server.ts     Express app, auth, MCP tool registration
  tools.ts      Tool implementations and the logging wrapper
  schemas.ts    zod input schemas for every tool
  sandbox.ts    Workspace root and path resolution
dist/           Compiled output (git-ignored)
ecosystem.config.cjs   pm2 process config
.env.example    Placeholder environment values
```

## Tests

```powershell
npm test
```

<!-- Replace with your real test command if it differs. -->
