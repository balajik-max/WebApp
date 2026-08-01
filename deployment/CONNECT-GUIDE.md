# How to Connect & Configure Each PC
# ================================

## YOUR PC (PC1) - The Load Balancer
IP: 192.168.10.94
Role: HAProxy + Database

## OTHER PCs (App Servers)
Role: Frontend + Backend

---

## STEP 1: Prepare Files on YOUR PC (PC1)

```powershell
cd "H:\testing webapp\deployment"
.\prepare-servers.ps1
```

This creates: `H:\shared\davangere\` with all files.

---

## STEP 2: Copy to Each App Server PC

### Option A: Network Share (Recommended)
1. Share the folder: Right-click `H:\shared\davangere` → Properties → Sharing → Share
2. On other PC, access: `\\192.168.10.94\davangere`
3. Copy to their PC (e.g., `D:\davangere`)

### Option B: USB Drive
1. Copy `H:\shared\davangere` to USB
2. Plug into each PC, copy to `D:\davangere`

### Option C: Direct Copy (if same network)
```powershell
# Run on OTHER PC
Copy-Item -Path "\\192.168.10.94\shared\davangere" -Destination "D:\davangere" -Recurse
```

---

## STEP 3: Configure Each App Server PC

Run on **EACH** app server PC:

```powershell
cd D:\davangere
.\setup-appserver.ps1
```

Or manually:

```powershell
cd D:\davangere

# Edit .env file
notepad .env
```

Change this line:
```
DATABASE_URL=postgresql://postgres:jvpiLtvqdqqSZ1HdBVEgokQk8Bzww@192.168.10.94:5432/davangere_urban
```
(Use YOUR PC's IP: 192.168.10.94)

Then:
```powershell
docker compose up -d --build
```

---

## STEP 4: Open Firewall on Each App Server PC

Run as **Administrator** on each PC:

```powershell
netsh advfirewall firewall add rule name="App Server" dir=in action=allow protocol=tcp localport=3000
netsh advfirewall firewall add rule name="Backend API" dir=in action=allow protocol=tcp localport=8000
```

---

## STEP 5: Verify Everything

### On YOUR PC (PC1):
```powershell
# Check HAProxy
docker ps | findstr loadbalancer

# Check stats
http://localhost:8404/stats
```

### On EACH App Server PC:
```powershell
# Check containers
docker ps

# Test local access
curl http://localhost:3000
```

### From YOUR PC, test connection:
```powershell
# Replace with actual app server IP
curl http://192.168.10.95:3000
```

---

## Troubleshooting

### Can't connect to other PC?
1. Check IP: `ipconfig` on both PCs
2. Ping test: `ping 192.168.10.95`
3. Firewall: Open ports 3000 and 8000

### Docker build fails?
1. Check Docker is running
2. Check disk space
3. Check internet connection

### App won't start?
1. Check logs: `docker compose logs`
2. Check .env file has correct DB URL
3. Check PostgreSQL is running on PC1
