# HAProxy Load Balancer Setup Guide
# ================================

## Architecture
```
                    Internet
                       │
                       ▼
              ┌────────────────┐
              │  106.51.76.85  │  ← Your PC (PC1)
              │    HAProxy     │
              │   :80 / :443   │
              └───────┬────────┘
                      │
        ┌─────────────┼─────────────┬─────────────┐
        ▼             ▼             ▼             ▼
      PC2           PC3           PC4           PC5
    :3000          :3000         :3000         :3000
    (app)          (app)         (app)         (app)
        │             │             │             │
        └─────────────┴──────┬──────┴─────────────┘
                             ▼
                           PC1
                      PostgreSQL DB
                        :5432
```

## PC Roles
- **PC1 (Your PC)**: HAProxy Load Balancer + Database
- **PC2-PC5**: App Servers (Frontend + Backend)

---

## STEP 1: Setup Database (PC1)

### 1.1 Start PostgreSQL
```powershell
cd "H:\testing webapp"
docker compose up -d db
```

### 1.2 Verify DB is Running
```powershell
docker ps | findstr postgres
```

### 1.3 Note Your IPs
```powershell
# Find your IPs
ipconfig
```
- Ethernet IP: 192.168.10.94 (for LAN PCs)
- Tailscale IP: 100.96.128.3 (for remote PCs)

---

## STEP 2: Setup HAProxy Load Balancer (PC1)

### 2.1 Run Setup Script
```powershell
cd "H:\testing webapp\deployment"
.\setup-haproxy.ps1
```

### 2.2 Update haproxy.cfg (IMPORTANT!)

Edit `deployment\haproxy\haproxy.cfg` and update server IPs:

```
backend app_servers
    server pc2 192.168.10.95:3000 check cookie pc2
    server pc3 192.168.10.96:3000 check cookie pc3
    server pc4 192.168.10.97:3000 check cookie pc4
    server pc5 192.168.10.98:3000 check cookie pc5
```

Replace IPs with actual IPs of your other PCs.

### 2.3 Restart HAProxy After Changes
```powershell
cd "H:\testing webapp\deployment"
docker compose -f docker-compose.lb.yml restart
```

### 2.4 Check Stats Dashboard
Open: http://106.51.76.85:8404/stats
- Username: admin
- Password: admin123

---

## STEP 3: Setup App Servers (PC2-PC5)

### 3.1 On EACH PC, Do This:

#### A. Copy Project Files
Copy the entire `H:\testing webapp` folder to each PC.

#### B. Update .env File
Edit `.env` and change DATABASE_URL:
```bash
# Point to YOUR PC's DB
DATABASE_URL=postgresql://postgres:jvpiLtvqdqqSZ1HdBVEgokQk8Bzww@192.168.10.94:5432/davangere_urban
```

Use your PC's IP (192.168.10.94 for LAN, or 100.96.128.3 for Tailscale).

#### C. Build and Start
```powershell
cd "H:\testing webapp"
docker compose -f deployment/docker-compose.app.yml up -d --build
```

#### D. Verify
```powershell
docker ps
curl http://localhost:3000
```

---

## STEP 4: Open Firewall (PC1)

Run as Administrator:
```powershell
netsh advfirewall firewall add rule name="HAProxy HTTP" dir=in action=allow protocol=tcp localport=80
netsh advfirewall firewall add rule name="HAProxy HTTPS" dir=in action=allow protocol=tcp localport=443
netsh advfirewall firewall add rule name="HAProxy Stats" dir=in action=allow protocol=tcp localport=8404
```

---

## STEP 5: Test Everything

### Test from PC2-PC5:
```powershell
curl http://localhost:3000
```

### Test from Internet:
Open browser: http://106.51.76.85

### Test HAProxy Stats:
Open browser: http://106.51.76.85:8404/stats

---

## Troubleshooting

### HAProxy won't start
```powershell
docker logs loadbalancer
```

### Can't connect to DB from app servers
- Check DB is running: `docker ps | findstr postgres`
- Check firewall: Port 5432 must be open
- Test connection: `psql -h 192.168.10.94 -U postgres`

### App servers not showing in HAProxy
- Check app is running: `curl http://PC_IP:3000`
- Check firewall: Port 3000 must be open on each app PC

---

## Files Reference

| File | Location |
|------|----------|
| HAProxy Config | `deployment/haproxy/haproxy.cfg` |
| HAProxy Compose | `deployment/docker-compose.lb.yml` |
| App Server Compose | `deployment/docker-compose.app.yml` |
| Setup Scripts | `deployment/setup-haproxy.ps1`, `setup-app-server.ps1` |
