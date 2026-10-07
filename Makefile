# Workbench on a local workstation. `make` alone runs `make workbench`.
#
#   make workbench              the workstation up, then Workbench on it
#   make workbench DATA=./bench another data directory
#   make workstation            the workstation and the object store up, and the USB devices attached
#   make usb                    attach the USB devices of this Mac to OrbStack's Linux
#   make usb-detach             give them back to macOS
#   make stop                   stop the workstation; the volumes keep every file
#   make logs                   follow the logs of sshd and the object store
#   make shell                  a root shell in the workstation
#   make ssh ACCOUNT=researcher   a shell as one account, over ssh
#   make test-workstation       the workspace tier on the workstation, no model
#   make reset                  remove the workstation and its volumes, after a prompt
#   make voice                  whisper.cpp and its model for /voice, once
#
# workstation/README.md describes the workstation.

COMPOSE := docker compose -f workstation/compose.yaml
STATE := .workstation
CONFIG := $(STATE)/workstation.json
DATA ?= .data
ACCOUNT ?= researcher
WHISPER_MODEL := $(HOME)/.cache/whisper/ggml-large-v3.bin
WHISPER_URL := https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin

.DEFAULT_GOAL := workbench
.PHONY: workbench workstation usb usb-detach stop logs shell ssh test-workstation reset voice

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
## workstation and the object store, and wait until sshd and the store are
## healthy. The init job then makes the bucket and its user. Last, attach the
## USB devices, and the container makes their device files within 5 seconds.
workstation: $(CONFIG)
	$(COMPOSE) up -d --build --wait workstation objects
	$(COMPOSE) run --rm objects-init
	@python3 workstation/usb.py attach

## Each USB device of this Mac goes to OrbStack's Linux, except keyboards,
## mice, a hub's billboard, and each device of workstation/usb-ignore. On a
## machine without OrbStack, the devices are native, and nothing happens.
usb:
	@python3 workstation/usb.py attach

usb-detach:
	@python3 workstation/usb.py detach

## Workbench, with the bash and git backends on the workstation.
workbench: workstation node_modules/.modules.yaml
	WORKBENCH_WORKSTATION=$(CONFIG) pnpm start $(DATA)

## What /voice needs: whisper-server from Homebrew, and the large-v3 model of
## about 3 GB. The download goes to a part file first, so a stopped download
## leaves no model that looks complete.
voice: $(WHISPER_MODEL)
	@command -v whisper-server >/dev/null || brew install whisper-cpp

$(WHISPER_MODEL):
	mkdir -p $(dir $@)
	curl -fL --retry 3 -C - -o $@.part $(WHISPER_URL)
	mv $@.part $@

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
	WORKBENCH_WORKSTATION=$(CONFIG) pnpm exec vitest run test/workstation.test.ts test/usb-camera-workstation.test.ts

## The workstation and its volumes go: the homes, the repositories, /library,
## /shared, and the snapshots. The keys and the credentials in .workstation stay.
reset:
	@printf 'Remove the workstation and its volumes? Type yes: '; \
	read answer; [ "$$answer" = yes ] || { echo 'Nothing removed.'; exit 1; }
	$(COMPOSE) down -v
