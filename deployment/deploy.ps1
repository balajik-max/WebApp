# deploy.ps1 - Run this on PC1 (Manager)
# =========================================

param(
    [string]$Action = "deploy"
)

$ErrorActionPreference = "Stop"

# ---- Configuration ----
$MANAGER_IP = "192.168.10.94"
$WORKER_IPS = @("192.168.10.95", "192.168.10.96", "192.168.10.97", "192.168.10.98")
$PROJECT_PATH = "H:\testing webapp"

Write-Host "=== Davangere Swarm Deployment ===" -ForegroundColor Cyan

switch ($Action) {
    "init" {
        Write-Host "`n[1/4] Initializing Swarm on manager ($MANAGER_IP)..." -ForegroundColor Yellow
        docker swarm init --advertise-addr $MANAGER_IP
        
        $token = (docker swarm join-token worker).Split("`n") | Where-Object { $_ -match "SWMTKN" } | Select-Object -First 1
        $token = $token.Trim()
        
        Write-Host "`n[2/4] Joining worker nodes..." -ForegroundColor Yellow
        foreach ($ip in $WORKER_IPS) {
            Write-Host "  -> Joining $ip ..."
            # Run on remote PC
            Write-Host "  [MANUAL] Run on $ip :"
            Write-Host "    docker swarm join --token $token ${MANAGER_IP}:2377" -ForegroundColor Green
        }
        
        Write-Host "`n[3/4] Labeling DB server..." -ForegroundColor Yellow
        Write-Host "  [MANUAL] Run on PC6 ($($WORKER_IPS[-1])) :"
        Write-Host "    docker node update --label-add db=true $(hostname)" -ForegroundColor Green
        
        Write-Host "`n[4/4] Creating overlay network..." -ForegroundColor Yellow
        docker network create --driver overlay --attachable davangere-net
        
        Write-Host "`n=== Setup Complete ===" -ForegroundColor Green
        Write-Host "Next: Run '.\deploy.ps1 -Action deploy'" -ForegroundColor Cyan
    }
    
    "deploy" {
        Write-Host "`n[1/2] Building images..." -ForegroundColor Yellow
        Push-Location $PROJECT_PATH
        docker compose -f deployment/docker-compose.swarm.yml build
        Pop-Location
        
        Write-Host "`n[2/2] Deploying stack..." -ForegroundColor Yellow
        Push-Location $PROJECT_PATH
        docker stack deploy -c deployment/docker-compose.swarm.yml davangere
        Pop-Location
        
        Write-Host "`n=== Deployed! ===" -ForegroundColor Green
        Write-Host "Check status: docker stack services davangere"
    }
    
    "status" {
        Write-Host "`nCluster Nodes:" -ForegroundColor Yellow
        docker node ls
        
        Write-Host "`nStack Services:" -ForegroundColor Yellow
        docker stack services davangere
        
        Write-Host "`nService Tasks:" -ForegroundColor Yellow
        docker stack ps davangere
    }
    
    "scale" {
        Write-Host "`nScaling backend to 8 replicas..." -ForegroundColor Yellow
        docker service scale davangere_backend=8
        docker service scale davangere_frontend=8
    }
    
    "remove" {
        Write-Host "`nRemoving stack..." -ForegroundColor Yellow
        docker stack rm davangere
        Write-Host "Stack removed." -ForegroundColor Green
    }
}
