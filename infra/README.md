## infra

Infrastructure for the reapd local development stack and production deployment.

### Local development quick-start

```bash
# 1. Generate wildcard TLS certs for *.preview.localhost
npm run certs:gen

# 2. Start the full local stack (Traefik, Socket Proxy, PostgreSQL, Redis)
npm run infra:up

# 3. Apply the database schema
docker exec -i reapd-postgres psql -U reapd -d reapd < packages/db/src/migrations/0001_initial_schema.sql

# 4. Run the Phase 1 smoke test — verifies end-to-end routing
bash infra/scripts/cli-smoke.sh
```

### Stack components

| Service | Local port (loopback only) | Purpose |
|---|---|---|
| Traefik | 127.0.0.1:80, 443, 8080 | Reverse proxy + TLS termination |
| Docker Socket Proxy | 127.0.0.1:2375 | Restricted Docker API access |
| PostgreSQL 17 | 127.0.0.1:5432 | Primary relational database |
| Redis 7 | 127.0.0.1:6379 | BullMQ job queue + log streams |

All published ports bind to `127.0.0.1` (enforced in CI). The API also listens on loopback by
default (`REAPD_API_HOST`). If you tunnel webhooks (ngrok / cloudflared), point the tunnel at
`127.0.0.1:3001`.

### Networks

- `control-internal` — Fastify API, Worker, PostgreSQL, Redis. Isolated from preview containers.
- `preview-edge` — Traefik, preview containers, Playwright runner. `icc=false` disables inter-container comms.

