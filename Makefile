.PHONY: sandbox-build sandbox-build-linux bridge-install bridge-test

# STORYTELLER_SRC=../storyteller builds with a local storyteller checkout instead of
# the tag pinned in the Dockerfile (the workspace passes its submodule).
STORYTELLER_SRC ?=
BUILD_CONTEXTS := $(if $(STORYTELLER_SRC),--build-context storyteller=$(STORYTELLER_SRC))

sandbox-build:
	docker build $(BUILD_CONTEXTS) -t codeflower-sandbox .

# The image for an x86_64 cluster, saved for `apptainer build … docker-archive://…`.
sandbox-build-linux:
	mkdir -p build
	docker build --platform linux/amd64 $(BUILD_CONTEXTS) -t codeflower-sandbox:amd64 .
	docker save codeflower-sandbox:amd64 -o build/codeflower-sandbox-amd64.tar

bridge-install:
	npm --prefix dsh-plugins/acp-ws ci

bridge-test:
	npm --prefix dsh-plugins/acp-ws test
