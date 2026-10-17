# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security →
Report a vulnerability** on this repository. Don't open a public issue. I'll
reply as soon as I can and keep you posted until it is fixed.

## What to know before you run think

- **Whoever can open think can talk to agents that run commands** — on the
  canvases, in the agents' container, with internet access. On anything but
  your own computer, put authentication in front: the built-in password behind
  HTTPS, or an authenticating proxy, tunnel or VPN. See
  [docs/install.md](docs/install.md).
- The port is published on `127.0.0.1` only; keep it that way and reach it
  through a proxy or tunnel.
- Agents run in their own container, whose network reaches the internet but not
  the app or other containers. Inside it they have full permissions and can read
  every canvas and the stored sign-ins: treat one install as one trust domain.
- HTML blocks run in sandboxed iframes without same-origin access.
- Sign-ins and API keys stay on the server, in the data folder (`.agents/`) or
  the environment; they never reach the browser.

Only the latest release gets security fixes.
