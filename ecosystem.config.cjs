module.exports = {
  apps: [{
    name: "mcp-file-server",
    script: "dist/server.js",
    cwd: __dirname,
    node_args: "--env-file=.env",
    autorestart: true,
  }],
};