# test-unified-backend.ps1
# Test if all app servers connect to the same database

$DBServer = "192.168.10.81"
$AppServers = @("192.168.10.67", "192.168.10.42", "192.168.10.89")

Write-Host "=== Testing Unified Backend ===" -ForegroundColor Cyan

# Step 1: Check DB Server
Write-Host "`n[1/3] Checking DB Server ($DBServer)..." -ForegroundColor Yellow
$dbTest = Test-NetConnection -ComputerName $DBServer -Port 5432 -WarningAction SilentlyContinue
if ($dbTest.TcpTestSucceeded) {
    Write-Host "  DB Server: OK" -ForegroundColor Green
} else {
    Write-Host "  DB Server: FAILED" -ForegroundColor Red
}

# Step 2: Check each App Server
Write-Host "`n[2/3] Checking App Servers..." -ForegroundColor Yellow
foreach ($ip in $AppServers) {
    $appTest = Test-NetConnection -ComputerName $ip -Port 8001 -WarningAction SilentlyContinue
    if ($appTest.TcpTestSucceeded) {
        Write-Host "  $ip : OK" -ForegroundColor Green
    } else {
        Write-Host "  $ip : FAILED" -ForegroundColor Red
    }
}

# Step 3: Check HAProxy
Write-Host "`n[3/3] Checking HAProxy..." -ForegroundColor Yellow
$haproxyTest = Test-NetConnection -ComputerName localhost -Port 8080 -WarningAction SilentlyContinue
if ($haproxyTest.TcpTestSucceeded) {
    Write-Host "  HAProxy: OK" -ForegroundColor Green
} else {
    Write-Host "  HAProxy: FAILED" -ForegroundColor Red
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "All app servers should connect to: $DBServer"
Write-Host "Check stats: http://localhost:8404/stats"
