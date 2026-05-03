module.exports = {
  apps: [
    {
      name: "server",
      script: "server.js"
    },
    {
      name: "cloudflared",
      script: "C:/Program Files (x86)/cloudflared/cloudflared.exe",
      args: [
        "--config",
        "C:/Users/enoch/.cloudflared/config.yml",
        "tunnel",
        "run",
        "lebaronlabs"
      ],
      cwd: "C:/Users/enoch/.cloudflared",
      interpreter: "none"
    }
  ]
};