SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help up down dev build test migrate eval sleep mcp logs clean deploy

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## Boot local infra (postgres+pgvector, redis, minio)
	docker compose up -d
	@echo "waiting for postgres..." && sleep 3
	$(MAKE) migrate

down: ## Stop local infra
	docker compose down

dev: up build ## Boot infra, build packages, then run memory MCP + sleep scheduler + agent
	@echo "Engram dev stack up. Memory MCP: 'make mcp'  Sleep: 'make sleep'  Eval: 'make eval'"

build: ## Build all workspace packages
	pnpm install --frozen-lockfile || pnpm install
	pnpm run build

test: ## Run all package tests (works offline with QWEN_MOCK=true)
	pnpm run test

migrate: ## Apply memory DB migrations
	pnpm run migrate

mcp: ## Run the memory MCP server (stdio) for a tenant (TENANT=...)
	ENGRAM_TENANT_ID=$(TENANT) pnpm run memory:mcp

sleep: ## Run the sleep-phase scheduler (or force a cycle: make sleep TENANT=... FORCE=1)
	pnpm run memory:sleep

eval: ## Run the eval harness (emits JSON + markdown report)
	pnpm run eval

viewer: ## Build + run the brain viewer on http://localhost:8080 (host, tsx)
	pnpm --filter @engram/viewer build
	VIEWER_PORT=8080 pnpm --filter @engram/viewer start

viewer-docker: ## Run the brain viewer as a container (docker compose profile)
	docker compose --profile viewer up --build viewer

logs: ## Tail local infra logs
	docker compose logs -f

clean: ## Stop infra and wipe local volumes
	docker compose down -v && rm -rf .data

deploy: ## Deploy to Alibaba Cloud (config swap). See deploy/alibaba/README.md
	@echo "Alibaba deploy is config-driven. See deploy/alibaba/ — set ENGRAM_INFRA=alibaba and run deploy/alibaba/deploy.sh"
	@bash deploy/alibaba/deploy.sh
