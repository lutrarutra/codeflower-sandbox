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
# Then only what the agents load on this platform stays: not Claude Code (the
# empty folder is where the app binds the SDK), nor dsh's web app and its
# LibreOffice (dsh runs as an ACP agent only), node-pty's and sharp's builds for
# other systems, Codex's voice mode, source maps and type declarations.
# OpenCode comes as one native binary per CPU (the x86_64 build without AVX2, as
# cluster nodes vary); npm installs this machine's, linked as .bin/opencode.
RUN npm ci --omit=dev --no-audit --no-fund \
    && cd node_modules \
    && ln -s "../$(ls -d opencode-linux-*)/bin/opencode" .bin/opencode \
    && .bin/opencode --version \
    && rm -rf @anthropic-ai/claude-agent-sdk @anthropic-ai/claude-agent-sdk-* \
    && mkdir @anthropic-ai/claude-agent-sdk \
    && rm -rf @deepseek-ai/libreoffice-kit @deepseek-ai/libreoffice-kit-wasm @deepseek-ai/dsh-office-to-pdf \
              @deepseek-ai/dsh-web-app @deepseek-ai/dsh-web-frontend @deepseek-ai/dsh-client-ui-* \
    && find node-pty/prebuilds -mindepth 1 -maxdepth 1 ! -name "linux-$(node -p process.arch)" -exec rm -rf {} + \
    && rm -rf @img/*musl* @img/sharp-wasm32 \
    && rm -rf @openai/codex-linux-*/vendor/*/codex-resources/voice \
    && find . \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete

WORKDIR /opt/codeflower/acp-ws
COPY dsh-plugins/acp-ws/package.json dsh-plugins/acp-ws/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY dsh-plugins/acp-ws/src ./src

# storyteller, the report library the agent uses (and may change: the entrypoint
# installs a copy in the project, editable). Pinned by tag; a development build
# uses the workspace checkout instead: --build-context storyteller=../storyteller.
FROM scratch AS storyteller
ADD --keep-git-dir=false https://github.com/lutrarutra/storyteller.git#v0.6.0 /

# The chat page the worker serves with `codeflower sandbox --server`:
# codeflower-ui's web build, pinned by tag. A development build uses the
# workspace's build instead: --build-context page=../ui/dist-web.
FROM scratch AS ui-source
ADD --keep-git-dir=false https://github.com/lutrarutra/codeflower-ui.git#v0.21.0 /

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS page-build
WORKDIR /ui
COPY --from=ui-source / ./
RUN npm ci --no-audit --no-fund && npm run build:web

FROM scratch AS page
COPY --from=page-build /ui/dist-web /

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
ARG CLAUDE_AGENT_SDK_VERSION
# Miniforge: conda and mamba on conda-forge, with Python 3.14 in the base environment.
ARG MINIFORGE_VERSION=26.9.4-1
ARG MINIFORGE_SHA256_X86_64=571b410272cc434f28bc6c5c49ca8ffd4a4d1bcba9f57f1b6baccdb46446cfcc
ARG MINIFORGE_SHA256_AARCH64=1f4e2f1898c054dd35133f778b92794116c28af330e5d5936d56d5f765401db4

# The Claude Agent SDK version the app downloads and binds in for Claude Code.
LABEL codeflower.claude-agent-sdk=$CLAUDE_AGENT_SDK_VERSION

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    RENV_CONFIG_PAK_ENABLED=TRUE \
    PATH="/opt/codeflower/bin:/opt/conda/bin:/opt/codeflower/runtime/node_modules/.bin:$PATH"

WORKDIR /opt/codeflower

# The system layer first: it changes least, so new releases mostly reuse it.
# libglib2.0-0, libsm6, libxext6 and libxrender1 are for pip wheels that expect
# them (e.g. opencv-python).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    bzip2 \
    ca-certificates \
    curl \
    fonts-dejavu-core \
    fonts-liberation2 \
    git \
    libglib2.0-0 \
    librsvg2-bin \
    libsm6 \
    libxext6 \
    libxrender1 \
    openssh-client \
    procps \
    ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && arch=$(uname -m) \
    && case "$arch" in \
         x86_64) sum=$MINIFORGE_SHA256_X86_64 ;; \
         aarch64) sum=$MINIFORGE_SHA256_AARCH64 ;; \
         *) echo "No Miniforge checksum for $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/miniforge.sh \
         "https://github.com/conda-forge/miniforge/releases/download/$MINIFORGE_VERSION/Miniforge3-$MINIFORGE_VERSION-Linux-$arch.sh" \
    && echo "$sum  /tmp/miniforge.sh" | sha256sum -c - \
    && bash /tmp/miniforge.sh -b -p /opt/conda \
    && rm /tmp/miniforge.sh /opt/conda/micromamba \
    && /opt/conda/bin/python -c 'import sys; assert sys.version_info[:2] == (3, 14), sys.version' \
    && /opt/conda/bin/conda clean --all --force-pkgs-dirs --yes \
    && ln -s /opt/conda/etc/profile.d/conda.sh /etc/profile.d/conda.sh

# R from Debian, with the headers the most common source builds need (CRAN
# packages without a binary, Bioconductor, GitHub). The image's R packages go to
# the site library, from a dated Package Manager snapshot; the agent's go to the
# project's (R_LIBS_USER). ggplot2 and the devices for publication figures,
# pak for installs from CRAN, GitHub and Bioconductor, renv for pinned project
# environments, BiocManager for Bioconductor's own installer.
ARG R_PACKAGES_DATE=2026-11-02
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    libcurl4-openssl-dev \
    libfontconfig1-dev \
    libfreetype-dev \
    libfribidi-dev \
    libgit2-dev \
    libharfbuzz-dev \
    libjpeg-dev \
    libpng-dev \
    libssl-dev \
    libtiff-dev \
    libwebp-dev \
    libxml2-dev \
    r-base-core \
    r-base-dev \
    r-recommended \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/* \
    && Rscript -e 'pkgs <- c("ggplot2", "ragg", "svglite", "patchwork", "pak", "renv", "BiocManager", "remotes")' \
         -e 'options(HTTPUserAgent = sprintf("R/%s R (%s)", getRversion(), paste(getRversion(), R.version$platform, R.version$arch, R.version$os)))' \
         -e 'install.packages(pkgs, lib = "/usr/local/lib/R/site-library", Ncpus = parallel::detectCores(),' \
         -e '  repos = c(CRAN = "https://packagemanager.posit.co/cran/__linux__/trixie/'"$R_PACKAGES_DATE"'"))' \
         -e 'for (p in pkgs) library(p, character.only = TRUE)' \
    && rm -rf /tmp/Rtmp*
COPY R/Rprofile.site /etc/R/Rprofile.site

# LibreOffice, headless, draws storyteller's slide decks (pptx to PDF) for their live
# view; Carlito has Calibri's metrics, for decks made from PowerPoint templates.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-crosextra-carlito \
    libreoffice-impress-nogui \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 /uv /uvx /usr/local/bin/
COPY --from=dsh-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=dsh-runtime /opt/codeflower/runtime /opt/codeflower/runtime
COPY --from=dsh-runtime /opt/codeflower/acp-ws /opt/codeflower/acp-ws

# storyteller's dependencies and build backend live in the base environment, which
# project venvs see, so the entrypoint can install the editable copy offline.
COPY --from=storyteller / /opt/codeflower/src/storyteller
COPY --from=page / /opt/codeflower/page
# python-pptx (with lxml, XlsxWriter, typing-extensions) and pypdfium2 are for its decks.
RUN pip install --no-cache-dir pillow==13.0.0 markdown-it-py==4.2.0 mdurl==0.1.2 hatchling==1.33.0 editables==0.6 pygments==2.21.0 \
        python-pptx==1.0.2 lxml==6.1.3 XlsxWriter==3.3.1 typing-extensions==4.16.0 pypdfium2==5.14.0 \
    && python -c "import sys; sys.path.insert(0, '/opt/codeflower/src/storyteller/src'); import storyteller, storyteller.deck"

COPY entrypoint.sh /opt/codeflower/entrypoint.sh
COPY profile.d/codeflower.sh /etc/profile.d/codeflower.sh
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
