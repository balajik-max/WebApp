-- PostgreSQL init script for multi-database role isolation
-- This runs automatically when the PostgreSQL container starts

-- Create role-specific databases
SELECT 'CREATE DATABASE davangere_admin'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_admin')\gexec

SELECT 'CREATE DATABASE davangere_architect'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_architect')\gexec

SELECT 'CREATE DATABASE davangere_commissioner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_commissioner')\gexec

SELECT 'CREATE DATABASE davangere_aee'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_aee')\gexec

SELECT 'CREATE DATABASE davangere_ae'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_ae')\gexec

SELECT 'CREATE DATABASE davangere_mla'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_mla')\gexec

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE davangere_admin TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE davangere_architect TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE davangere_commissioner TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE davangere_aee TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE davangere_ae TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE davangere_mla TO postgres_admin;
