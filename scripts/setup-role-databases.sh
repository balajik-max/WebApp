#!/bin/bash
# Setup script for multi-database role isolation
# Run this on the PostgreSQL server (192.168.10.81)

set -e

echo "=== Setting up multi-database role isolation ==="

# Database names
DATABASES=(
    "davangere_admin"
    "davangere_architect"
    "davangere_commissioner"
    "davangere_aee"
    "davangere_ae"
    "davangere_mla"
)

# PostgreSQL credentials
PG_USER="postgres_admin"
PG_PASS="jvpiLtvqdqqSZ1HdBVEgokQk8Bzww"

# Set password for psql
export PGPASSWORD=$PG_PASS

echo "Creating databases..."

for DB in "${DATABASES[@]}"; do
    echo "  Creating database: $DB"
    psql -h localhost -U $PG_USER -d postgres -c "CREATE DATABASE $DB;" 2>/dev/null || echo "    Database $DB already exists"
done

echo "Granting privileges..."

for DB in "${DATABASES[@]}"; do
    echo "  Granting privileges on: $DB"
    psql -h localhost -U $PG_USER -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE $DB TO $PG_USER;"
done

echo ""
echo "=== Databases created successfully ==="
echo ""
echo "Database list:"
psql -h localhost -U $PG_USER -d postgres -c "\l" | grep davangere

echo ""
echo "Next steps:"
echo "1. Update docker-compose.yml to expose these databases"
echo "2. Restart the backend service"
echo "3. Test with different user roles"
