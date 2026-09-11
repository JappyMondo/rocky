# The public endpoint

Rocky needs **one stable, public HTTPS URL** that Linear can POST to. You bring
it; Rocky does not manage a tunnel process, and never will — that was decided in
[NG-578](https://linear.app/digimondo/issue/NG-578).

This page is the recipes. `rocky setup` asks for the URL before anything else,
so read this first.

## Why it has to be stable

Linear fixes an OAuth app's webhook URL **when the app is created**. There is no
supported way to change it afterwards: the settings UI can, a human can, but the
only programmatic route is an ALPHA mutation that requires a *managing* OAuth
app — a project of its own, and one Rocky deliberately does not take on.

So an ephemeral URL — a `cloudflared` quick tunnel, an ngrok free session — is
not merely inconvenient. The first time it changes, your app's webhook points at
somebody else's tunnel, and fixing it means deleting the app and asking a
workspace admin to create another one.

Pick something whose hostname you keep.

## What goes through it

**Only these exact method/path pairs.** Query strings and alternate encodings
are not part of this protocol:

| Path | What it is |
| --- | --- |
| `POST /api/linear/webhook` | Linear's agent-session events |
| `GET /api/ping` | Rocky's own self-ping; answers an opaque instance id |
| `GET /api/linear/oauth/callback?...` | Linear's OAuth browser return during setup |

The web UI is **not** on the public endpoint and must not be put there. It has
no authentication under any binding, and it controls every Run on your machine —
putting it on the internet behind a guessable URL is exactly what
[NG-576](https://linear.app/digimondo/issue/NG-576) §4 ruled out. A Checkpoint's
button points at `http://localhost:<port>`, which is a live link when you are at
the machine. Away from it, answer in Linear or open the same Run path using the
optional private Tailscale UI address below.

Every public-endpoint recipe below **must** target the `rocky-ingress` filter, never
the daemon port. Path-only tunnel rules are insufficient: they may admit other
methods, prefixes or normalized paths. Direct tunnelling of the daemon, including
the old `ngrok http 7625` recipe and Tailscale `--set-path` recipes, is unsupported.

### Mandatory local filter

`rocky setup` installs and starts two per-user background services: the private
daemon on `127.0.0.1:7625` and this filter on `127.0.0.1:7626`. They restart
after a crash and at login. There is no terminal to keep open and no separate
`rocky-ingress` command in normal use.

From a source checkout, build with `pnpm exec nx build rocky`, then use
`node packages/cli/dist/ingress-main.js`. For a non-default port, use
`rocky-ingress --daemon-port 8000 --port 8001` and point the tunnel at **8001**.
The filter always binds and forwards to `127.0.0.1`. `rocky-ingress` remains
available only for development or a custom service manager; Rocky manages the
local filter, but intentionally does not manage your tunnel provider.

The filter compares the raw HTTP method and target before decoding. Everything
else gets 404 without opening an upstream request, including future APIs. Host,
loopback origin, forwarded headers and method/path override headers grant no
trust. Only POST webhook body bytes, content type and Linear signature reach the
daemon; the daemon still validates the raw-body HMAC and replay window. A ping
always forwards an empty body, draining any framed GET bytes at the filter so
they cannot become another daemon request. Public responses do not copy daemon
version or other private headers. Ping exposes only an opaque instance ID, not
credentials. This is routing identity evidence, not user authentication or
proof against a malicious endpoint deliberately relaying ping.

Local health, UI/assets, shutdown, Run/settings and artifact APIs stay on the
daemon port. The filter forwards the exact OAuth callback route so Linear can
return the browser to Rocky through the public URL; the callback broker still
accepts only the setup's pending state. The filter does not add authentication to that port:
never expose it through a second tunnel, port forward or public bind. A filter
outage fails closed (connection failure), and a daemon outage returns 502.

## Recipes

All three transports below terminate at the same mandatory, locally tested
filter on `127.0.0.1:7626`. TLS and a stable hostname remain your tunnel's job.

### cloudflared, named tunnel

Needs a domain on Cloudflare. Free, and the hostname is yours for good.

```sh
brew install cloudflared           # or the distro package
cloudflared tunnel login
cloudflared tunnel create rocky
cloudflared tunnel route dns rocky rocky-yourname.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: rocky
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: rocky-yourname.example.com
    service: http://127.0.0.1:7626
  - service: http_status:404
```

```sh
cloudflared tunnel run rocky
```

Your public URL is `https://rocky-yourname.example.com`.

The local filter enforces both method and path, not a Cloudflare path regex.
The `404` catch-all stays last. No ingress rule may target the daemon port.

### ngrok, static domain

Use a stable domain supported by your ngrok account.

```sh
ngrok http http://127.0.0.1:7626 --domain rocky-yourname.ngrok.app
```

Your public URL is `https://rocky-yourname.ngrok.app`.

This fronts only the filter. No ngrok path-policy feature is required or trusted.

### Tailscale Funnel

**Needs no domain of your own**, which makes it the lowest-friction option. The
hostname comes from your tailnet and is stable.

```sh
tailscale funnel --bg http://127.0.0.1:7626
tailscale funnel status
```

Your public URL is `https://<machine>.<tailnet>.ts.net`.

Inspect `tailscale funnel status` for old mappings before enabling this. Remove
any mapping to the daemon using Tailscale's own controls. The filter, not
`--set-path` prefix behavior, is the security boundary.

## Private UI access with Tailscale

To use the UI from another device on your tailnet, keep the daemon on
`127.0.0.1:7625` and add an exact private browser origin to the existing `server`
object in `~/.rocky/config.json`:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 7625,
    "tailscaleOrigin": "https://<machine>.<tailnet>.ts.net:7625"
  }
}
```

Use this machine's actual DNS name from `tailscale status --json` → `Self.DNSName`
(without its trailing dot). The origin has no trailing slash, path or query.
The running daemon reloads it when the config changes.

Inspect existing Serve/Funnel mappings, then add a separate private port:

```sh
tailscale serve status
tailscale serve --bg --tls-terminated-tcp=7625 tcp://127.0.0.1:7625
tailscale serve status
```

Open `https://<machine>.<tailnet>.ts.net:7625` on a device connected to the
tailnet. Local access stays at `http://localhost:7625`. Tailscale terminates TLS
and forwards the HTTP bytes over loopback; Rocky checks the exact Host, port and
HTTPS Origin and continues rejecting forwarded headers and cross-origin
requests. Use TLS-terminated TCP forwarding, not an HTTP reverse proxy that adds
forwarded headers. [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
describes this mode and the persistent `--bg` option.

This grants the tailnet devices allowed to reach this port access to Rocky's
UI and controls. Keep this mapping private with **Serve**, never Funnel; public
webhook tunnels still target the filter on port 7626. An existing Funnel on
443 can coexist with private Serve on 7625. Do not reset all Serve mappings.

To remove access, turn off only this mapping and remove `server.tailscaleOrigin`:

```sh
tailscale serve --tls-terminated-tcp=7625 off
```

## Checking it

Before opening a tunnel, reproduce the boundary test locally under Node 24:

```sh
pnpm exec nx build @rocky/daemon
pnpm exec vitest run --config packages/cli/vitest.config.mts packages/cli/src/public-ingress.spec.ts
pnpm exec vitest run --config packages/daemon/vitest.config.mts packages/daemon/src/doctor packages/daemon/src/endpoint
```

The shared ingress fixture runs the exact filter used by all three recipes,
against a real loopback daemon. It sends raw, unnormalized targets, spoofed
forwarded headers, signed and unsigned deliveries, and checks that denied
requests never reach local handlers. It also exercises Doctor through that
filter, local health/UI and shutdown. These are deterministic boundary tests,
not evidence of live provider connectivity. New transports must use this filter
unchanged or provide independent boundary evidence; unrestricted recipes are
not supported. Live external MVP testing remains gated on independent review
and green CI for [NG-651](https://linear.app/digimondo/issue/NG-651).

`rocky doctor` first reads `/api/ping` directly on loopback (the live pidfile's
port, otherwise the configured port), then compares the public `/api/ping`
identity. Missing local identity is a failure, not a reason to trust the public
answer. Each request and its response body has a 10-second timeout and a 1024-byte
decoded body limit; redirects are rejected. Doctor never requires public `/api/health` and does not print
remote bodies, transport errors or URL credentials. The local identity check
requires an IPv4 loopback listener; other local binding choices must provide
one before using this ingress recipe.

## Verify the installed Linear app

A successful ping proves the route reaches this machine. It cannot prove that
Linear will send an agent-session event: Rocky's delegated app token is
intentionally not allowed to inspect or alter an installed app's webhook.
Before treating intake as ready, ask a workspace admin to open the installed
Rocky app in Linear and verify all of the following:

- its webhook URL is exactly `https://<your-host>/api/linear/webhook`;
- the webhook is enabled; and
- `AgentSessionEvent` is enabled in the webhook subscriptions.

Then delegate a harmless test issue to Rocky and confirm it appears in the
local Inbox. If Linear acknowledges the event but Rocky cannot intake it, check
`GET /api/intake-failures` locally for the bounded diagnostic. `rocky doctor`
always repeats this admin handoff as an advisory, rather than claiming that a
reachable public endpoint makes intake ready.

The daemon self-pings through the public URL **on boot and once a minute**. The
ping leaves the machine and comes back, and compares an instance id — which
catches the failure a plain `200` hides, a URL still pointed at another
developer's daemon.

There is deliberately **no remediation**. Rocky does not restart your tunnel,
because Rocky did not start it.

A failure shows up in three places:

- a warning in `~/.rocky/logs/daemon.log`, once per outage rather than every minute;
- a banner in the web UI that shows the most recent verification time and remediation;
- `rocky status`, on stderr.

```sh
rocky status
# Warning: Linear cannot reach Rocky — the public endpoint could not be reached
# — fetch failed. Webhooks will not arrive until it is back; Runs still
# progress via polling. See docs/public-endpoint.md.
```

## What a dead endpoint actually costs

**Latency, not correctness.** The webhook is an optimisation and never the
delivery mechanism ([NG-576](https://linear.app/digimondo/issue/NG-576) §6):
boot reconciliation and the parked polls are what actually carry the data, so a
Run parked at a Checkpoint still picks up its answer with the tunnel down.

It is still worth fixing promptly. Linear retries a failed delivery after 1
minute, then 1 hour, then 6 hours, and **may then disable the webhook
outright** — and re-enabling it is a manual trip through Linear's settings.
That, not the missed events, is why the ping runs every minute.

## Moving the endpoint later

Changing `publicUrl` in `~/.rocky/config.json` moves the self-ping — it is
hot-reloaded like the rest of the file. It does **not** move Linear's webhook
URL, which is still fixed on the OAuth app. To actually move it you need a
workspace admin to edit the app in Linear's settings, or a new app.

The OAuth redirect URI is the public URL plus
`/api/linear/oauth/callback`, and is baked into the app at creation too. Changing
the public URL after setup requires a workspace admin to update the app or create
a new one.
