# Exposes the locally-running Docker stack (frontend on $FRONTEND_PORT,
# which reverse-proxies /api/* to the backend) to the internet via a free
# Cloudflare Quick Tunnel. Keep this window open for the URL to stay live —
# closing it, or your PC sleeping, ends the tunnel. Each run prints a new
# random *.trycloudflare.com URL.
#
# Prerequisite: `docker compose up -d` must already be running.

$candidatePaths = @(
    "C:\Program Files (x86)\cloudflared\cloudflared.exe",
    "C:\Program Files\cloudflared\cloudflared.exe",
    "$env:USERPROFILE\tools\cloudflared.exe"
)
$cloudflared = $candidatePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cloudflared) {
    $onPath = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($onPath) { $cloudflared = $onPath.Source }
}
if (-not $cloudflared) {
    Write-Error "cloudflared.exe not found. Install it or add its folder to PATH."
    exit 1
}

# Read FRONTEND_PORT from .env so this always matches the port docker-compose
# actually publishes the frontend on (host port 3000 is Grafana, not the app).
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$frontendPort = 3000
if (Test-Path $envFile) {
    $match = Select-String -Path $envFile -Pattern '^\s*FRONTEND_PORT\s*=\s*(\S+)' | Select-Object -First 1
    if ($match) {
        $frontendPort = $match.Matches[0].Groups[1].Value
    }
}

Write-Host "Tunneling to http://localhost:$frontendPort"
& $cloudflared tunnel --url "http://localhost:$frontendPort"
