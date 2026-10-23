#!/bin/sh
# Runs once, when a service's PostgreSQL volume is first created (docker-entrypoint-initdb.d).
# POSTGRES_USER is the container's admin (superuser) and is used ONLY for this bootstrap.
# The microservice connects as APP_DB_USER: a non-superuser that can reach its own database only.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_user="$APP_DB_USER" -v app_pass="$APP_DB_PASSWORD" -v db="$POSTGRES_DB" <<'EOSQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_pass' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE :"db" TO :"app_user";
ALTER SCHEMA public OWNER TO :"app_user";
EOSQL
echo "app role $APP_DB_USER created for $POSTGRES_DB"
