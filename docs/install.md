# Installing think

think is two Docker containers from one image, and one data folder. To run the
published image you need nothing from this repository but `deploy/compose.yml`
(and, optionally, `deploy/.env.example` as `.env`).

## Requirements

- Docker with Compose v2, on Linux (x86-64 or arm64) or Docker Desktop.
- For the agents: a Claude subscription or an Anthropic API key, and/or a
  ChatGPT plan or an OpenAI API key.
- **On a server: something that authenticates people before they reach the
  app.** Whoever can open think can talk to agents that run commands. Either:
  - the built-in password (below), behind HTTPS, or
  - an authenticating proxy or zero-trust gateway (oauth2-proxy, Authelia,
    Cloudflare Access, Tailscale, a VPN) — optionally *plus* the password.

  The compose files bind the port to `127.0.0.1` only. Never publish it to the
  internet without one of these in front.

## Run it

```bash
mkdir think && cd think
curl -fsSLO https://raw.githubusercontent.com/olalha/think-board/main/deploy/compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/olalha/think-board/main/deploy/.env.example   # optional
docker compose up -d
docker compose ps   # wait for "healthy"
```

Open http://localhost:8080. A fresh install opens with the canvas *Welcome to
think*.

Settings live in `.env` (all optional): `THINK_IMAGE` (pin a version, e.g.
`ghcr.io/olalha/think-board:0.6.0`), `PUID`/`PGID`, `THINK_DATA`,
`THINK_PORT`, `THINK_PUBLIC_URL`, `TZ` and the API keys. On Linux, set
`PUID`/`PGID` to the output of `id -u` / `id -g` if they are not 1000, so the
files think writes belong to you.

Everything think keeps is in the data folder (`THINK_DATA`, default
`./think-data`):

| Folder | Holds |
|---|---|
| `data/` | the canvases, one git repository each — **back this up** |
| `.agents/` | each agent provider's isolated home and login (private: 0700) |
| `guests/` | requests from the `think` command |
| `.auth/` | the optional app password |
| `cli/` | the `think` command, written by think for agents on this machine |
| `config/`, `prompts/` | optional overrides of the built-in files (see `docs/config.md`) |

The containers keep nothing else: remove them, pull a new image, start again.

## Reach it

The port is on `127.0.0.1` (`THINK_PORT`, default 8080). Pick one way in:

- **On your own computer:** open http://localhost:8080.
- **A server, from your laptop over SSH:** `ssh -L 8080:localhost:8080 <server>`,
  then open http://localhost:8080.
- **A reverse proxy with HTTPS** on the same machine (Caddy example — add
  authentication, or set the app password):
  ```
  think.example.com {
      reverse_proxy 127.0.0.1:8080
  }
  ```
  WebSockets must pass through (Caddy, Traefik and nginx with the usual
  `Upgrade` headers all do).
- **A zero-trust tunnel** (Cloudflare Tunnel + Access, Tailscale Serve, …)
  pointed at `127.0.0.1:8080`.

Set `THINK_PUBLIC_URL` to the address you open (the proxy's or the tunnel's),
so links from the `think` command (`think new`, `think url`) point there.

### Dokploy, Coolify and similar

These run a compose file and put their own proxy in front:

1. Create a **Docker Compose** application from this repository (compose path
   `deploy/compose.yml`), or paste that file in.
2. Add a domain for the service **`think`**, port **8080**.
3. Set the environment: at least `THINK_PUBLIC_URL=https://<your domain>`, and
   `PUID`/`PGID` if the data folder should belong to a particular user.
4. Point `THINK_DATA` at a folder on the host, e.g. `/srv/think` — one folder
   for both services. Volume backups of these platforms often skip bind
   mounts: back up that folder yourself.
5. Deploy, then set the app password (below) before you share the URL —
   or put the platform's authentication in front.

The loopback port in the compose file is harmless there; the platform's proxy
reaches the container over its own network.

## Set the app password

```bash
docker compose exec -it -u think think bin/set-password --local   # asks twice, without echo
```

Sign-in sessions last 30 days (a signed cookie). Setting a new password signs
everyone out; `--off` removes it. Repeated wrong passwords are slowed down per
address.

## Sign the agents in

Open a canvas: the chat shows **Log in to …** for its agent. A terminal in the
page runs the agent's own sign-in inside its isolated home, and the credentials
stay there. One login serves every canvas using that agent.

- **Claude Code:** open the link, approve, paste the code back.
- **Codex:** *Sign in with ChatGPT* runs the Codex CLI's device-code sign-in:
  open the link it shows and enter the code. ChatGPT may ask you to allow
  device-code sign-in in its security settings first.

**API keys instead:** set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `.env` and
run `docker compose up -d` to pass the key in. The chat's login card then offers
**Use the server's API key**, and *Settings → Server & agents* switches each
agent between its own sign-in and the key. The key itself never reaches the
browser.

## Let agents on this machine use it (optional)

Agents on the same machine (Claude Code or Codex in a terminal) can work on
canvases with the `think` command. Install it from the image or from your
checkout, never from the data folder: think's container can write there, and
your agents would run whatever it wrote. Next to your compose file:

```bash
# The published image (deploy/compose.yml): copy the command out of the image.
mkdir -p think-cli
docker compose run --rm --no-deps -T --entrypoint tar think -C /opt/think -cf - bin/think skills/think-canvas | tar -xf - -C think-cli
ln -s "$PWD/think-cli/bin/think" ~/.local/bin/think   # anywhere on PATH

# A checkout: it is already there.
ln -s "$PWD/bin/think" ~/.local/bin/think

think list
think skill --install     # the agent guide, for Claude Code and/or Codex (whichever are here)
```

It finds the data folder itself when that is `./think-data` (the default). For
another `THINK_DATA`, set `THINK_ROOT` to that folder wherever agents run
`think`. It needs only `sh`, and must run as the data folder's owner (the same
user as `PUID`). See `docs/outside-agents.md`.

## Updating

```bash
docker compose pull && docker compose up -d
```

If you copied the `think` command out of the image, run that `docker compose
run … tar` line again too. Up to 0.6, think put the command in the data folder
(`think-data/cli`); it now removes that copy at start, so install it as above.

With a pinned `THINK_IMAGE`, change the version in `.env` first. Canvases are
upgraded when they are next opened; the upgrade shows in their History. A
canvas made by a newer think than the one running is refused rather than
damaged ("Needs a newer think" in the list).

## Keep in mind

- **Backups:** `data/` holds every canvas as a git repository and nothing pushes
  it anywhere. Back up the data folder (at least `data/`) yourself.
- **Isolation:** the agents' container reaches the internet but not the app or
  other containers. Within it, agents run with full permissions and can read
  every canvas and the stored logins: treat the whole install as one trust
  domain, and give think its own data folder.

## Building the image yourself

From a checkout:

```bash
docker build -t think:local --build-arg THINK_COMMIT=$(git rev-parse --short HEAD) .
```

Then set `THINK_IMAGE=think:local`. The published images are built for
`linux/amd64` and `linux/arm64` by the release workflow
(`.github/workflows/release.yml`) for every release.

## Running from a checkout

`compose.yml` at the repository root builds from source, keeps its data in
`./think-data` (git-ignored) and serves http://localhost:8080:

```bash
git clone https://github.com/olalha/think-board.git && cd think-board
docker compose up -d --build
```

For development without Docker, see `docs/development.md`.
