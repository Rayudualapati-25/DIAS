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

# The base network's first channel. `make up` still creates the SEAL-era
# six-organization channel; DIAS runs on its own channel below. These names are
# deliberately not CHANNEL/CHAINCODE: the root .env is exported to every recipe,
# and the backend reads CHANNEL/CHAINCODE, so a Makefile default under those names
# would silently point the API at the retired deployment.
BASE_CHANNEL ?= crimechannel

# --- DIAS ------------------------------------------------------------------
# Separate channel, chaincode name and model port. Nothing here touches the
# crimechannel/crimerecords deployment or a service on port 8080. The DIAS
# channel has five organizations: the LLM runs in the application backend.
DIAS_CHANNEL ?= diaschannel
DIAS_CC_NAME ?= diasrecords
DIAS_CC_VERSION ?= 2.2
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

.PHONY: help all install check repo-check doctor up down deploy seed seed-users seed-domain seed-records dias-demo-data backend model ollama test test-chaincode \
        test-backend test-policies test-frontend test-dataset test-live \
        dias-all dias-channel dias-deploy dias-seed dias-model dias-backend \
        dias-acceptance dias-readiness dias-subsets \
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
	@echo "  make all           everything: network, identities, DIAS channel, chaincode, seed data"
	@echo "  make install       install locked backend and chaincode dependencies"
	@echo "  make check         repository check, Compose files and shell-script syntax"
	@echo "  make repo-check    reject secrets, local state, and oversized Git files"
	@echo "  make doctor        report required local tools and active Docker context"
	@echo "  make up            bring up the base Fabric network (~3 min; destroys a previous one)"
	@echo "  make seed          issue the department users their certificates (Fabric CA)"
	@echo "  make down          stop the network and remove generated material"
	@echo
	@echo "DIAS (channel $(DIAS_CHANNEL), chaincode $(DIAS_CC_NAME) $(DIAS_CC_VERSION))"
	@echo "  make dias-all      create the five-organization channel, deploy DIAS, and seed it"
	@echo "  make dias-model    serve Qwen3-14B on :$(DIAS_MODEL_PORT)  [DIAS_ADAPTER=<dir> for a fine-tune]"
	@echo "  make dias-backend  the API and web interface on :3001; it calls the LLM itself"
	@echo "  make backend       same as dias-backend"
	@echo "  make deploy        same as dias-deploy: install and commit the DIAS chaincode"
	@echo "  make dias-demo-data   the demo cases and case files the live suites use"
	@echo "  make seed-users / seed-domain / seed-records   the individual seed steps"
	@echo "  make dias-acceptance  live acceptance run through the backend API"
	@echo "  make dias-readiness  computed completion checklist"
	@echo "  make dias-data     regenerate the binary v2 dataset"
	@echo "  make dias-data-check  validate it (25 checks)"
	@echo "  make dias-subsets  rebuild the nested training subsets"
	@echo
	@echo "Verification"
	@echo "  make test          all offline test suites"
	@echo "  make smoke         live API suite against the running DIAS backend"
	@echo "  make test-live     same as smoke"
	@echo "  make prove         prove it is a real permissioned blockchain (10 checks; writes a proof record)"
	@echo "  make inspect       read DIAS ledger state: blocks, endorsements, history"
	@echo "  make verify-log    read direct-ledger access events and integrity status"
	@echo
	@echo "SEAL-era references (not used by DIAS)"
	@echo "  make model         serve the retired V6 adapter on :8080"
	@echo "  make ollama        start the local wording model used by make evaluate"
	@echo
	@echo "Measurement"
	@echo "  make measure       latency, storage, attack replay"
	@echo "  make evaluate      SEAL explanation quality: template vs local LLM"
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
# identities come from the CAs, the chaincode has to be committed before any user
# can be written to the ledger, and the users have to be on the ledger before
# anyone can sign in. `make up` tears down any previous network first.
all: up seed dias-all
	@echo
	@echo "Everything is up. Start the model and the API, each in its own terminal:"
	@echo "  make dias-model"
	@echo "  make dias-backend"
	@echo "Then open http://localhost:3001 and select the insp.sharma Fabric identity"

up:
	scripts/network-up.sh $(BASE_CHANNEL)

deploy: dias-deploy

# Step 1 of registration: the Fabric CAs issue X.509 certificates.
seed:
	cd network && bash scripts/seed-identities.sh

# Step 2: the accounts themselves, written onto the blockchain. Sign-in reads
# from here — there is no user database. These are the steps of dias-seed.
seed-users:
	CHANNEL=$(DIAS_CHANNEL) CHAINCODE=$(DIAS_CC_NAME) node scripts/seed-users-onchain.js

seed-domain:
	CHANNEL=$(DIAS_CHANNEL) CHAINCODE=$(DIAS_CC_NAME) node scripts/seed-domain.js $(SEED_DOMAIN_ARGS)

seed-records:
	CHANNEL=$(DIAS_CHANNEL) CHAINCODE=$(DIAS_CC_NAME) node scripts/seed-demo-records.js

ollama:
	scripts/setup-ollama.sh

backend: dias-backend

## model: the retired SEAL-era V6 adapter on :8080, kept for reference runs only.
model:
	.venv-qwen-policy/bin/mlx_lm.server \
		--model mlx-community/Qwen3-14B-4bit \
		--adapter-path "$(abspath LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v6-best)" \
		--host 127.0.0.1 --port 8080 --max-tokens 192 \
		--chat-template-args '{"enable_thinking":false}'

down:
	scripts/network-down.sh

# --- DIAS ------------------------------------------------------------------

## dias-all: create the DIAS channel, deploy DIAS on it, and seed it.
## The network must already be up (`make up`) with identities issued (`make seed`).
dias-all: dias-channel dias-deploy dias-seed
	@echo
	@echo "DIAS is deployed as $(DIAS_CC_NAME) on $(DIAS_CHANNEL). Next:"
	@echo "  make dias-model     # serve the model on :$(DIAS_MODEL_PORT)"
	@echo "  make dias-backend   # the API on :3001, which calls the model"

## dias-channel: the five-organization DIAS channel (no AI organization).
dias-channel:
	cd network && ORG_SET=dias CHANNEL_PROFILE=DiasChannel bash scripts/createChannel.sh $(DIAS_CHANNEL)

dias-deploy:
	cd network && ORG_SET=dias bash scripts/deployCC.sh $(DIAS_CHANNEL) $(DIAS_CC_NAME) $(DIAS_CC_VERSION) $(CC_SEQUENCE)

## dias-seed: the identities and departments a fresh DIAS install needs. No case
## and no case file: those are created through the application.
dias-seed: seed-users seed-domain

## dias-demo-data: the two demo cases and three case files the live suites use
## (make smoke, make dias-acceptance). Not needed to use the application.
dias-demo-data:
	$(MAKE) seed-domain SEED_DOMAIN_ARGS=--with-demo-cases
	$(MAKE) seed-records

## dias-model: serve Qwen3-14B for DIAS on :8081. Never 8080 — that port is
## left free for any existing service.
dias-model:
	.venv-qwen-policy/bin/mlx_lm.server \
		--model mlx-community/Qwen3-14B-4bit \
		$(if $(DIAS_ADAPTER),--adapter-path "$(abspath $(DIAS_ADAPTER))",) \
		--host 127.0.0.1 --port $(DIAS_MODEL_PORT) --max-tokens 512 \
		--chat-template-args '{"enable_thinking":false}'

## dias-backend: the API and web interface. It calls the LLM on
## $(DIAS_MODEL_URL), keeps each recommendation off-chain for the auditor, and
## commits only requests and auditor decisions with their LLM agreement.
dias-backend:
	CHANNEL=$(DIAS_CHANNEL) CHAINCODE=$(DIAS_CC_NAME) DIAS_MODEL_URL=$(DIAS_MODEL_URL) \
		node backend/src/server.js

## dias-acceptance: the live acceptance run through the backend API. Needs
## dias-model and dias-backend running.
dias-acceptance:
	CHANNEL=$(DIAS_CHANNEL) CHAINCODE=$(DIAS_CC_NAME) \
		node scripts/dias/run-backend-acceptance.js \
		--out experiments/runs/$$(date -u +%Y%m%d)_dias_backend_llm_acceptance_$$(date -u +%H%M%S)

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

## test-live: HTTP integration tests against the running DIAS backend. Requires
## Fabric with diasrecords, the model server and the API; a missing service is a
## named precondition failure, not a confusing fetch error.
test-live:
	scripts/smoke-test.sh

smoke: test-live

prove:
	CHANNEL=$(DIAS_CHANNEL) CC=$(DIAS_CC_NAME) ORG_SET=dias scripts/prove-permissioned.sh

inspect:
	CHANNEL=$(DIAS_CHANNEL) CC=$(DIAS_CC_NAME) ORG_SET=dias scripts/inspect-ledger.sh

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
