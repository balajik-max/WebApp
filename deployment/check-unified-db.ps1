# check-unified-db.ps1
# Run this on EACH app server to verify DB connection

param(
    [string]$DBServer = "192.168.10.81"
)

Write-Host "=== Checking Unified Database Connection ===" -ForegroundColor Cyan

# Step 1: Check if DB server is reachable
Write-Host "`n[1/3] Testing DB Server ($DBServer)..." -ForegroundColor Yellow
$ping = Test-NetConnection -ComputerName $DBServer -Port 5432 -WarningAction SilentlyContinue
if ($ping.TcpTestSucceeded) {
    Write-Host "  DB Server: REACHABLE" -ForegroundColor Green
} else {
    Write-Host "  DB Server: NOT REACHABLE" -ForegroundColor Red
    Write-Host "  Make sure PostgreSQL is running on $DBServer" -ForegroundColor Yellow
    exit 1
}

# Step 2: Check backend container
Write-Host "`n[2/3] Checking backend container..." -ForegroundColor Yellow
$backend = docker ps --format "{{.Names}}" | findstr backend
if ($backend) {
    Write-Host "  Backend: RUNNING" -ForegroundColor Green
    
    # Check DATABASE_URL
    Write-Host "`n[3/3] Checking DATABASE_URL..." -ForegroundColor Yellow
    $dbUrl = docker exec $backend printenv DATABASE_URL 2>$null
    if ($dbUrl -match $DBServer) {
        Write-Host "  DATABASE_URL: Points to $DBServer" -ForegroundColor Green
    } else {
        Write-Host "  DATABASE_URL: Points to WRONG server" -ForegroundColor Red
        Write-Host "  Current: $dbUrl" -ForegroundColor Yellow
        Write-Host "  Should contain: $DBServer" -ForegroundColor Yellow
    }
} else {
    Write-Host "  Backend: NOT RUNNING" -ForegroundColor Red
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "If all green, unified backend is working!"
Write-Host "All data is stored in: $DBServer"
