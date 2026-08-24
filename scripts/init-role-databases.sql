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

-- Safety net: a request that opens a transaction (e.g. an AI /explain call
-- that blocks on a slow local LLM) and then gets abandoned can otherwise
-- leave that transaction "idle in transaction" forever, since Postgres has
-- no default limit on that — and a later request touching the same row
-- then blocks on its lock indefinitely too, with no way to recover short of
-- manually finding and killing the stuck backend PID. Auto-killing a
-- transaction idle for a full minute makes one abandoned request self-heal
-- instead of cascading into every future request on that row.
ALTER DATABASE davangere_admin SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE davangere_architect SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE davangere_commissioner SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE davangere_aee SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE davangere_ae SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE davangere_mla SET idle_in_transaction_session_timeout = '60s';
