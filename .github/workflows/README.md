# GitHub Actions Workflows (`reapd`)

CI checks are split into dedicated, parallel workflows that evolve as each roadmap phase lands:

| Workflow | File | What it verifies |
|---|---|---|
| **Type checks** | `all_type_checks.yml` | Runs `tsc --noEmit` across backend (`@reapd/types`, `db`, `docker-client`, `worker`, `api`) and frontend (`@reapd/web`) workspaces |
| **Lint checks** | `all_lint_checks.yml` | Runs `shellcheck` on `infra/scripts/*.sh`, validates `docker-compose.yml`, and enforces 4-layer architecture dependency boundaries |
| **Backend unit tests** | `backend_unit_tests.yml` | Runs unit tests (`docker-client`, `worker`) and PostgreSQL 17 integration tests (`@reapd/db` against a live `postgres:17-alpine` service) |
| **Full-stack smoke tests** | `full_stack_smoke_tests.yml` | Boots the full Docker Compose stack (Traefik + Socket Proxy + Postgres 17 + Redis 7 + mkcert) and runs the end-to-end Phase 2, 3, and 4 verification gates |
| **Check PR Description** | `check_pr_description.yml` | Ensures every PR includes required `.github/pull_request_template.md` sections (`Explanation`, `Checklist`, `Verification`, `LLM Disclosure`) |
| **Validate PR branch name** | `validating_pr_branch_name.yml` | Prevents PRs from being opened directly from `main` or `release-*` branches |

