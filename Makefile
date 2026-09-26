# Workbench on a local workstation. `make` alone runs `make workbench`.
#
#   make workbench              the workstation up, then Workbench on it
#   make workbench DATA=./bench another data directory
#   make workstation            the workstation up, and nothing else
#   make stop                   stop the workstation; the volumes keep every file
#   make logs                   follow the log of sshd
#   make shell                  a root shell in the workstation
#   make ssh ACCOUNT=experiments   a shell as one account, over ssh
#   make test-workstation       the workspace tier on the workstation, no model
#   make reset                  remove the workstation and its volumes, after a prompt
#
# workstation/README.md describes the workstation.

COMPOSE := docker compose -f workstation/compose.yaml
STATE := .workstation
CONFIG := $(STATE)/workstation.json
DATA ?= .data
ACCOUNT ?= experiments

.DEFAULT_GOAL := workbench
.PHONY: workbench workstation stop logs shell ssh test-workstation reset

# The dependencies, again when the manifest or the lockfile changes.
node_modules/.modules.yaml: package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile
	@touch $@

# The keys and workstation.json, again when the account list changes.
# setup.sh keeps each key that exists.
$(CONFIG): workstation/setup.sh workstation/accounts
	bash workstation/setup.sh $(STATE)
	@touch $@

## The workstation up: build the image when a file of it changed, start the
## container, and wait until sshd accepts a connection.
workstation: $(CONFIG)
	$(COMPOSE) up -d --build --wait

## Workbench, with the bash and git backends on the workstation.
workbench: workstation node_modules/.modules.yaml
	WORKBENCH_WORKSTATION=$(CONFIG) pnpm start $(DATA)

stop:
	$(COMPOSE) stop

logs:
	$(COMPOSE) logs -f

shell:
	$(COMPOSE) exec workstation bash

ssh: workstation
	ssh -p 2222 -i $(STATE)/keys/$(ACCOUNT) -o IdentitiesOnly=yes \
		-o UserKnownHostsFile=$(STATE)/known_hosts $(ACCOUNT)@127.0.0.1

test-workstation: workstation node_modules/.modules.yaml
	WORKBENCH_WORKSTATION=$(CONFIG) pnpm exec vitest run test/workstation.test.ts

## The workstation and its volumes go: the homes, the repositories, /library,
## and /shared. The keys in .workstation stay.
reset:
	@printf 'Remove the workstation and its volumes? Type yes: '; \
	read answer; [ "$$answer" = yes ] || { echo 'Nothing removed.'; exit 1; }
	$(COMPOSE) down -v
