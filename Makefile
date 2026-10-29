.PHONY: sandbox-build sandbox-build-linux bridge-install bridge-test

sandbox-build:
	docker build -t codeflower-sandbox .

# The image for an x86_64 cluster, saved for `apptainer build … docker-archive://…`.
sandbox-build-linux:
	mkdir -p build
	docker build --platform linux/amd64 -t codeflower-sandbox:amd64 .
	docker save codeflower-sandbox:amd64 -o build/codeflower-sandbox-amd64.tar

bridge-install:
	npm --prefix dsh-plugins/acp-ws ci

bridge-test:
	npm --prefix dsh-plugins/acp-ws test
