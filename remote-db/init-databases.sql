-- init-databases.sql
-- Creates role-specific databases for data isolation
-- This runs automatically when PostgreSQL container starts

-- Create role-specific databases
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_admin') THEN
        CREATE DATABASE davangere_admin;
    END IF;
    
    IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_architect') THEN
        CREATE DATABASE davangere_architect;
    END IF;
    
    IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_commissioner') THEN
        CREATE DATABASE davangere_commissioner;
    END IF;
    
    IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_aee') THEN
        CREATE DATABASE davangere_aee;
    END IF;
    
    IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_ae') THEN
        CREATE DATABASE davangere_ae;
    END IF;
    
    IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'davangere_mla') THEN
        CREATE DATABASE davangere_mla;
    END IF;
END $$;

-- Grant privileges to postgres_admin
GRANT ALL PRIVILEGES ON DATABASE davangere_admin TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE davangere_architect TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE davangere_commissioner TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE davangere_aee TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE davangere_ae TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE davangere_mla TO postgres_admin;

-- Enable PostGIS extension in all databases
\c davangere_admin
CREATE EXTENSION IF NOT EXISTS postgis;
\c davangere_architect
CREATE EXTENSION IF NOT EXISTS postgis;
\c davangere_commissioner
CREATE EXTENSION IF NOT EXISTS postgis;
\c davangere_aee
CREATE EXTENSION IF NOT EXISTS postgis;
\c davangere_ae
CREATE EXTENSION IF NOT EXISTS postgis;
\c davangere_mla
CREATE EXTENSION IF NOT EXISTS postgis;

-- Return to main database
\c davangere_auth
