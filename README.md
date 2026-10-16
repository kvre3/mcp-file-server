# MCP File Server

A sandboxed file-server MCP connector (Node.js + TypeScript, Streamable HTTP).

## Setup
```bash
npm install
npm install @modelcontextprotocol/sdk express zod
npm install -D typescript tsx @types/node @types/express
cp .env.example .env   # then set MCP_TOKEN
npm test
npm run dev
```

## Test with MCP Inspector
```bash
npx @modelcontextprotocol/inspector
```
Transport: Streamable HTTP, URL `http://localhost:3000/mcp`,
header `Authorization: Bearer <MCP_TOKEN>`.
