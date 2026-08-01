# setup-all.ps1 - Setup Load Balancer + App Servers
# Run on PC1 (Your PC with public IP)

param(
    [string]$Action = "setup-lb"
)

$YOUR_IP = "192.168.10.94"
$PC_IPS = @("192.168.10.95", "192.168.10.96", "192.168.10.97", "192.168.10.98")
$PROJECT_PATH = "H:\testing webapp"

Write-Host "=== Davangere Load Balancer Setup ===" -ForegroundColor Cyan

switch ($Action) {
    "setup-lb" {
        Write-Host "`n[1/3] Creating HAProxy config..." -ForegroundColor Yellow
        
        # Create certs directory
        New-Item -ItemType Directory -Force -Path "$PROJECT_PATH\deployment\haproxy\certs"
        
        Write-Host "`n[2/3] Generating self-signed cert..." -ForegroundColor Yellow
        
        # Generate self-signed cert (run in Docker)
        docker run --rm -v "$PROJECT_PATH\deployment\haproxy\certs:/certs" alpine sh -c `
            "apk add --no-cache openssl && openssl req -x509 -newkey rsa:4096 -keyout /certs/key.pem -out /certs/cert.pem -days 365 -nodes -subj '/CN=106.51.76.85'"
        
        # Combine for HAProxy
        Get-Content "$PROJECT_PATH\deployment\haproxy\certs\cert.pem","$PROJECT_PATH\deployment\haproxy\certs\key.pem" | 
            Set-Content "$PROJECT_PATH\deployment\haproxy\certs\combined.pem"
        
        Write-Host "`n[3/3] Starting HAProxy..." -ForegroundColor Yellow
        Push-Location "$PROJECT_PATH\deployment"
        docker compose -f docker-compose.lb.yml up -d
        Pop-Location
        
        Write-Host "`n=== Load Balancer Ready! ===" -ForegroundColor Green
        Write-Host "Stats page: http://106.51.76.85:8404/stats"
    }
    
    "deploy-app" {
        Write-Host "`nDeploying app to each server PC..." -ForegroundColor Yellow
        
        foreach ($ip in $PC_IPS) {
            Write-Host "`n-> Deploying to $ip..." -ForegroundColor Cyan
            
            # Copy project files
            # You need to have SSH access set up
            Write-Host "  [MANUAL] On $ip, run:"
            Write-Host "    cd $PROJECT_PATH"
            Write-Host "    docker compose -f deployment/docker-compose.app.yml up -d --build"
        }
    }
    
    "status" {
        Write-Host "`nHAProxy Status:" -ForegroundColor Yellow
        docker ps | findstr loadbalancer
        
        Write-Host "`nCheck stats: http://106.51.76.85:8404/stats" -ForegroundColor Cyan
    }
}

Write-Host "`nUsage:" -ForegroundColor Cyan
Write-Host "  .\setup-all.ps1 -Action setup-lb     # Setup load balancer"
Write-Host "  .\setup-all.ps1 -Action deploy-app   # Show deploy commands"
Write-Host "  .\setup-all.ps1 -Action status       # Check status"
