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

**Only the webhook.** Two paths:

| Path | What it is |
| --- | --- |
| `POST /api/linear/webhook` | Linear's agent-session events |
| `GET /api/ping` | Rocky's own self-ping; answers an opaque instance id |

The web UI is **not** on the public endpoint and must not be put there. It has
no authentication under any binding, and it controls every Run on your machine —
putting it on the internet behind a guessable URL is exactly what
[NG-576](https://linear.app/digimondo/issue/NG-576) §4 ruled out. A Checkpoint's
button points at `http://localhost:<port>`, which is a live link when you are at
the machine and a dead one when you are not. That is the accepted trade: when
you are away, you answer in Linear.

If your tunnel can restrict paths, restrict it to the two above.

## Recipes

All three assume the daemon on its default `127.0.0.1:7625`.

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
    path: ^/(api/linear/webhook|api/ping)$
    service: http://127.0.0.1:7625
  - service: http_status:404
```

```sh
cloudflared tunnel run rocky
```

Your public URL is `https://rocky-yourname.example.com`.

Note the `path` rule: without it the tunnel fronts the whole daemon, web UI
included. Cloudflared evaluates ingress rules in order, so the `404` catch-all
has to stay last.

### ngrok, static domain

Needs a paid plan for a static domain. Simplest of the three to run.

```sh
ngrok http 7625 --domain rocky-yourname.ngrok.app
```

Your public URL is `https://rocky-yourname.ngrok.app`.

ngrok has no path filter on the free tiers, so this fronts the whole daemon.
Prefer one of the other two if that bothers you — it should.

### Tailscale Funnel

**Needs no domain of your own**, which makes it the lowest-friction option. The
hostname comes from your tailnet and is stable.

```sh
tailscale funnel --bg --set-path /api/linear/webhook http://127.0.0.1:7625/api/linear/webhook
tailscale funnel --bg --set-path /api/ping           http://127.0.0.1:7625/api/ping
tailscale funnel status
```

Your public URL is `https://<machine>.<tailnet>.ts.net`.

`--set-path` is doing real work here: it exposes those two paths and nothing
else, so the web UI stays on the machine without any extra configuration.

## Checking it

The daemon self-pings through the public URL **on boot and every hour**. The
ping leaves the machine and comes back, and compares an instance id — which
catches the failure a plain `200` hides, a URL still pointed at another
developer's daemon.

There is deliberately **no remediation**. Rocky does not restart your tunnel,
because Rocky did not start it.

A failure shows up in three places:

- a warning in `~/.rocky/logs/daemon.log`, once per outage rather than hourly;
- a banner in the web UI;
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
That, not the missed events, is why the ping runs hourly.

## Moving the endpoint later

Changing `publicUrl` in `~/.rocky/config.json` moves the self-ping — it is
hot-reloaded like the rest of the file. It does **not** move Linear's webhook
URL, which is still fixed on the OAuth app. To actually move it you need a
workspace admin to edit the app in Linear's settings, or a new app.

The same applies to the daemon's port: the OAuth redirect URI
(`http://127.0.0.1:<port>/api/linear/oauth/callback`) is baked into the app at
creation too. Changing `server.port` after setup will break re-authorization,
even though it leaves everything else working.
