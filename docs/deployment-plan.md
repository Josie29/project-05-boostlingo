# Deployment plan — AWS service mapping

Local-first is deliberate: everything below runs today on one laptop (SQLite,
one Kestrel process, Vite dev server). This table maps each piece of
application functionality to the AWS service it would deploy to, so the local
→ cloud path is decided before any infra work starts.

| Functionality | Local today | AWS service | Notes |
| --- | --- | --- | --- |
| Frontend static app (Vite/React build) | Vite dev server | S3 + CloudFront | Static bundle; CloudFront also fronts the backend origin so `/api` and `/ws` stay same-origin (no CORS), as the Vite proxy does locally. |
| Backend API (`/healthz`, `/api/languages`, `/api/realtime/session`, `/api/metrics/*`) | Kestrel (`dotnet run`) | ECS Fargate behind an ALB | One container image (built from the backend Dockerfile, pushed to ECR). ALB health check targets `/healthz`. |
| Cascade WebSocket (`/ws/cascade`) | Same Kestrel process | Same ECS service via ALB | ALB supports WebSockets; raise its idle timeout above the longest expected session (default 60 s would sever a quiet call). Sessions are stateful in-process — fine at demo scale on one task; scaling out needs sticky routing. |
| Realtime mode (browser ↔ OpenAI WebRTC) | Direct connection | None | Traffic never touches AWS; only the ephemeral-secret mint (`/api/realtime/session`) does. |
| Session-metrics persistence (`ISessionMetricsStore`) | SQLite file (`backend/data/metrics.db`) | RDS PostgreSQL | Swap in a Postgres `ISessionMetricsStore` implementation; endpoints/schema carry over. Fargate task storage is ephemeral, so file-on-disk SQLite does not survive a redeploy. Cheaper interim: SQLite on an EFS mount, single task only. |
| Provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) | `.env` / user-secrets | Secrets Manager | Injected into the task definition as secrets, never baked into the image. |
| Non-secret config (`TRANSLATION_PROVIDER`, `METRICS_DB_PATH`→connection string) | `.env` | SSM Parameter Store | Plain env vars on the task definition are acceptable at this scale. |
| Container images | — | ECR | Built/pushed by CI. |
| Logs (session lifecycle, per-stage errors, audio telemetry) | Console | CloudWatch Logs | `awslogs` driver on the task; structured console logging carries over unchanged. |
| DNS + TLS | localhost | Route 53 + ACM | Cert on CloudFront and the ALB. |
| CI/CD (`dotnet test` + `vitest` gate, then deploy) | Manual | GitHub Actions → ECR/ECS | OIDC role assumption, no long-lived AWS keys in the repo. |

## Sequencing

1. Containerize the backend; serve the built frontend from S3/CloudFront.
2. Stand up ECS + ALB with Secrets Manager wiring; validate a cascade session
   over the ALB (WebSocket idle timeout, `/healthz` target checks).
3. Only then move metrics off SQLite to RDS — the `ISessionMetricsStore` seam
   exists precisely so steps 1–2 don't wait on a database.
