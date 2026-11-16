---
name: codeflower-reproduce
description: Package an analysis as a reproducible pipeline archive (Snakemake, locked environment, data with checksums, expected results) that `codeflower reproduce` reruns and verifies on another computer without any agent. Use when the user wants their work reproducible, rerunnable, packaged for a paper, a reviewer, Zenodo or a colleague, or asks for a Snakemake pipeline of the analysis. Not for one-off scripts the user only runs here.
---

# Reproducible pipelines with codeflower-repro

A pipeline is a folder, `pipelines/NAME/` in the workspace. `codeflower-repro` makes, checks, runs and
packs it; `codeflower reproduce ARCHIVE --output DIR` on the user's computer reruns it in a new sandbox
**without network and without any agent**, then compares every result with what you recorded. Run
`codeflower-repro COMMAND --help` for the details of each command.

```
pipelines/NAME/
  codeflower-repro.yaml    manifest: title, workflow, determinism, image, platform, environment, resources
  README.md                what it reproduces, for people (fill it in)
  workflow/Snakefile       rules: which script makes which files from which files
  workflow/config.yaml     every parameter and seed
  workflow/scripts/        one script per step (Python, R, bash); shared helpers in scripts/lib/
  workflow/prepare/        scripts that made slim bundled inputs from the full data (not run)
  data/manifest.tsv        inputs: path, URL (empty when bundled), sha256, size, source
  data/...                 the inputs; bundled ones are packed into the archive
  env/                     lockfiles (freeze writes them)
  expected/                checksums.tsv and reference copies (freeze writes them)
```

## The workflow

1. **Agree on the scope** with the user: the pipeline's name, which figures and tables it must
   reproduce, and for each input whether it is **downloaded** from a persistent URL (Zenodo, GEO, SRA,
   ArrayExpress, figshare, 10x Genomics, a versioned release) or **bundled** in the archive. Bundling
   needs no upload anywhere and keeps the archive self-contained, but makes it as large as the data;
   public data with a lasting URL is better downloaded. Data that exists only on this machine is
   bundled unless the user deposits it. The reproducing sandbox has no network either way.
2. **Create the folder**: `codeflower-repro init pipelines/NAME --title "…" --bare` (without `--bare`
   it has a working example rule and script to start from).
3. **List the inputs**: put each file where the workflow reads it, under `data/` (a link to
   `/data/input/...` is fine: the file it points to is packed), then
   `codeflower-repro data add pipelines/NAME data/raw/FILE --url URL` for a downloaded one (`--download`
   downloads it there first), or without `--url` for a bundled one. Bundle only what the pipeline reads:
   see "Bundling inputs" below.
4. **Move the analysis in.** Copy the scripts that produced the final results into `workflow/scripts/`,
   one rule per step, and rewrite only how they get their paths and parameters:
   - Python: `snakemake.input[0]`, `snakemake.output.table`, `snakemake.params.seed`, `snakemake.config["..."]`.
   - R: `snakemake@input[[1]]`, `snakemake@output[["table"]]`, `snakemake@params$seed`.
   - bash: a `shell:` rule with `{input}` and `{output}`.
   Leave out dead ends and exploratory plots nobody asked for. Do not change the analysis itself.
5. **Run it in place** while you build it: `codeflower-repro run pipelines/NAME`. Then from scratch:
   `codeflower-repro run pipelines/NAME --clean`, and compare its results with those the analysis
   already made. If they differ, find out why and tell the user before changing anything.
6. **Check**: `codeflower-repro check pipelines/NAME`; fix every error, and every warning you can.
7. **Freeze**: `codeflower-repro freeze pipelines/NAME`. It pins the environment with hashes, records
   the image and data checksums, runs the pipeline twice from scratch (1 core and N cores) and records
   each result with the comparison its two runs support: `exact`, `table` with a tolerance, `image`,
   or `exists`. Treat an `exists`, or a warning that numbers differ between runs, as a bug to fix (a
   missing seed, thread-dependent sums, a date in the file), then freeze again.
8. **Pack**: `codeflower-repro pack pipelines/NAME`. It checks again and writes `NAME.tar.gz` (to the
   mounted output folder when there is one). `--bundle-data` also packs the inputs that have a URL,
   when the user wants one file that reproduces without any download. Add `--with-env` for an exact copy of the installed
   environment beside it (several GB, for this platform only) when the user wants it to work even
   after packages disappear from PyPI, CRAN or Bioconductor.
9. **Test the archive**: `codeflower-repro test <path of NAME.tar.gz>`. It does what `codeflower
   reproduce` does, as far as a sandbox can: unpacks the archive as packed, downloads the inputs it
   does not bundle, installs a **new** environment from the lockfiles only (the project's venv and R
   library stay out of it), runs the pipeline **without network** and compares every result. It must
   pass before you hand over. When it fails, fix the pipeline (a package missing from the lock, a file
   read from outside the archive, a download in a rule, an unseeded step), then freeze, pack and test
   again. Never edit `expected/` by hand to make a test pass.
10. **Hand over**: fill in README.md (with its Determinism table), translate the archive's path with
   `codeflower-path`, and tell the user what the test showed and the command to run **on their
   computer**, outside the sandbox: `codeflower reproduce <archive on their computer> --output <a new
   folder>` (with `--snapshot <env archive>` when packed with `--with-env`). That command is the final
   check, in a fresh sandbox from the image; you cannot run it yourself.

## Bundling inputs

A bundled input should hold only what the pipeline reads, in a compact format: the archive is
downloaded, stored and checked by everyone who reproduces it.

- **Find out what is read.** Look at what the scripts actually use, not at what the file holds. An
  AnnData of which only the raw counts (`adata.layers["counts"]` or `adata.raw`), a few `obs` columns
  and the gene names are read does not need its normalised `X`, `obsm` embeddings, `obsp` graphs,
  `uns` or other layers; a table of which three columns are read does not need the other forty; a
  BAM of which one region is used needs only that region. Results the pipeline recomputes (PCA, UMAP,
  clusters, normalised values) never belong in its input.
- **Make the slim input with a script** in `workflow/prepare/` (for example `slim_input.py`), from the
  full file. No rule runs it, so it may read `/data/input/...`; `check` does not flag it there. Record
  where the input came from: `codeflower-repro data add PIPELINE data/raw/FILE --source "subset of
  /data/input/study.h5ad (sha256 …) by workflow/prepare/slim_input.py"`. Say the same in README.md.
- **Check that nothing changed**: run the pipeline on the slim input and compare its results with the
  run on the full input (`run --clean` before and after; `freeze` warns when the clean run differs from
  `results/` in the pipeline folder). If they differ, the pipeline read something you left out.
- **Choose a compact, open format**:
  - Matrices: keep them sparse when they are (AnnData `.h5ad` with a sparse `X`, Matrix Market
    `.mtx`), never a dense CSV of a sparse matrix. Counts as integers (`int32`), values as `float32`
    when the analysis allows it; do not convert counts to floats.
  - Tables: Parquet for large ones; CSV or TSV is fine when small, and easiest to read.
  - Keep the original's format when the pipeline needs it (FASTQ, BAM, 10x folders), and slim it with
    the format's own tools (`samtools view` a region, `seqtk sample` reads with a fixed seed).
- **Compression**: the archive is gzip-compressed as a whole, so plain-text and uncompressed binary
  files shrink in it already. Files that are compressed themselves (`.gz`, Parquet, an `.h5ad` written
  with `compression="gzip"`) shrink no further; that is fine, but do not compress twice for nothing.
  Do not split or re-encode data in custom formats to save a little: readers must be able to open it.
- **Size**: `pack` lists each bundled input with its size and warns above 100 MB; above a few GB,
  prefer depositing the data and listing its URL, and ask the user.

## Seeds and determinism

Results must come out the same on every run, on any computer.

- **Seed every random step, explicitly**, with a seed from `config.yaml`, even where the library has a
  default (scanpy's `random_state=0`, Seurat's `seed.use=42`): written out, it is documented and does
  not change when a library changes its default. Random steps include subsampling, train/test splits,
  k-means and other clustering (Leiden, Louvain), UMAP and t-SNE, PCA with randomised solvers (arpack,
  irlba), permutation tests and bootstraps, neural networks, simulations, and `random`/`np.random`/
  `sample()` anywhere.
  - Python: `rng = np.random.default_rng(seed)` and pass `rng` or `random_state=seed`; never the global
    `np.random.*` functions or `random_state=None`. Torch: `torch.manual_seed(seed)` and deterministic
    algorithms.
  - R: `set.seed(snakemake@params$seed)` at the top, and `seed`/`seed.use` arguments where a function
    takes one.
- **One seed per step** in `config.yaml`, named after it, with a comment saying which function takes it
  (`umap_seed: 0  # sc.tl.umap(random_state=…)`); pass it to the rule as `params`. `check` warns about
  scripts that draw random numbers without a seed.
- **Other sources of variation**: threads are 1 by default (`OMP_NUM_THREADS` and friends in the
  manifest's `determinism.env`; raise them only if results stay the same); iterate over sorted lists,
  not sets or directory listings in file-system order; no current date or time, host name or user name
  in results; set `float_format` or round only for display, never before saving.
- **Document it** in README.md's Determinism table: each random step, the function, and the seed's name
  in `config.yaml`. Then the two clean runs of `freeze` show whether it worked: every result `exact`, or
  a tolerance you can explain (say which and why in the README).

## Rules for the workflow

- **Paths are relative to the work directory**: inputs under `data/`, results under `results/`, logs
  under `logs/`, benchmarks under `benchmarks/`. Nothing else may be written; `check` rejects
  `/codeflower-state`, `/data/input`, `/tmp/...` and home folders in workflow files.
- **No network while it runs**: no downloads, API calls or `pip install` in rules. Downloads go in
  `data/manifest.tsv`; packages go in the environment (install them in the project as usual, then freeze).
- **Determinism**: see "Seeds and determinism" below.
- **Only results/ is compared.** Put every figure and table the user cares about there. Prefer PNG and
  CSV/TSV, which compare well; PDFs and SVGs often embed dates (matplotlib honours
  `SOURCE_DATE_EPOCH`, which the manifest sets). Large intermediates can go to `results/intermediate/`.
- **One environment**: the project's venv, R library and conda environments, as installed in this
  sandbox. Snakemake's `conda:` and `container:` directives are not used; the image is the container.
- Give each rule a `log:` file and keep scripts short and readable: reviewers read them.

## If something fails

- `the pipeline wrote outside results/...`: a script writes to the work directory's top level.
- `inputs not found`: the file is not under `data/` at the path the manifest lists.
- `could not pin the Python packages with hashes`: a package was installed from a file or another
  index; install it from PyPI, or ask the user.
- A step needs the network: move the download to `data/manifest.tsv`, or the package to the environment.
