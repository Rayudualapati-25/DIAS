# Crime Records Access Network — operational entry points.
#
# Every command in the project is a target here, so nothing has to be
# remembered as a long path. Run `make` with no target for the list.

SHELL := /bin/bash

# Optional local overrides. `.env` is ignored; `.env.example` documents every
# supported value. Values are exported to Node, Compose, and helper scripts.
ifneq (,$(wildcard .env))
include .env
export
endif

CHANNEL ?= crimechannel
# The SEAL-era deployment. DIAS deploys under its own name so both can coexist.
CC_NAME ?= crimerecords
CC_VERSION ?= 3.7

# --- DIAS ------------------------------------------------------------------
# Separate chaincode name, separate model port. Nothing here touches the
# crimerecords deployment or a service on port 8080.
DIAS_CC_NAME ?= diasrecords
DIAS_CC_VERSION ?= 1.0
DIAS_MODEL_PORT ?= 8081
DIAS_MODEL_URL ?= http://127.0.0.1:$(DIAS_MODEL_PORT)/v1
# Serve the untouched base by default. Point at an adapter directory to serve a
# fine-tuned model: `make dias-model DIAS_ADAPTER=LLMxAI/.../qwen3-14b-dias-lora-v7`
DIAS_ADAPTER ?=
FABRIC_VERSION ?= 2.5.16
FABRIC_CA_VERSION ?= 1.5.22
# 'auto' resolves to committed sequence + 1, so a fresh network deploys at 1 and
# an upgrade increments correctly. Override only to pin a specific sequence:
#   make deploy CC_SEQUENCE=3
CC_SEQUENCE ?= auto

# Export the pinned image versions to Compose. Docker otherwise uses the
# caller's current context; set DOCKER_CONTEXT explicitly when an override is
# required (for example: `make up DOCKER_CONTEXT=colima`).
export FABRIC_VERSION FABRIC_CA_VERSION
ifneq ($(strip $(DOCKER_CONTEXT)),)
export DOCKER_CONTEXT
endif

.PHONY: help all install check repo-check doctor llm-key up down deploy seed seed-users seed-domain seed-records backend model ai ollama test test-chaincode \
        test-backend test-policies test-frontend test-dataset test-live \
        dias-all dias-deploy dias-seed dias-key dias-register dias-model dias-ai dias-backend \
        dias-scenarios dias-readiness dias-subsets \
        smoke prove inspect verify-log measure evaluate results caliper-install caliper-prepare \
        caliper-check caliper-monitoring-up caliper-monitoring-check caliper-monitoring-down caliper-smoke \
        caliper-read caliper-write caliper-load caliper-mixed caliper-endurance caliper-profile-graphs \
        caliper-latency-graphs caliper-plots ui-latency-run ui-latency-plots \
        ui-latency-verify dias-data dias-data-check dias-data-v1 clean-containers

UI_LATENCY_RUN ?= experiments/runs/2026-08-25T14-12-11-482Z_ui_interaction_latency
UI_LATENCY_OUTPUT ?= results/plots/ui-latency
DIAS_DATA_OUTPUT ?= experiments/dias-finetuning/data-next

help:
	@echo "Setup"
	@echo "  make all           everything: network, chaincode, users, then the app"
	@echo "  make install       install locked backend and chaincode dependencies"
	@echo "  make check         validate Compose files and shell-script syntax"
	@echo "  make repo-check    reject secrets, local state, and oversized Git files"
	@echo "  make doctor        report required local tools and active Docker context"
	@echo "  make llm-key       create or verify the local Ed25519 AI signing key"
	@echo "  make up            bring up the 6-organisation network (~3 min)"
	@echo "  make deploy        install and commit the chaincode"
	@echo "  make seed          issue the department users their certificates (Fabric CA)"
	@echo "  make seed-users    write those users onto the ledger (needed to sign in)"
	@echo "  make seed-domain   write departments and deterministic demo cases"
	@echo "  make seed-records  write synthetic metadata + agency-vault demo content"
	@echo "  make ollama        start the local LLM used for explanations"
	@echo
	@echo "DIAS (deploys as $(DIAS_CC_NAME); never touches crimerecords or port 8080)"
	@echo "  make dias-all      deploy DIAS, seed it, create the key, register the policy+model"
	@echo "  make dias-model    serve Qwen3-14B on :$(DIAS_MODEL_PORT)  [DIAS_ADAPTER=<dir> for a fine-tune]"
	@echo "  make dias-ai       the recommendation listener (advisory only)"
	@echo "  make dias-backend  the API on :3001"
	@echo "  make dias-scenarios  live Fabric acceptance suite (stop the listener first)"
	@echo "  make dias-readiness  computed completion checklist"
	@echo "  make dias-data     regenerate the binary v2 dataset"
	@echo "  make dias-data-check  validate it (25 checks)"
	@echo "  make dias-subsets  rebuild the nested training subsets"
	@echo "  make backend       run the API and web interface on :3001"
	@echo "  make model         run the registered Qwen3-14B adapter on :8080"
	@echo "  make ai            run the AIOrg advisory-recommendation listener"
	@echo "  make down          stop the network and remove generated material"
	@echo
	@echo "Verification"
	@echo "  make test          all test suites"
	@echo "  make smoke         end-to-end scenario against the live network"
	@echo "  make prove         prove it is a real permissioned blockchain (10 checks)"
	@echo "  make inspect       read ledger state: blocks, endorsements, history"
	@echo "  make verify-log    read direct-ledger access events and integrity status"
	@echo
	@echo "Measurement"
	@echo "  make measure       latency, storage, attack replay"
	@echo "  make evaluate      explanation quality: template vs local LLM"
	@echo "  make dias-data     generate the versioned DIAS fine-tuning dataset"
	@echo "  make dias-data-check validate hashes, splits, schemas, and workflow coverage"
	@echo "  make caliper-install  install the pinned Caliper CLI and Fabric Gateway binding"
	@echo "  make caliper-check    validate Caliper dependencies, scripts, and all test configurations"
	@echo "  make caliper-prepare  validate the live network and generate the runtime connection file"
	@echo "  make caliper-monitoring-up     start the local Prometheus metrics collector"
	@echo "  make caliper-monitoring-check  require all 6 Fabric metrics targets to be ready"
	@echo "  make caliper-monitoring-down   stop the local Prometheus metrics collector"
	@echo "  make caliper-smoke    run the manual low-load Caliper connectivity benchmark"
	@echo "  make caliper-read     run the manual read-performance test"
	@echo "  make caliper-write    run the manual write-performance test"
	@echo "  make caliper-load     run the manual 1/2/5/10/20 TPS increasing-load test"
	@echo "  make caliper-mixed    run the manual deterministic 70/30 mixed-workload test"
	@echo "  make caliper-endurance run the manual two-hour endurance test"
	@echo "  make caliper-profile-graphs generate configured-input methodology figures (not results)"
	@echo "  make caliper-latency-graphs run five short measured latency tests and generate graphs"
	@echo "  make caliper-plots    generate paper figures from completed Caliper runs"
	@echo "  make ui-latency-run   run the live three-operation interactive latency study"
	@echo "  make ui-latency-plots regenerate UI-latency figures from UI_LATENCY_RUN"
	@echo "  make ui-latency-verify check raw samples, tables, figures, and paper claims"
	@echo "  make results       list generated result files"
	@echo
	@echo "Maintenance"
	@echo "  make clean-containers   remove stale chaincode build containers"

# --- setup -----------------------------------------------------------------

install:
	cd chaincode/crimerecords && npm ci
	cd backend && npm ci

# Fast, read-only checks suitable before starting or changing the network.
check: repo-check
	docker compose -f network/compose/compose-ca.yaml config --quiet
	docker compose -f network/compose/compose-net.yaml config --quiet
	bash -n scripts/network-up.sh scripts/network-down.sh scripts/inspect-ledger.sh \
		scripts/dias/train-v7.sh scripts/dias/evaluate-v7.sh \
		experiments/runs/20260912_dias_qwen3_baseline/run-baseline.sh

repo-check:
	python3 scripts/check-repository.py

doctor:
	@PATH="$(abspath ../fabric-samples/bin):$$PATH"; export PATH; status=0; \
	for command in docker node npm peer configtxgen osnadmin fabric-ca-client jq; do \
		if command -v "$$command" >/dev/null 2>&1; then \
			printf '  %-18s %s\n' "$$command" "found"; \
		else \
			printf '  %-18s %s\n' "$$command" "missing"; status=1; \
		fi; \
	done; \
	printf '  %-18s %s\n' "Fabric images" "peer/orderer $(FABRIC_VERSION), CA $(FABRIC_CA_VERSION)"; \
	if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then \
		printf '  %-18s %s\n' "Docker context" "$$(docker context show)"; \
	else \
		printf '  %-18s %s\n' "Docker daemon" "unreachable"; status=1; \
	fi; \
	exit $$status

# One command from nothing to a working system. The order is not arbitrary:
# the chaincode has to be committed before any user can be written to the
# ledger, and the users have to be on the ledger before anyone can sign in.
all: llm-key up deploy seed seed-users seed-domain seed-records
	@echo
	@echo "Everything is up. Start the web interface with:  make backend"
	@echo "Then open http://localhost:3001 and select the sho.reddy Fabric identity"

up:
	scripts/network-up.sh $(CHANNEL)

llm-key:
	node scripts/ensure-llm-signing-key.js

deploy:
	cd network && bash scripts/deployCC.sh $(CHANNEL) $(CC_NAME) $(CC_VERSION) $(CC_SEQUENCE)

# Step 1 of registration: the Fabric CAs issue X.509 certificates.
seed:
	cd network && bash scripts/seed-identities.sh

# Step 2: the accounts themselves, written onto the blockchain. Sign-in reads
# from here — there is no user database.
seed-users:
	node scripts/seed-users-onchain.js

seed-domain:
	node scripts/seed-domain.js

seed-records:
	node scripts/seed-demo-records.js

ollama:
	scripts/setup-ollama.sh

backend:
	cd backend && npm start

model:
	.venv-qwen-policy/bin/mlx_lm.server \
		--model mlx-community/Qwen3-14B-4bit \
		--adapter-path "$(abspath LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v6-best)" \
		--host 127.0.0.1 --port 8080 --max-tokens 192 \
		--chat-template-args '{"enable_thinking":false}'

## ai: run the policy model as a network participant. It listens for
## AccessRequestCreated, reads the request context from the ledger, runs the
## fine-tuned model, and records an advisory recommendation signed as
## AIOrgMSP/llm-decider. Only an auditor (or an existing exact dynamic rule)
## creates a final access decision.
ai:
	cd backend && npm run ai

# The listener stops itself when a request cannot be decided, so that a committed
# but unanswered request stays retryable. Something has to restart it; this is
# that something. Deployment configuration only — it changes no application
# behaviour, and every exit and restart is logged.
ai-supervised:
	scripts/ai-listener-supervisor.sh

down:
	scripts/network-down.sh

# --- DIAS ------------------------------------------------------------------

## dias-all: deploy DIAS alongside the existing deployment and seed it.
## The network must already be up (`make up`) with identities issued (`make seed`).
dias-all: dias-deploy dias-seed dias-key dias-register
	@echo
	@echo "DIAS is deployed as $(DIAS_CC_NAME). Next:"
	@echo "  make dias-model     # serve the model on :$(DIAS_MODEL_PORT)"
	@echo "  make dias-ai        # the recommendation listener"
	@echo "  make dias-backend   # the API on :3001"

dias-deploy:
	cd network && bash scripts/deployCC.sh $(CHANNEL) $(DIAS_CC_NAME) $(DIAS_CC_VERSION) $(CC_SEQUENCE)

dias-seed:
	CHAINCODE=$(DIAS_CC_NAME) node scripts/seed-users-onchain.js
	CHAINCODE=$(DIAS_CC_NAME) node scripts/seed-domain.js
	CHAINCODE=$(DIAS_CC_NAME) node scripts/seed-demo-records.js

## dias-key: create the Ed25519 key that attests every recommendation and every
## generation-failure status. Idempotent; it refuses to overwrite an existing key.
dias-key:
	node scripts/dias/ensure-signing-key.js

## dias-register: register and activate the governance policy bundle and the
## model. Idempotent. Pass DIAS_ADAPTER to register a fine-tuned adapter, whose
## digest is recomputed from the bytes and must match.
dias-register:
	CHAINCODE=$(DIAS_CC_NAME) node scripts/dias/register-policy-and-model.js \
		--model-id $(if $(DIAS_ADAPTER),qwen3-14b-dias-v7,qwen3-14b-4bit-untuned) \
		--purpose $(if $(DIAS_ADAPTER),fine-tuned-candidate,research-baseline) \
		$(if $(DIAS_ADAPTER),--adapter-id $(notdir $(DIAS_ADAPTER)) --adapter-path $(DIAS_ADAPTER),)

## dias-model: serve Qwen3-14B for DIAS on :8081. Never 8080 — that port is
## left free for any existing service.
dias-model:
	.venv-qwen-policy/bin/mlx_lm.server \
		--model mlx-community/Qwen3-14B-4bit \
		$(if $(DIAS_ADAPTER),--adapter-path "$(abspath $(DIAS_ADAPTER))",) \
		--host 127.0.0.1 --port $(DIAS_MODEL_PORT) --max-tokens 512 \
		--chat-template-args '{"enable_thinking":false}'

## dias-ai: the recommendation listener. It records an advisory ALLOW/DENY or an
## attested failure status, and never writes an access decision.
dias-ai:
	CHAINCODE=$(DIAS_CC_NAME) DIAS_MODEL_URL=$(DIAS_MODEL_URL) node backend/src/ai/start.js

dias-backend:
	CHAINCODE=$(DIAS_CC_NAME) node backend/src/server.js

## dias-scenarios: the live Fabric acceptance suite. STOP the listener first —
## scenarios I-L answer requests themselves and must not race a second answerer.
dias-scenarios:
	CHAINCODE=$(DIAS_CC_NAME) DIAS_MODEL_URL=$(DIAS_MODEL_URL) \
		node scripts/dias/run-live-scenarios.js --out experiments/runs/$$(date -u +%Y%m%d)_dias_live_fabric

## dias-readiness: the computed completion checklist. Exits non-zero when an
## item has no supporting evidence.
dias-readiness:
	node scripts/dias/readiness.js

dias-subsets:
	cd experiments/dias-finetuning/v2 && npm run subsets

# --- verification ----------------------------------------------------------

test: test-chaincode test-backend test-policies test-frontend test-dataset

test-chaincode:
	cd chaincode/crimerecords && npm test

test-backend:
	cd backend && npm test

test-policies:
	cd policies && npm test

test-frontend:
	cd frontend && npm test

test-dataset:
	cd experiments/dias-finetuning/v2 && npm test

## test-live: HTTP integration tests. Requires the API, the listener, the model
## server and Fabric to be running; a missing service is a named precondition
## failure, not a confusing fetch error.
test-live:
	cd backend && npm run test:live

smoke:
	scripts/smoke-test.sh $(CHANNEL) $(CC_NAME)

prove:
	scripts/prove-permissioned.sh

inspect:
	scripts/inspect-ledger.sh

verify-log:
	scripts/verify-access-log.sh

# --- measurement -----------------------------------------------------------

measure:
	node experiments/measure.js $(N)

evaluate:
	node experiments/evaluate-explanations.js

## dias-data: regenerate the binary v2 dataset. Deterministic from its seed.
dias-data:
	node experiments/dias-finetuning/v2/generate.js

dias-data-check:
	node experiments/dias-finetuning/v2/validate.js

## dias-data-v1: the retired SEAL-era generator, kept so earlier runs remain
## reproducible. data-v1 is prior evidence and must not be regenerated in place.
dias-data-v1:
	node experiments/dias-finetuning/generate.js --output "$(DIAS_DATA_OUTPUT)"

caliper-install:
	cd benchmarks/caliper && npx --yes npm@11.5.1 ci --omit=dev
	cd benchmarks/caliper && node scripts/check-installation.js

caliper-check:
	cd benchmarks/caliper && npm run check

caliper-prepare:
	cd benchmarks/caliper && node scripts/prepare-network.js

caliper-monitoring-up:
	docker compose -f benchmarks/caliper/monitoring/compose.yaml up -d

caliper-monitoring-check:
	cd benchmarks/caliper && node scripts/check-monitoring.js

caliper-monitoring-down:
	docker compose -f benchmarks/caliper/monitoring/compose.yaml down

caliper-smoke: caliper-prepare
	cd benchmarks/caliper && node scripts/run-benchmark.js configs/smoke.yaml smoke

caliper-read: caliper-prepare caliper-monitoring-check
	cd benchmarks/caliper && node scripts/run-benchmark.js configs/read-performance.yaml read

caliper-write: caliper-prepare caliper-monitoring-check
	cd benchmarks/caliper && node scripts/run-benchmark.js configs/write-performance.yaml write

caliper-load: caliper-prepare caliper-monitoring-check
	cd benchmarks/caliper && node scripts/run-benchmark.js configs/increasing-load.yaml load

caliper-mixed: caliper-prepare caliper-monitoring-check
	cd benchmarks/caliper && node scripts/run-benchmark.js configs/mixed-workload.yaml mixed

caliper-endurance: caliper-prepare caliper-monitoring-check
	cd benchmarks/caliper && node scripts/run-benchmark.js configs/endurance.yaml endurance

caliper-profile-graphs:
	python3 benchmarks/caliper/scripts/generate-workload-profile-graphs.py

caliper-latency-graphs: caliper-prepare caliper-monitoring-check
	cd benchmarks/caliper && npm run benchmark:latency

caliper-plots:
	python3 results/plots/caliper_figure_set.py

ui-latency-run:
	node experiments/run-ui-latency.js

ui-latency-plots:
	python3 experiments/plot-ui-latency.py $(UI_LATENCY_RUN)/run-report.json \
		--output-dir $(UI_LATENCY_OUTPUT)

ui-latency-verify:
	node experiments/verify-ui-latency-artifacts.js

results:
	@ls -1 experiments/results/

# --- maintenance -----------------------------------------------------------

# Each chaincode deployment leaves inert build containers behind. Enough of them
# make Docker slow enough to cause spurious test failures.
clean-containers:
	@ids=$$(docker ps -aq --filter status=created); \
	if [ -n "$$ids" ]; then docker rm $$ids >/dev/null && echo "removed $$(echo $$ids | wc -w | tr -d ' ') stale containers"; \
	else echo "no stale containers"; fi
