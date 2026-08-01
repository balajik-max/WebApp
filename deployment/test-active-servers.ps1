# test-active-servers.ps1
# Test if servers can actually handle requests

$AppServers = @("192.168.10.67", "192.168.10.42", "192.168.10.89")

Write-Host "=== Testing Active Servers ===" -ForegroundColor Cyan

foreach ($ip in $AppServers) {
    Write-Host "`n-> Testing $ip..." -ForegroundColor Yellow
    
    # Test 1: Frontend (port 3000)
    try {
        $frontend = Invoke-WebRequest -Uri "http://${ip}:3000" -TimeoutSec 5 -UseBasicParsing
        Write-Host "  Frontend: OK ($($frontend.StatusCode))" -ForegroundColor Green
    } catch {
        Write-Host "  Frontend: FAILED" -ForegroundColor Red
    }
    
    # Test 2: Backend API (port 8001)
    try {
        $backend = Invoke-WebRequest -Uri "http://${ip}:8001/api/v1/health" -TimeoutSec 5 -UseBasicParsing
        Write-Host "  Backend API: OK ($($backend.StatusCode))" -ForegroundColor Green
    } catch {
        Write-Host "  Backend API: FAILED" -ForegroundColor Red
    }
    
    # Test 3: AI Engine (port 11434)
    try {
        $ai = Invoke-WebRequest -Uri "http://${ip}:11434" -TimeoutSec 5 -UseBasicParsing
        Write-Host "  AI Engine: OK ($($ai.StatusCode))" -ForegroundColor Green
    } catch {
        Write-Host "  AI Engine: FAILED" -ForegroundColor Red
    }
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "Green = Can accept requests"
Write-Host "Red = Cannot accept requests"
