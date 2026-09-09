# Azure | MM Service Discord Bot

A standalone Node.js/TypeScript Discord bot (discord.js v14). No dependency
on any specific host — it just needs a Node 20+ runtime, an environment
variable for the bot token, and a way to stay running continuously (it
keeps a live connection to the Discord Gateway, so it isn't a fit for
"serverless"/on-request platforms).

## Setup (applies to any host)

1. Set the environment variable `DISCORD_BOT_TOKEN` in your host's secrets/
   variables panel. Never commit the token to source control — see
   `.env.example` for the full list of variables the bot reads.
2. Build: `npm install && npm run build`
3. Start: `npm start` (runs `node dist/index.js`)
4. In the Discord Developer Portal, under your app → Bot, enable
   **Message Content Intent** (required — commands use a `$prefix`, not
   slash commands, so the bot needs to read message text).
5. Invite the bot with these permissions: Manage Channels, Manage Roles,
   View Channels, Send Messages, Read Message History, Embed Links,
   Attach Files, and Use Application Commands.

The bot also runs a tiny HTTP server exposing a JSON health check on
`process.env.PORT` (defaults to 8080). This is only used for host
health-checks — the bot itself works fine without any HTTP traffic hitting
it, as long as the process stays alive.

## Hosting options

Pick whichever fits your budget — no code changes needed for any of these:

- **Any VPS** (e.g. an Oracle Cloud Always Free instance, a cheap Linode/
  DigitalOcean box, or your own machine): install Node 20+, clone the repo,
  set env vars, run `npm install && npm run build`, then keep it alive with
  a process manager like `pm2 start dist/index.js` or a `systemd` service.
  This is the only genuinely-free-forever option, but you're managing the
  server yourself.
- **Fly.io**: has a free usage allowance for small always-on apps. Deploy
  with `fly launch` (it'll detect the Node app) and set
  `DISCORD_BOT_TOKEN` with `fly secrets set`.
- **Railway / Render / Heroku-style PaaS**: all support this out of the
  box (`Procfile` is included for platforms that use one). These
  typically aren't free indefinitely — check current pricing before
  committing.
- **Avoid free "web service" tiers that sleep on inactivity** (e.g.
  Render's/Replit's free web services) — they'll drop the bot's Discord
  Gateway connection whenever the instance spins down, so it'll go
  offline between messages.

## Persistent data

The bot stores ticket claim roles, temp-role backups, and transcripts in
`data/`. Whatever host you use, make sure that directory persists across
restarts/redeploys (a mounted volume, a persistent disk, or just a normal
folder if you're running on your own VPS) — otherwise settings reset
every time the bot restarts.

## Commands

- `$cmd` or `$commands` — show the command guide.
- `$ticketsetup` — administrator setup for ticket claim roles and the ticket panel.
- `$ticketconfig` — administrator update for ticket claim roles.
- `$tickethelp` — show ticket commands.
- `$tempsetup @Role` — administrator setup for the role kept by temp mode.
- `$temp` — first use saves removable roles and keeps the temp role; second use restores the saved roles.
- `$claim`, `$unclaim`, `$transfer @user` — configured staff ticket controls.
- `$ticketclose`, `$tickettranscript` — configured staff ticket controls.
- `$add @user` — add a member to a ticket.

## Local run

```bash
npm install
npm run build
DISCORD_BOT_TOKEN=your_token npm start
```

Or copy `.env.example` to `.env` and use a tool like `dotenv-cli` /
your editor's run config to load it — the bot itself doesn't load
`.env` files automatically, so either export the vars in your shell or
use your host's own secrets mechanism.
