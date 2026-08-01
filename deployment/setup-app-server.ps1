# setup-app-server.ps1
# Run this on EACH App Server PC (PC2, PC3, PC4, PC5)

param(
    [Parameter(Mandatory=$true)]
    [string]$DBHost = "192.168.10.94"
)

$PROJECT_PATH = "H:\testing webapp"

Write-Host "=== App Server Setup ===" -ForegroundColor Cyan
Write-Host "DB Host: $DBHost" -ForegroundColor Yellow

# Step 1: Copy project files (manual)
Write-Host "`n[1/3] Copy project to this PC..." -ForegroundColor Yellow
Write-Host "  Copy entire 'H:\testing webapp' folder to this PC"

# Step 2: Update .env file
Write-Host "`n[2/3] Update .env file..." -ForegroundColor Yellow
Write-Host "  Change DATABASE_URL to point to DB server"
Write-Host "  Example: DATABASE_URL=postgresql://postgres:jvpiLtvqdqqSZ1HdBVEgokQk8Bzww@${DBHost}:5432/davangere_urban"

# Step 3: Build and run
Write-Host "`n[3/3] Build and start services..." -ForegroundColor Yellow
Push-Location $PROJECT_PATH

# Build frontend
docker compose -f deployment/docker-compose.app.yml build

# Start services
docker compose -f deployment/docker-compose.app.yml up -d

Pop-Location

# Check status
Write-Host "`nChecking status..." -ForegroundColor Yellow
docker ps

Write-Host "`n=== App Server Ready! ===" -ForegroundColor Green
Write-Host "Test: curl http://localhost:3000"
