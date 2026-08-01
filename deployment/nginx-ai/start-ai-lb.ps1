# AI Engine Load Balancer - Start Script
# Run this after every reboot before starting Docker

Write-Host "Starting AI Load Balancer (nginx on port 11435)..." -ForegroundColor Yellow

# Kill existing AI nginx if any
Get-Process nginx -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*nginx-ai*" } | Stop-Process -Force

Start-Sleep 1

Start-Process -FilePath "H:\testing webapp\deployment\nginx-ai\nginx.exe" -ArgumentList "-c", "conf/nginx.conf" -WorkingDirectory "H:\testing webapp\deployment\nginx-ai"
Start-Sleep 2

try { 
    $r = Invoke-WebRequest -Uri "http://localhost:11435/api/tags" -TimeoutSec 5 -UseBasicParsing 
    Write-Host "AI Load Balancer: RUNNING (port 11435)" -ForegroundColor Green 
} catch { 
    Write-Host "AI Load Balancer: FAILED" -ForegroundColor Red 
}

Write-Host "`nBackend must be restarted to pick up changes:"
Write-Host "  docker compose up -d --force-recreate backend"

Write-Host "`nAI Engines in load balancer:" -ForegroundColor Cyan
Write-Host "  192.168.10.81:11434 (ai-pc2)" -ForegroundColor Gray
Write-Host "  192.168.10.67:11434 (ai-pc3)" -ForegroundColor Gray
Write-Host "  192.168.10.42:11434 (ai-pc4)" -ForegroundColor Gray
Write-Host "  127.0.0.1:11434 (ai-local, weight=2)" -ForegroundColor Gray
