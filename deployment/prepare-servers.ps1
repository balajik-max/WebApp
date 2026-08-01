# prepare-servers.ps1
# Run this on YOUR PC (PC1) to prepare files for other PCs

$PROJECT_PATH = "H:\testing webapp"
$SHARED_PATH = "H:\shared\davangere"

Write-Host "=== Preparing Files for App Servers ===" -ForegroundColor Cyan

# Step 1: Copy project
Write-Host "`n[1/3] Copying project files..." -ForegroundColor Yellow
robocopy $PROJECT_PATH $SHARED_PATH /E /XD ".git" "node_modules" "__pycache__" "*.pyc" "venv" ".venv" /NFL /NDL /NJH /NJS

# Step 2: Create .env template for app servers
Write-Host "`n[2/3] Creating .env template..." -ForegroundColor Yellow
@"
# App Server Environment
DATABASE_URL=postgresql://postgres:jvpiLtvqdqqSZ1HdBVEgokQk8Bzww@192.168.10.94:5432/davangere_urban
REDIS_URL=redis://redis:6379/0
SECRET_KEY=your-secret-key-change-this
BACKEND_URL=http://localhost:8000
FRONTEND_URL=http://localhost:3000
"@ | Set-Content "$SHARED_PATH\.env.appserver"

# Step 3: Create startup script
Write-Host "`n[3/3] Creating startup script..." -ForegroundColor Yellow
@"
# Run this on EACH App Server PC
# Usage: .\setup-appserver.ps1

`$DB_HOST = "192.168.10.94"  # YOUR PC's IP

Write-Host "=== Setting Up App Server ===" -ForegroundColor Cyan

# Copy .env template
Copy-Item ".env.appserver" ".env" -Force

# Update DATABASE_URL with your IP
(Get-Content ".env") -replace "192.168.10.94", `$DB_HOST | Set-Content ".env"

Write-Host "`n[1/3] Building Docker images..." -ForegroundColor Yellow
docker compose build

Write-Host "`n[2/3] Starting services..." -ForegroundColor Yellow
docker compose up -d

Write-Host "`n[3/3] Checking status..." -ForegroundColor Yellow
docker ps

Write-Host "`n=== App Server Ready! ===" -ForegroundColor Green
Write-Host "Test: curl http://localhost:3000"
"@ | Set-Content "$SHARED_PATH\setup-appserver.ps1"

Write-Host "`n=== Files Ready! ===" -ForegroundColor Green
Write-Host "Shared folder: $SHARED_PATH"
Write-Host "`nNext: Copy this folder to each app server PC"
Write-Host "Then run: .\setup-appserver.ps1"
