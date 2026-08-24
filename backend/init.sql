-- ---------------------------------------------------------------------
-- PostGIS bootstrap. Runs once when the PostgreSQL data volume is empty.
-- Executed by the postgis/postgis image via /docker-entrypoint-initdb.d.
-- ---------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Safety net: a request that opens a transaction (e.g. an AI /explain call
-- that blocks on a slow local LLM) and then gets abandoned — the client
-- disconnects, the process is killed, whatever — can otherwise leave that
-- transaction sitting "idle in transaction" forever, since Postgres has no
-- default limit on that. A later request touching the SAME row (e.g. the
-- next /explain call, writing explanation_text back) then blocks on that
-- row's lock indefinitely too, with no way to recover short of manually
-- finding and killing the stuck backend PID. Auto-killing a transaction
-- that's been sitting idle for a full minute makes one abandoned request
-- self-heal instead of cascading into every future request on that row.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '60s');
END $$;
