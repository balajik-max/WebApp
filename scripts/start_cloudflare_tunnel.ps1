# Exposes the locally-running Docker stack (frontend on :3000, which
# reverse-proxies /api/* to the backend) to the internet via a free
# Cloudflare Quick Tunnel. Keep this window open for the URL to stay live —
# closing it, or your PC sleeping, ends the tunnel. Each run prints a new
# random *.trycloudflare.com URL.
#
# Prerequisite: `docker compose up -d` must already be running.

$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflared)) {
    $cloudflared = "cloudflared"
}

& $cloudflared tunnel --url http://localhost:3000
