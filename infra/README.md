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

| Service | Bound to loopback | Purpose |
|---|---|---|
| Traefik | 127.0.0.1:80\*, 127.0.0.1:443\*, 127.0.0.1:8080 | Reverse proxy + TLS termination |
| Docker Socket Proxy | 127.0.0.1:2375 | Restricted Docker API access |
| PostgreSQL 17 | 127.0.0.1:5432 | Primary relational database |
| Redis 7 | 127.0.0.1:6379 | BullMQ job queue + log streams |

All six published ports bind to `127.0.0.1` in `docker-compose.yml` (enforced in CI, and verified at
runtime via `ss -ltnH` on Linux). The API also listens on loopback by default (`REAPD_API_HOST`). If
you tunnel webhooks (ngrok / cloudflared), point the tunnel at `127.0.0.1:3001`.

> \* **macOS / Docker Desktop caveat (tested on Docker Desktop 4.97.0 / Engine 29.9.2):** Docker
> Desktop's privileged-port helper binds host ports below 1024 (Traefik's 80 and 443; see
> [`docker/for-mac#5590`](https://github.com/docker/for-mac/issues/5590)) on all interfaces
> regardless of the `127.0.0.1` prefix (`lsof -nP -iTCP:443 -sTCP:LISTEN` shows `*:443`). Ports
> 5432, 6379, 8080 and 2375 are strictly loopback-only on macOS, and the API is not routed through
> Traefik (Traefik's dashboard is on 8080 only). On untrusted networks on macOS, enable the system
> firewall or stop the stack. On Linux, the loopback bind applies to all six ports at runtime.

### Networks

- `control-internal` — Fastify API, Worker, PostgreSQL, Redis. Isolated from preview containers.
- `preview-edge` — Traefik, preview containers, Playwright runner. `icc=false` disables inter-container comms.

