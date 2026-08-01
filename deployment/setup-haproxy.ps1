# setup-haproxy.ps1
# Run this on PC1 (Load Balancer)

$PROJECT_PATH = "H:\testing webapp"
$LB_PATH = "$PROJECT_PATH\deployment"

Write-Host "=== HAProxy Setup ===" -ForegroundColor Cyan

# Step 1: Create directories
Write-Host "`n[1/5] Creating directories..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "$LB_PATH\haproxy\certs"

# Step 2: Generate self-signed certificate
Write-Host "`n[2/5] Generating SSL certificate..." -ForegroundColor Yellow
docker run --rm -v "$LB_PATH\haproxy\certs:/certs" alpine sh -c `
    "apk add --no-cache openssl && openssl req -x509 -newkey rsa:4096 -keyout /certs/key.pem -out /certs/cert.pem -days 365 -nodes -subj '/CN=106.51.76.85'"

# Combine cert + key for HAProxy
Get-Content "$LB_PATH\haproxy\certs\cert.pem","$LB_PATH\haproxy\certs\key.pem" | 
    Set-Content "$LB_PATH\haproxy\certs\combined.pem"

Write-Host "`n[3/5] Certificate created!" -ForegroundColor Green

# Step 3: Start HAProxy
Write-Host "`n[4/5] Starting HAProxy..." -ForegroundColor Yellow
Push-Location $LB_PATH
docker compose -f docker-compose.lb.yml up -d
Pop-Location

# Step 4: Verify
Write-Host "`n[5/5] Checking status..." -ForegroundColor Yellow
docker ps | findstr loadbalancer

Write-Host "`n=== HAProxy Ready! ===" -ForegroundColor Green
Write-Host "Stats Dashboard: http://106.51.76.85:8404/stats"
Write-Host "Username: admin"
Write-Host "Password: (check haproxy.cfg)"
