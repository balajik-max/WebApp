# PostgreSQL Setup for 192.168.10.81
# Multi-database role isolation

## Quick Start (3 steps)

### Step 1: Copy these files to 192.168.10.81

Copy the `remote-db` folder to 192.168.10.81:
```
remote-db/
├── docker-compose.yml
└── init-databases.sql
```

### Step 2: Run on 192.168.10.81

SSH into 192.168.10.81 and run:
```bash
cd remote-db
docker compose up -d
```

### Step 3: Verify

Check if PostgreSQL is running:
```bash
docker ps | grep davangere_role_db
```

Check if databases were created:
```bash
docker exec -it davangere_role_db psql -U postgres_admin -d davangere_auth -c "\l"
```

You should see:
- davangere_auth (main)
- davangere_admin
- davangere_architect
- davangere_commissioner
- davangere_aee
- davangere_ae
- davangere_mla

## What This Does

1. **Creates a PostgreSQL container** with PostGIS support
2. **Creates 7 databases** (1 auth + 6 role-specific)
3. **Enables PostGIS** extension in all databases
4. **Exposes port 5432** for connections from the backend

## Database URLs (for backend)

```
Auth:    postgresql+asyncpg://postgres_admin:jvpiLtvqdqqSZ1HdBVEgokQk8Bzww@192.168.10.81:5432/davangere_auth
Admin:   postgresql+asyncpg://postgres_admin:jvpiLtvqdqqSZ1HdBVEgokQk8Bzww@192.168.10.81:5432/davangere_admin
MLA:     postgresql+asyncpg://postgres_admin:jvpiLtvqdqqSZ1HdBVEgokQk8Bzww@192.168.10.81:5432/davangere_mla
AE:      postgresql+asyncpg://postgres_admin:jvpiLtvqdqqSZ1HdBVEgokQk8Bzww@192.168.10.81:5432/davangere_ae
AEE:     postgresql+asyncpg://postgres_admin:jvpiLtvqdqqSZ1HdBVEgokQk8Bzww@192.168.10.81:5432/davangere_aee
```

## Troubleshooting

If port 5432 is already in use:
```bash
# Stop existing PostgreSQL
sudo systemctl stop postgresql

# Or change port in docker-compose.yml
ports:
  - "5433:5432"
```

If connection refused:
```bash
# Check if container is running
docker ps | grep davangere_role_db

# Check logs
docker logs davangere_role_db
```
