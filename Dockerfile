# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS dsh-runtime

# Harness runtimes: DeepSeek Harness, the Claude Code and Codex ACP adapters,
# and the official claude and codex CLIs used for sign-in. Exact versions are
# pinned in package.json.
WORKDIR /opt/codeflower/runtime
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

WORKDIR /opt/codeflower/acp-ws
COPY dsh-plugins/acp-ws/package.json dsh-plugins/acp-ws/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY dsh-plugins/acp-ws/src ./src

FROM continuumio/miniconda3:latest

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH="/opt/codeflower/bin:/opt/conda/bin:/opt/codeflower/runtime/node_modules/.bin:$PATH"

WORKDIR /opt/codeflower

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
COPY --from=dsh-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=dsh-runtime /opt/codeflower/runtime /opt/codeflower/runtime
COPY --from=dsh-runtime /opt/codeflower/acp-ws /opt/codeflower/acp-ws

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && conda install --yes --freeze-installed -c conda-forge \
        python=3.14 \
        pip \
    && conda clean --all --yes

COPY entrypoint.sh /opt/codeflower/entrypoint.sh
COPY bin /opt/codeflower/bin
COPY templates /opt/codeflower/templates

# Bind targets must exist in the image on Apptainer installs without underlay.
# The user's folders are mounted one level below /data/{input,output,code},
# which such installs cannot create: they need underlay (Apptainer's default).
RUN mkdir -p /codeflower-state /data/input /data/output /data/code

ENTRYPOINT ["/opt/codeflower/entrypoint.sh"]
