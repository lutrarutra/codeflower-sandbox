# syntax=docker/dockerfile:1

# Claude Code is not in the image: its license does not allow passing it on.
# The app downloads this version of the Claude Agent SDK and its CLI for each
# machine and binds them in (see the label below). It must be the version the
# Claude ACP adapter pins in package-lock.json; the build checks that.
ARG CLAUDE_AGENT_SDK_VERSION=0.3.330
# codeflower-audit, for paper audits (the audit stage below).
ARG CODEFLOWER_AUDIT_VERSION=v0.3.0

FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS dsh-runtime
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
# empty folder is where the app binds the SDK), nor dsh's web app, its
# LibreOffice and its optional experimental bundles with their speech model
# (dsh runs as an ACP agent only, and the codeflower profile switches none of
# them on), node-pty's and sharp's builds for other systems, Codex's voice
# mode, source maps and type declarations.
# OpenCode comes as one native binary per CPU (the x86_64 build without AVX2, as
# cluster nodes vary); npm installs this machine's, linked as .bin/opencode.
RUN npm ci --omit=dev --no-audit --no-fund \
    && cd node_modules \
    && ln -s "../$(ls -d opencode-linux-*)/bin/opencode" .bin/opencode \
    && .bin/opencode --version \
    && rm -rf @anthropic-ai/claude-agent-sdk @anthropic-ai/claude-agent-sdk-* \
    && mkdir @anthropic-ai/claude-agent-sdk \
    && rm -rf @deepseek-ai/libreoffice-kit* @deepseek-ai/dsh-experimental-* sherpa-onnx-* \
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
ADD --keep-git-dir=false https://github.com/lutrarutra/storyteller.git#v0.7.1 /

# codeflower-audit, for paper audits: the command that checks, scores, seals and
# verifies them (the same module the app's `codeflower audit` requires), the
# agent's gathering commands and the codeflower-audit skill. Pinned by tag; a
# development build uses the workspace checkout instead: --build-context audit=../audit.
FROM scratch AS audit
ARG CODEFLOWER_AUDIT_VERSION
ADD --keep-git-dir=false https://github.com/lutrarutra/codeflower-audit.git#${CODEFLOWER_AUDIT_VERSION} /

FROM golang:1.26-bookworm@sha256:4ebd099cae89439fff17af404a9c724079d439b4d92178819318735312ee9eb3 AS audit-build
ARG CODEFLOWER_AUDIT_VERSION
WORKDIR /audit
COPY --from=audit / ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=${CODEFLOWER_AUDIT_VERSION}" -o /codeflower-audit ./cmd/codeflower-audit

# The chat page the worker serves with `codeflower sandbox --server`:
# codeflower-ui's web build, pinned by tag. A development build uses the
# workspace's build instead: --build-context page=../ui/dist-web.
FROM scratch AS ui-source
ADD --keep-git-dir=false https://github.com/lutrarutra/codeflower-ui.git#v0.47.0 /

FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS page-build
WORKDIR /ui
COPY --from=ui-source / ./
RUN npm ci --no-audit --no-fund && npm run build:web

FROM scratch AS page
COPY --from=page-build /ui/dist-web /

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
ARG CLAUDE_AGENT_SDK_VERSION
# Miniforge: conda and mamba on conda-forge, with Python 3.14 in the base environment.
ARG MINIFORGE_VERSION=26.9.4-1
ARG MINIFORGE_SHA256_X86_64=571b410272cc434f28bc6c5c49ca8ffd4a4d1bcba9f57f1b6baccdb46446cfcc
ARG MINIFORGE_SHA256_AARCH64=1f4e2f1898c054dd35133f778b92794116c28af330e5d5936d56d5f765401db4

# The Claude Agent SDK version the app downloads and binds in for Claude Code.
LABEL codeflower.claude-agent-sdk=$CLAUDE_AGENT_SDK_VERSION
# The image runs batch jobs (job.sh) and has codeflower-job, which the app checks before it offers jobs.
LABEL codeflower.jobs=1

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
# them (e.g. opencv-python). The command-line tools after them are ones agents
# and the user's shells expect and cannot install without root (about 45 MB);
# ping, dig and nc show why a host is out of reach under network isolation.
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
    bc \
    dnsutils \
    file \
    htop \
    iputils-ping \
    jq \
    less \
    lsof \
    nano \
    ncdu \
    netcat-openbsd \
    parallel \
    pigz \
    rsync \
    sqlite3 \
    strace \
    time \
    tmux \
    tree \
    vim-tiny \
    wget \
    xxd \
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
    && ln -s /opt/conda/etc/profile.d/conda.sh /etc/profile.d/conda.sh \
    && ln -s /usr/bin/vim.tiny /usr/local/bin/vim

# R from Debian, with the headers the most common source builds need (CRAN
# packages without a binary, Bioconductor, GitHub). The image's R packages go to
# the site library, from a dated Package Manager snapshot; the agent's go to the
# project's (R_LIBS_USER). ggplot2 and the devices for publication figures,
# pak for installs from CRAN, GitHub and Bioconductor, renv for pinned project
# environments, BiocManager for Bioconductor's own installer. The libraries
# after r-recommended are ones common packages link, which the agent cannot
# install without root even for Package Manager's binaries: HDF5 (hdf5r, for
# Seurat and .h5 files), GLPK (igraph), GSL, cairo (Cairo), udunits (units),
# SQLite and PostgreSQL clients.
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
    libcairo2-dev \
    libglpk-dev \
    libgsl-dev \
    libhdf5-dev \
    libpq-dev \
    libsqlite3-dev \
    libudunits2-dev \
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

# Each chat's browser (codeflower-browser): Chrome's headless shell and
# playwright-cli come in the browser bundle (browser/bundle.json pins it), which
# the bridge installs into the project on first use; the image has only what
# Chrome needs from the system and cannot be installed without root. Chrome
# links libgbm but renders without a GPU (SwiftShader, WebGL included), so only
# libgbm.so.1 is taken from its package: the package would bring Mesa and LLVM
# (about 190 MB) that Chrome never loads here.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libdrm2 \
    libwayland-server0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    && cd /tmp && apt-get download libgbm1 \
    && dpkg-deb -x libgbm1_*.deb gbm \
    && cp -a gbm/usr/lib/*/libgbm.so.1* /usr/local/lib/ \
    && ldconfig \
    && rm -rf gbm libgbm1_*.deb /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 /uv /uvx /usr/local/bin/

# Snakemake runs reproducible pipelines (codeflower-repro). It has a venv of its own, so its
# dependencies do not change the conda base that project venvs see; bin/snakemake runs it with the
# project's Python, so a pipeline's Python steps see the project's packages.
COPY python/snakemake.txt /tmp/snakemake.txt
RUN uv venv --quiet --python /opt/conda/bin/python /opt/codeflower/snakemake \
    && uv pip install --quiet --no-cache --require-hashes --python /opt/codeflower/snakemake/bin/python -r /tmp/snakemake.txt \
    && rm /tmp/snakemake.txt \
    && /opt/codeflower/snakemake/bin/snakemake --version
COPY --from=dsh-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=dsh-runtime /opt/codeflower/runtime /opt/codeflower/runtime
COPY --from=dsh-runtime /opt/codeflower/acp-ws /opt/codeflower/acp-ws

# storyteller's dependencies and build backend live in the base environment, which
# project venvs see, so the entrypoint can install the editable copy offline.
COPY --from=storyteller / /opt/codeflower/src/storyteller
COPY --from=page / /opt/codeflower/page
# python-pptx (with lxml, XlsxWriter, typing-extensions) and pypdfium2 are for its decks.
# playwright (with greenlet, pyee) is for `storyteller pdf`, which an audit runs to seal its report as a
# PDF; it drives the browser codeflower-browser installs (CODEFLOWER_BROWSER_BIN) and downloads none.
RUN pip install --no-cache-dir pillow==13.0.0 markdown-it-py==4.2.0 mdurl==0.1.2 hatchling==1.33.0 editables==0.6 pygments==2.21.0 \
        python-pptx==1.0.2 lxml==6.1.3 XlsxWriter==3.3.1 typing-extensions==4.16.0 pypdfium2==5.14.0 \
        playwright==1.64.1 greenlet==3.5.6 pyee==14.0.0 \
    && python -c "import sys; sys.path.insert(0, '/opt/codeflower/src/storyteller/src'); import storyteller, storyteller.deck, storyteller.pdf, playwright.sync_api"

COPY entrypoint.sh reproduce.sh job.sh /opt/codeflower/
COPY lib /opt/codeflower/lib
COPY profile.d/codeflower.sh /etc/profile.d/codeflower.sh
COPY bin /opt/codeflower/bin
COPY --from=audit-build /codeflower-audit /opt/codeflower/bin/codeflower-audit
COPY --from=audit --chmod=755 /gather/codeflower-audit-gather /opt/codeflower/bin/codeflower-audit-gather
COPY templates /opt/codeflower/templates
COPY skills /opt/codeflower/skills
COPY --from=audit /skill /opt/codeflower/skills/codeflower-audit
COPY browser/bundle.json /opt/codeflower/browser/bundle.json
# Licenses of what the image includes without them (OpenCode's npm builds).
COPY licenses /opt/codeflower/licenses
# Reports dsh's token counts to the bridge (agents.js adds it with --patch).
COPY dsh-plugins/usage /opt/codeflower/dsh-usage

# Bind targets must exist in the image on Apptainer installs without underlay.
# The user's folders are mounted one level below /data/{input,output,code,skills},
# which such installs cannot create: they need underlay (Apptainer's default).
# /data/icons is the user's icon gallery (codeflower-sketch); /repro/* are reproduce.sh's folders. Claude Code goes to
# /opt/codeflower/agents/claude and its SDK into the empty folder in node_modules;
# `claude` on the PATH is its CLI.
RUN mkdir -p /codeflower-state /codeflower-net /data/input /data/output /data/code /data/skills /data/icons \
        /repro/pipeline /repro/data /repro/work /repro/out \
        /opt/codeflower/agents/claude \
    && ln -s /opt/codeflower/agents/claude/claude /opt/codeflower/bin/claude

ENTRYPOINT ["/opt/codeflower/entrypoint.sh"]
