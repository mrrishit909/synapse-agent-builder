# SYNAPSE: one command per job. Ports: web 8441, API 8440, Postgres 55440, mail sink 8442.
.PHONY: dev seed test e2e load-test reset build typecheck openapi record

dev:        ## full stack in Docker: web, API, Postgres, mail sink, OpenTelemetry collector, generator
	docker compose up --build -d --wait
	@echo "web http://localhost:8441  api http://localhost:8440/openapi.json"

seed:       ## regenerate fixtures and reset the database (owner connection)
	node data/simulators/generate.ts
	node apps/api/src/migrate.ts && node apps/api/src/seed.ts --reset

test:       ## unit tests (coverage >= 85% of domain logic) + API contract tests against a throwaway Postgres
	docker compose --profile test run --rm --build test

e2e:        ## Playwright against the static export (needs Google Chrome)
	npm run build -w @synapse/web
	npx playwright test

load-test:  ## concurrent runs + trace streams against a running API (start it with RATE_LIMIT=1000000)
	node tests/performance/load.ts http://127.0.0.1:8440 32 10 1000

reset:
	docker compose down -v
	docker compose up --build -d --wait

build:      ## static export for GitHub Pages
	NEXT_PUBLIC_BASE_PATH=/projects/synapse-agent-builder/demo npm run build -w @synapse/web

typecheck:
	npx tsc -p . && (cd apps/web && npx tsc --noEmit -p .)

openapi:
	node -e "import('./apps/api/src/server.ts').then(async (m) => { const app = await m.build({ logger: false }); await app.ready(); require('fs').writeFileSync('docs/openapi.json', JSON.stringify(app.swagger(), null, 1)); await app.close(); process.exit(0); })"

record:     ## captioned demo recording -> docs/video/demo.mp4
	node scripts/record-demo.ts
