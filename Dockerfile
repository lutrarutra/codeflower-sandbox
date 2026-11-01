# syntax=docker/dockerfile:1

# Claude Code is not in the image: its license does not allow passing it on.
# The app downloads this version of the Claude Agent SDK and its CLI for each
# machine and binds them in (see the label below). It must be the version the
# Claude ACP adapter pins in package-lock.json; the build checks that.
ARG CLAUDE_AGENT_SDK_VERSION=0.3.310

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS dsh-runtime
ARG CLAUDE_AGENT_SDK_VERSION

# Harness runtimes: DeepSeek Harness, the Claude Code and Codex ACP adapters,
# the codex CLI used for sign-in, and OpenCode. Exact versions are pinned in package.json.
WORKDIR /opt/codeflower/runtime
COPY package.json package-lock.json ./
RUN locked=$(node -p 'require("./package-lock.json").packages["node_modules/@anthropic-ai/claude-agent-sdk"].version') \
    && if [ "$locked" != "$CLAUDE_AGENT_SDK_VERSION" ]; then \
         echo "package-lock.json has @anthropic-ai/claude-agent-sdk $locked: set CLAUDE_AGENT_SDK_VERSION to it" >&2; exit 1; \
       fi
# Not Claude Code: the empty folder is where the app binds the SDK.
# OpenCode comes as one native binary per CPU (the x86_64 build without AVX2, as
# cluster nodes vary); npm installs this machine's, linked as .bin/opencode.
RUN npm ci --omit=dev --no-audit --no-fund \
    && cd node_modules \
    && ln -s "../$(ls -d opencode-linux-*)/bin/opencode" .bin/opencode \
    && .bin/opencode --version \
    && rm -rf @anthropic-ai/claude-agent-sdk @anthropic-ai/claude-agent-sdk-* \
    && mkdir @anthropic-ai/claude-agent-sdk

WORKDIR /opt/codeflower/acp-ws
COPY dsh-plugins/acp-ws/package.json dsh-plugins/acp-ws/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY dsh-plugins/acp-ws/src ./src

# storyteller, the report library the agent uses (and may change: the entrypoint
# installs a copy in the project, editable). Pinned by tag; a development build
# uses the workspace checkout instead: --build-context storyteller=../storyteller.
FROM scratch AS storyteller
ADD --keep-git-dir=false https://github.com/lutrarutra/storyteller.git#v0.3.0 /

# The chat page the worker serves with `codeflower interactive --server`:
# codeflower-ui's web build, pinned by tag. A development build uses the
# workspace's build instead: --build-context page=../ui/dist-web.
FROM scratch AS ui-source
ADD --keep-git-dir=false https://github.com/lutrarutra/codeflower-ui.git#v0.6.0 /

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS page-build
WORKDIR /ui
COPY --from=ui-source / ./
RUN npm ci --no-audit --no-fund && npm run build:web

FROM scratch AS page
COPY --from=page-build /ui/dist-web /

FROM continuumio/miniconda3:26.7.1-1@sha256:eca594d684f495c1a02beff33a9fab53aec8c5830eaf431bb149912dc6c9e4c1
ARG CLAUDE_AGENT_SDK_VERSION

# The Claude Agent SDK version the app downloads and binds in for Claude Code.
LABEL codeflower.claude-agent-sdk=$CLAUDE_AGENT_SDK_VERSION

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
    fonts-dejavu-core \
    fonts-liberation2 \
    git \
    librsvg2-bin \
    ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && conda install --yes --freeze-installed -c conda-forge \
        python=3.14 \
        pip \
    && conda clean --all --yes

# storyteller's dependencies and build backend live in the base environment, which
# project venvs see, so the entrypoint can install the editable copy offline.
COPY --from=storyteller / /opt/codeflower/src/storyteller
COPY --from=page / /opt/codeflower/page
RUN pip install --no-cache-dir pillow==13.0.0 markdown-it-py==4.2.0 mdurl==0.1.2 hatchling==1.33.0 editables==0.6 pygments==2.21.0 \
    && python -c "import sys; sys.path.insert(0, '/opt/codeflower/src/storyteller/src'); import storyteller"

COPY entrypoint.sh /opt/codeflower/entrypoint.sh
COPY bin /opt/codeflower/bin
COPY templates /opt/codeflower/templates
COPY skills /opt/codeflower/skills
# Licenses of what the image includes without them (OpenCode's npm builds).
COPY licenses /opt/codeflower/licenses
# Reports dsh's token counts to the bridge (agents.js adds it with --patch).
COPY dsh-plugins/usage /opt/codeflower/dsh-usage

# Bind targets must exist in the image on Apptainer installs without underlay.
# The user's folders are mounted one level below /data/{input,output,code,skills},
# which such installs cannot create: they need underlay (Apptainer's default).
# /data/icons is the user's icon gallery (codeflower-sketch). Claude Code goes to
# /opt/codeflower/agents/claude and its SDK into the empty folder in node_modules;
# `claude` on the PATH is its CLI.
RUN mkdir -p /codeflower-state /codeflower-net /data/input /data/output /data/code /data/skills /data/icons \
        /opt/codeflower/agents/claude \
    && ln -s /opt/codeflower/agents/claude/claude /opt/codeflower/bin/claude

ENTRYPOINT ["/opt/codeflower/entrypoint.sh"]
