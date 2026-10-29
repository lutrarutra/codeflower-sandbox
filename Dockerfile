# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS dsh-runtime

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

# storyteller, the report library the agent uses (and may change: the entrypoint
# installs a copy in the project, editable). Pinned by tag; a development build
# uses the workspace checkout instead: --build-context storyteller=../storyteller.
FROM scratch AS storyteller
ADD --keep-git-dir=false https://github.com/lutrarutra/storyteller.git#v0.1.0 /

FROM continuumio/miniconda3:26.7.1-1@sha256:eca594d684f495c1a02beff33a9fab53aec8c5830eaf431bb149912dc6c9e4c1

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH="/opt/codeflower/bin:/opt/conda/bin:/opt/codeflower/runtime/node_modules/.bin:$PATH"

WORKDIR /opt/codeflower

COPY --from=ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 /uv /uvx /usr/local/bin/
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

# storyteller's dependencies and build backend live in the base environment, which
# project venvs see, so the entrypoint can install the editable copy offline.
COPY --from=storyteller / /opt/codeflower/src/storyteller
RUN pip install --no-cache-dir pillow==13.0.0 markdown-it-py==4.2.0 mdurl==0.1.2 hatchling==1.33.0 editables==0.6 pygments==2.21.0 \
    && python -c "import sys; sys.path.insert(0, '/opt/codeflower/src/storyteller/src'); import storyteller"

COPY entrypoint.sh /opt/codeflower/entrypoint.sh
COPY bin /opt/codeflower/bin
COPY templates /opt/codeflower/templates
COPY skills /opt/codeflower/skills

# Bind targets must exist in the image on Apptainer installs without underlay.
# The user's folders are mounted one level below /data/{input,output,code,skills},
# which such installs cannot create: they need underlay (Apptainer's default).
RUN mkdir -p /codeflower-state /codeflower-net /data/input /data/output /data/code /data/skills

ENTRYPOINT ["/opt/codeflower/entrypoint.sh"]
