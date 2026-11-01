# Quality Control

Source: https://www.sc-best-practices.org/preprocessing-visualization/quality-control  
Authors: Anna Schaar, Seo H. Kim, Lukas Heumos, Luke Zappia

**🧠 Key takeaways**

- Filtering of poor-quality cells should be based on median absolute deviations with lenient cutoffs to avoid bias against smaller subpopulations.
- Feature-based filtering does not show benefits for downstream tasks.
- Doublets can be efficiently detected with tools like scDblFinder.
- Doublet detection methods should not be run on aggregated scRNA-seq data representing multiple batches.

**⚙️ Environment setup**

**yml:**

```yaml
name: preprocessing
channels:
  - bioconda
  - conda-forge
dependencies:
  - conda-forge::ipykernel=7.3.0
  - conda-forge::ipywidgets=8.1.9
  - conda-forge::leidenalg=0.12.0
  - conda-forge::numba=0.67.0
  - conda-forge::python=3.13.15
  - conda-forge::r-base=4.5.3
  - conda-forge::r-soupx=1.6.2
  - conda-forge::r-sctransform=0.4.3
  - conda-forge::r-glmpca=0.2.0
  - conda-forge::rpy2=3.6.8
  - conda-forge::scanpy=1.12.4
  - conda-forge::session-info=1.0.0
  - bioconda::anndata2ri=2.0.1
  - bioconda::bioconductor-scdblfinder=1.24.10
  - bioconda::bioconductor-scry=1.22.0
  - bioconda::bioconductor-scran=1.38.1
  - bioconda::bioconductor-glmgampoi=1.22.0
  - pip
  - pip:
      - lamindb==2.10.0
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

Single-cell RNA-seq datasets have two essential properties that one should have in mind when performing an analysis.
First, scRNA-seq data contains drop-outs, meaning there is an excessive number of zeros in the data due to the limitation of [mRNA](../glossary.md#term-messenger-rna-mrna).
Second, the potential for correcting the data and performing quality control might be limited as the data may be confounded with biology.
It is therefore crucial to select preprocessing methods that are suitable for the underlying data without overcorrecting or removing biological effects.

The set of tools for analyzing single-cell [RNA](../glossary.md#term-rna)-sequencing data is evolving fast due to new [sequencing](../glossary.md#term-sequencing) technologies and a growing number of captured cells, measured genes, and identified cell populations (Zappia & Theis, 2021 [1]).
Many of these tools are dedicated to preprocessing, which aims to address the following analysis steps:

1. [Doublet](../glossary.md#term-doublets) detection
2. Quality control
3. Normalization
4. Feature selection
5. Dimensionality reduction.

The algorithms selected throughout this process can heavily affect downstream analysis and interpretation of the data.
For example, if you filter out too many cells during quality control, you might lose rare cell subpopulations and miss insight into interesting cell biology.
Whereas if you are too permissive, you might have a hard time annotating your cells if you did not exclude poor-quality cells in your preprocessing pipeline.
In many cases, you will still have to re-assess your preprocessing analysis at a later point and change, for example, the filtering strategy.

The starting point of this notebook is single-cell data that has been processed as previously described in the [raw data processing chapter](../introduction/raw-data-processing.md).
The data was aligned to obtain matrices of molecular counts, the so-called count matrices, or read counts (read matrices).
The difference between count and read matrices depends on whether [unique molecular identifiers (UMIs)](../glossary.md#term-unique-molecular-identifier-umi) were included in the single-cell library construction protocol.
Read and count matrices have the dimension `number of barcodes x number of transcripts`.
It is important to note that the term “barcode” is used here instead of “cell” as a barcode might wrongly have tagged multiple cells (doublet) or might have not tagged any cell (empty droplet/well).
We will elaborate more on this in the section Doublet detection.

## Environment setup and data

We use a 10x Multiome data set generated for a single cell data integration challenge at the NeurIPS conference 2021 (Luecken *et al.*, 2021 [2]).
This dataset captures single-cell multiomics data from bone marrow mononuclear cells of 12 healthy human donors measured at four different sites to obtain nested [batch effects](../glossary.md#term-batch-effect)—a hierarchical form of technical variability where batches (such as sites) are nested within biological units (such as individual donors), allowing for a more nuanced assessment of technical versus biological variation.
In this tutorial, we will use one batch of the aforementioned dataset, sample 4 of donor 8, to showcase the best practices for scRNA-seq data preprocessing.

Although single-cell count matrix preprocessing is generally a linear process where various quality control and preprocessing steps are conducted in a clear order, the introduction of specific steps here requires us to sometimes jump ahead to steps that we are going to introduce in one of the later subchapters.
For example, we make use of clustering for the ambient RNA correction, but will only introduce [clustering](../cellular-structure/clustering.md) later.

As a first step, we import the packages we need.

```python
from typing import Literal

import anndata as ad
import lamindb as ln
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import scanpy as sc
import seaborn as sns
from rpy2.robjects import numpy2ri
from rpy2.robjects.conversion import localconverter
from scipy.sparse import csc_matrix
from scipy.special import logit
from scipy.stats import median_abs_deviation

# Suppress verbose logging from Scanpy
sc.settings.verbosity = 0

# Set figure parameters for clean, minimal plots
sc.set_figure_params(dpi=80, facecolor="white", frameon=False)

ln.connect("theislab/sc-best-practices")

ln.track("FATGTTa0bL50")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ loaded Transform('FATGTTa0bL500008', key='quality_control.ipynb'), started new Run('OLrQFYZyxqvVMZSE') at 2026-09-29 11:54:04 UTC
→ notebook imports: anndata==0.13.2 lamindb-core==2.10.0 matplotlib==3.11.2 numpy==2.5.3 pandas==3.0.6 rpy2-rinterface==3.6.7 rpy2-robjects==3.6.5 scanpy==1.12.4 scipy==1.18.1 seaborn==0.13.2
• tip: to identify the notebook across renames, pass the uid: ln.track("FATGTTa0bL50")
```

We can load the dataset using `lamindb`.

```python
af = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="preprocessing_visualization/quality_control_adata.h5ad", is_latest=True
)
adata = af.load()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 16934 × 36601
    var: 'gene_ids', 'feature_types', 'genome', 'interval'
    layers: None (.X)
```

After reading the data, scanpy displays a warning that not all variable names are unique.
This indicates that some variables (here genes) appear more than once which can lead to errors or unintended behavior for downstream analysis tasks.
We execute the proposed function `var_names_make_unique()` which makes the variable name unique by appending a number string to each duplicate index element: ‘1’, ‘2’, etc.

```python
adata.var_names_make_unique()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 16934 × 36601
    var: 'gene_ids', 'feature_types', 'genome', 'interval'
    layers: None (.X)
```

The dataset has the shape `n_obs` 16,934 x `n_vars` 36,601. This translates into `barcodes x number of transcripts`.
We additionally inspect further information in `.var` in terms of gene_ids (Ensembl Id), feature_types and genome.

Most subsequent analysis tasks assume that each observation in the dataset represents measurements from one intact single-cell.
In some cases, this assumption can be violated by low-quality cells, contamination of cell-free RNA, or doublets.
This tutorial will guide you through correcting and removing these violations and obtaining a high-quality dataset.

![Ambient RNA Overview](https://www.sc-best-practices.org/build/quality_control-2e88a3fb8412acb1c7ba2c6aae19a901.jpeg)

*Figure 1: Single-cell RNA-seq datasets can contain low-quality cells, cell-free RNA and doublets.
Quality control aims to remove and correct for those to obtain a high-quality dataset where each observation is an intact single cell.*

## Filtering low quality cells

The first step in quality control is to remove low-quality cells from the dataset.
When a cell has a low number of detected genes, a low [count depth](../glossary.md#term-sequencing-depth), and a high fraction of mitochondrial counts it might have a broken membrane which can indicate a dying cell.
As these cells are usually not the main target of our analysis and might distort our downstream analysis, we remove them during quality control.
To identify them, we define the cell quality control (QC) threshold.
Cell QC is typically performed on the following three QC covariates:

1. The number of counts per barcode (count depth)
2. The number of genes per barcode
3. The fraction of counts from mitochondrial genes per barcode

In cell QC these covariates are filtered via thresholding as they might correspond to dying cells.
As indicated, they might reflect cells with broken membranes whose cytoplasmic mRNA has leaked out, and therefore only the mRNA in the mitochondria is still present.
These cells might then show a low count depth, few detected genes, and a high fraction of mitochondrial counts.
It is, however, crucial to consider the three QC covariates jointly as otherwise, it might lead to misinterpretation of cellular signals.
Cells with a relatively high fraction of mitochondrial counts might for example be involved in respiratory processes and should not be filtered out.
Whereas, cells with low or high counts might correspond to quiescent cell populations or cells larger in size.
It is therefore preferred to consider multiple covariates when thresholding decisions on single covariates are made.
In general, it is advised to exclude fewer cells and be as permissive as possible to avoid filtering out viable cell populations or small sub-populations.

QC on only a few or small datasets is often performed manually by looking at the distribution of different QC covariates and identifying outliers which will be filtered afterward.
However, as datasets grow in size this task is becoming more and more time-consuming and it might be worth considering automatic thresholding via MAD (median absolute deviations).
The MAD is given by $MAD = median(|X_i - median(X)|)$ with $X_i$ being the respective QC metric of observation and describes a robust statistic of the variability of the metric.
Similar to (Germain *et al.*, 2020 [3]), we mark cells as outliers if they differ by 5 MADs which is a relatively permissive filtering strategy.
We want to highlight that it might be reasonable to re-assess the filtering after the [annotation](../cellular-structure/annotation.md) of cells.

In QC, the first step is to calculate the QC covariates or metric.
We compute these using the scanpy function `scanpy.pp.calculate_qc_metrics`, which can also calculate the proportions of counts for specific gene populations.
We therefore define mitochondrial, ribosomal, and hemoglobin genes.
It is important to note that mitochondrial counts are annotated either with the prefix “mt-” or “MT-” depending on the species considered in the dataset.
As mentioned, the dataset used in this notebook is human bone marrow, so mitochondrial counts are annotated with the prefix “MT-”.
For mouse datasets, the prefix is usually in lower case, so “mt-”.
Matching on the gene symbol prefix is only one way to find these genes, and it relies on the annotation the dataset happens to ship with.
Where symbols are missing or follow a different convention, mitochondrial genes can be selected from the chromosome each gene is annotated to, or from a curated list of gene identifiers.

Ribosomal and hemoglobin genes are defined here as additional diagnostics rather than as filtering criteria.
A high fraction of hemoglobin counts points at contamination with red blood cells, and the ribosomal fraction varies with cell state and can help explain what separates clusters later on.
Neither enters the filtering below, which uses the count depth, the number of detected genes and the mitochondrial fraction.

```python
# mitochondrial genes
adata.var["mt"] = adata.var_names.str.startswith("MT-")
# ribosomal genes
adata.var["ribo"] = adata.var_names.str.startswith(("RPS", "RPL"))
# hemoglobin genes.
adata.var["hb"] = adata.var_names.str.contains(r"^HB[ABDEGMQZ]\d*(?!\w)")
```

We can now calculate the respective QC metrics with scanpy.

```python
sc.pp.calculate_qc_metrics(
    adata, qc_vars=["mt", "ribo", "hb"], inplace=True, percent_top=[20], log1p=True
)
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 16934 × 36601
    obs: 'n_genes_by_counts', 'log1p_n_genes_by_counts', 'total_counts', 'log1p_total_counts', 'pct_counts_in_top_20_genes', 'total_counts_mt', 'log1p_total_counts_mt', 'pct_counts_mt', 'total_counts_ribo', 'log1p_total_counts_ribo', 'pct_counts_ribo', 'total_counts_hb', 'log1p_total_counts_hb', 'pct_counts_hb'
    var: 'gene_ids', 'feature_types', 'genome', 'interval', 'mt', 'ribo', 'hb', 'n_cells_by_counts', 'mean_counts', 'log1p_mean_counts', 'pct_dropout_by_counts', 'total_counts', 'log1p_total_counts'
    layers: None (.X)
```

The function added a couple of additional columns to `.var` and `.obs`.
We want to highlight a few of them here:

- `n_genes_by_counts` in `.obs` is the number of genes with positive counts in a cell,
- `total_counts` is the total number of counts for a cell, this might also be known as library size, and
- `pct_counts_mt` is the proportion of total counts for a cell which are mitochondrial.

The boolean `mt`, `ribo` and `hb` flags in `.var` define which genes are summed into `total_counts_mt`, `pct_counts_mt` and the corresponding ribosomal and hemoglobin columns.

We now plot the three QC covariates `n_genes_by_counts`, `total_counts` and `pct_counts_mt` per sample to assess how well the respective cells were captured.

```python
p1 = sns.displot(adata.obs["total_counts"], bins=100, kde=False)
p2 = sc.pl.violin(adata, "pct_counts_mt")
p3 = sc.pl.scatter(adata, "total_counts", "n_genes_by_counts", color="pct_counts_mt")
```

The plots indicate that some cells have a relatively high percentage of mitochondrial counts which are often associated with cell degradation.
But since the number of counts per cell is sufficiently high and the percentage of mitochondrial counts is for most cells below 20 % we can still process the data.
Based on these plots, one could now also define manual thresholds for filtering cells.
Instead, we will show QC with automatic thresholding and filtering based on MAD.

Very low and very high count depths, numbers of genes and fractions of counts in the top 20 genes all warrant a closer look, whereas only a high mitochondrial fraction marks a low quality cell.
We therefore define a function that computes the thresholds `nmads` MADs below and above the median of a metric, and one that flags the cells beyond them on both sides or only above.

```python
def mad_thresholds(values: pd.Series, nmads: float) -> tuple[float, float]:
    """Thresholds `nmads` median absolute deviations below and above the median of `values`."""
    median, mad = np.median(values), median_abs_deviation(values)
    return median - nmads * mad, median + nmads * mad

def is_outlier(
    adata: ad.AnnData,
    metric: str,
    nmads: float,
    side: Literal["both", "upper"] = "both",
) -> pd.Series:
    """Flag the cells beyond the MAD thresholds of `metric`, on both sides or only above."""
    values = adata.obs[metric]
    lower, upper = mad_thresholds(values, nmads)
    return values > upper if side == "upper" else (values < lower) | (values > upper)
```

Like the counts, which we use log-transformed, the bounded and skewed mitochondrial fraction needs a transformation before computing MADs, so we logit-transform it.
A pseudocount keeps cells without mitochondrial counts finite.

```python
mt_fraction = (adata.obs["total_counts_mt"] + 1) / (adata.obs["total_counts"] + 2)
adata.obs["logit_mt_fraction"] = logit(mt_fraction)
```

We use 5 MADs for the first three metrics.
For the mitochondrial fraction, we follow Germain *et al.* (2020) [3] and only flag cells that exceed both 3 MADs and a fixed cutoff of 8 % (dashed), which is not universal since mitochondrial content differs between cell types and tissues.

```python
qc_filters = {
    "log1p_total_counts": (5, "both"),
    "log1p_n_genes_by_counts": (5, "both"),
    "pct_counts_in_top_20_genes": (5, "both"),
    "logit_mt_fraction": (3, "upper"),
}

flags = {
    metric: is_outlier(adata, metric, nmads, side)
    for metric, (nmads, side) in qc_filters.items()
}
adata.obs["outlier"] = (
    flags["log1p_total_counts"]
    | flags["log1p_n_genes_by_counts"]
    | flags["pct_counts_in_top_20_genes"]
)
adata.obs["mt_outlier"] = flags["logit_mt_fraction"] & (adata.obs["pct_counts_mt"] > 8)
adata.obs[["outlier", "mt_outlier"]].value_counts()
```

Output:
```text
outlier  mt_outlier
False    False         15998
True     False           679
         True            190
False    True             67
Name: count, dtype: int64
```

**Checking the thresholds**

Automatic thresholds do not work for every dataset, so it is worth drawing them into the distribution of each metric before filtering, with the fixed cutoff of 8 % dashed.

```python
fig, axes = plt.subplots(1, len(qc_filters), figsize=(16, 3.5))
for ax, (metric, (nmads, side)) in zip(axes, qc_filters.items(), strict=True):
    sns.histplot(adata.obs[metric], bins=100, ax=ax)
    lower, upper = mad_thresholds(adata.obs[metric], nmads)
    for threshold in [upper] if side == "upper" else [lower, upper]:
        ax.axvline(threshold, color="red")
axes[-1].axvline(logit(0.08), color="red", linestyle="--")
plt.tight_layout()
plt.show()
```

The thresholds only cut off the tails of the distributions, and since the MAD threshold on the mitochondrial fraction lies below 8 %, the fixed cutoff decides which cells are filtered.

```python
fig, axes = plt.subplots(1, len(qc_filters), figsize=(16, 3.5))
for ax, (metric, (nmads, side)) in zip(axes, qc_filters.items(), strict=True):
    sns.histplot(adata.obs[metric], bins=100, ax=ax)
    lower, upper = mad_thresholds(adata.obs[metric], nmads)
    for threshold in [upper] if side == "upper" else [lower, upper]:
        ax.axvline(threshold, color="red")
axes[-1].axvline(logit(0.08), color="red", linestyle="--")
plt.tight_layout()
plt.show()
```

We now filter our AnnData object based on these two additional columns.

```python
print(f"Total number of cells: {adata.n_obs}")
adata = adata[(~adata.obs.outlier) & (~adata.obs.mt_outlier)].copy()

print(f"Number of cells after filtering of low quality cells: {adata.n_obs}")
```

Output:
```text
Total number of cells: 16934
Number of cells after filtering of low quality cells: 15998
```

```python
p1 = sc.pl.scatter(adata, "total_counts", "n_genes_by_counts", color="pct_counts_mt")
```

## Correction of ambient RNA

Unlike the filtering above, correcting for ambient RNA is not part of every analysis, and it only applies to droplet-based protocols.
We cover it here because the contamination it describes violates the same one droplet, one cell assumption as the doublets discussed further below.
Whether it is worth applying depends on how much contamination a dataset carries and on how sensitive the downstream analysis is to it.

For droplet-based single cell RNA-seq experiments, a certain amount of background mRNAs is present in the dilution that gets distributed into the droplets with cells and sequenced along with them.
The net effect of this is to produce a background contamination that represents expression not from the cell contained within a droplet, but the solution that contained the cells.

Droplet-based scRNA-seq generates counts of [unique molecular identifiers (UMIs)](../glossary.md#term-unique-molecular-identifier-umi) for genes across multiple cells and aims to identify the number of molecules for each gene and each cell.
It assumes that each droplet contains mRNA from single cells.
[Doublet](../glossary.md#term-doublets), empty droplets and cell-free RNA can violate this assumption.
Cell-free mRNA molecules represent background mRNA that is present in the dilution.
These molecules get distributed along the droplets and are sequenced along with them.
This contamination of cell-free mRNA in the input solution is typically called “the soup” which is created by cell lysis.

![Ambient RNA Overview](https://www.sc-best-practices.org/build/ambient_rna-43c6cd9559e7d2f3495ad70369eb28cd.jpeg)

*Figure 2: In droplet-based sequencing technologies, droplets can incorporate ambient RNA or doublets (droplets with multiple cells captured).
Contaminating ambient RNA is barcoded and counted together with the native mRNA from the cell leading to confounded counts.*

Cell-free mRNA molecules, also known as ambient RNA, can confound the number of observed counts and can be seen as background contamination.
It can be important to correct droplet-based scRNA-seq datasets for cell-free mRNA as it may distort the interpretation of the data in our downstream analysis.
Generally, the soup differs for each input solution and depends on the expression pattern across individual cells in the dataset.
Ambient RNA correction therefore has to be run separately for every sample, more precisely for every channel of the droplet device (Young & Behjati, 2020 [4]).
Methods for removal of ambient mRNA like SoupX (Young & Behjati, 2020 [4]) and DecontX (Yang *et al.*, 2020 [5]) aim to estimate the composition of the soup and correct the count table with respect to the soup-based expression.

As a first step, SoupX calculates the profile of the soup. It estimates the ambient mRNA expression profile from empty droplets as given by the unfiltered Cellranger matrix.
Next, SoupX estimates the cell-specific contamination fraction.
Lastly, it corrects the expression matrix according to the ambient mRNA expression profile and the estimated contamination.

The output of SoupX is a modified counts matrix, which can be used for any downstream analysis tool.

We now load the required python and R packages needed for running SoupX.

```python
import logging

import rpy2.rinterface_lib.callbacks as rcb
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri

rcb.logger.setLevel(logging.ERROR)

%load_ext rpy2.ipython
```

```python
%%R
library(SoupX)
```

SoupX can be run without clustering information, however as Young and Behjati(Young & Behjati, 2020 [4]) note that the results are better if a basic clustering is provided.
SoupX can be used with the default clustering produced by Cellranger or by manually defining clusters.
We will showcase the latter in this notebook as the results from SoupX are not strongly sensitive to the clustering used.

We now create a copy of our AnnData object, normalize it, reduce its dimensionality and compute default Leiden clusters on the processed copy.
The [clustering chapter](../cellular-structure/clustering.md) introduces clustering in more detail.
For now, we just need to know that Leiden clustering gives us partitions (communities) of cells in our dataset.
We save the obtained clusters as `soupx_groups` and delete the copy of the AnnData object to save some memory in our notebook.

Firstly, we generate a copy of our AnnData object, normalize and log1p transform it.
We use simply shifted logarithm normalization at this point.
More information on different normalization techniques can be found in the [normalization chapter](../preprocessing-visualization/normalization.md).

```python
adata_pp = adata.copy()
sc.pp.normalize_total(adata_pp, target_sum=1e4)
sc.pp.log1p(adata_pp)
```

Next, we compute the principal components of the data to obtain a lower dimensional representation.
This representation is then used to generate a neighbourhood graph of the data and run leiden clustering on the KNN-graph.
We add the clusters as `soupx_groups` to `.obs` and save them as a vector.

```python
sc.pp.pca(adata_pp)
sc.pp.neighbors(adata_pp)
sc.tl.leiden(
    adata_pp, key_added="soupx_groups", flavor="igraph", n_iterations=2, directed=False
)

# Preprocess variables for SoupX
adata.obs["soupx_groups"] = adata_pp.obs["soupx_groups"]
```

We can now delete the copy of our AnnData object as we generated a vector of clusters which can be used in soupX.

```python
del adata_pp
```

Next, we save the cell names, gene names, and the data matrix of the filtered cellranger output.
SoupX requires a matrix of shape features x barcodes, so we have to transpose `.X`.

```python
cells = adata.obs_names
genes = adata.var_names
data = adata.X.T
```

SoupX additionally requires the raw gene by cells matrix which is typically called `raw_feature_bc_matrix.h5` in the cellranger output.
We load this similarly as before the `filtered_feature_bc_matrix.h5` with `lamindb` and run `.var_names_make_unique()` on the object and transpose the respective `.X`.

```python
adata_raw = af.load()
adata_raw.var_names_make_unique()

genes_raw = adata_raw.var_names
cells_raw = adata_raw.obs_names

data_tod = adata_raw.X.T
```

```python
del adata_raw
```

We now need to convert the data into the right structure to be used in R.

```python
data_csc = data.tocsc()
data_tod_csc = data_tod.tocsc()

# Extract sparse components and cast to correct types
x = data_csc.data.astype(np.float64)
i = data_csc.indices.astype(np.int32)
p = data_csc.indptr.astype(np.int32)
dims = np.array(data_csc.shape, dtype=np.int32)

x_tod = data_tod_csc.data.astype(np.float64)
i_tod = data_tod_csc.indices.astype(np.int32)
p_tod = data_tod_csc.indptr.astype(np.int32)
dims_tod = np.array(data_tod_csc.shape, dtype=np.int32)

with localconverter(ro.default_converter + pandas2ri.converter + numpy2ri.converter):
    ro.globalenv["x"] = x
    ro.globalenv["i"] = i
    ro.globalenv["p"] = p
    ro.globalenv["dims"] = dims

    ro.globalenv["x_tod"] = x_tod
    ro.globalenv["i_tod"] = i_tod
    ro.globalenv["p_tod"] = p_tod
    ro.globalenv["dims_tod"] = dims_tod

    ro.globalenv["genes"] = np.array(genes)
    ro.globalenv["genes_raw"] = np.array(genes_raw)
    ro.globalenv["cells"] = np.array(cells)
    ro.globalenv["cells_raw"] = np.array(cells_raw)
    ro.globalenv["soupx_groups"] = adata.obs["soupx_groups"].to_numpy()
```

We now have everything in place to run SoupX.
The inputs are the filtered cellranger matrix of shape barcodes x cells, the raw table of droplets from cellranger of shape `barcodes x droplets`, the gene and cell names and the clusters obtained by simple leiden clustering.
The output will be the corrected count matrix.

We first construct a so called `SoupChannel` from the table of droplets and the table of cells.
Next, we add metadata to the SoupChannel object which can be any metadata in the form of a `data.frame`.

```python
%%R -o out 

library(Matrix)

# Manually coerce types to avoid "array" class errors
x <- as.numeric(x)
i <- as.integer(i)
p <- as.integer(p)
dims <- as.integer(dims)

x_tod <- as.numeric(x_tod)
i_tod <- as.integer(i_tod)
p_tod <- as.integer(p_tod)
dims_tod <- as.integer(dims_tod)

# Reconstruct sparse matrices
data <- new("dgCMatrix",
            Dim = dims,
            x = x,
            i = i,
            p = p)

data_tod <- new("dgCMatrix",
                Dim = dims_tod,
                x = x_tod,
                i = i_tod,
                p = p_tod)

# Assign row and column names
rownames(data) <- genes
colnames(data) <- cells
rownames(data_tod) <- genes_raw
colnames(data_tod) <- cells_raw

# SoupX pipeline
sc = SoupChannel(data_tod, data, calcSoupProfile = TRUE)
sc = setClusters(sc, soupx_groups)
sc = autoEstCont(sc, doPlot = FALSE)
out = adjustCounts(sc, roundToInt = TRUE)
```

Output:
```text
621 genes passed tf-idf cut-off and 241 soup quantile filter.  Taking the top 100.
Using 932 independent estimates of rho.
Estimated global rho of 0.05
Expanding counts from 18 clusters to 15998 cells.
In addition: Warning message:
In sparseMatrix(i = out@i[w] + 1, j = out@j[w] + 1, x = out@x[w],  :
  'giveCsparse' is deprecated; setting repr="T" for you
```

SoupX successfully inferred corrected counts, which we can now store as an additional layer.
In all following analysis steps, we would like to use the SoupX corrected count matrix, so we overwrite `.X` with the soupX corrected matrix.
First, as we did before from python to R, we convert the matrix from R to python.

```python
with localconverter(ro.default_converter + pandas2ri.converter + numpy2ri.converter):
    out_py = ro.conversion.rpy2py(ro.globalenv["out"])

x = np.array(out_py.slots["x"])
i = np.array(out_py.slots["i"])
p = np.array(out_py.slots["p"])
shape = tuple(out_py.slots["Dim"])

out_matrix = csc_matrix((x, i, p), shape=shape)
```

```python
adata.layers["counts"] = adata.X.copy()
adata.layers["soupX_counts"] = out_matrix.T
adata.X = adata.layers["soupX_counts"]
```

Next, we additionally filter out genes that are not detected in at least 20 cells as these are not informative.
This exclusion is necessary because genes detected in very few cells are often the result of technical noise, ambient RNA contamination, or stochastic low-level transcription, rather than true biological signal.
Including such lowly detected genes can introduce noise, obscure meaningful biological patterns, and complicate downstream analyses like clustering, [differential expression](../glossary.md#term-differential-gene-expression-dge) testing, or trajectory inference.
By setting a minimum detection threshold (e.g., 20 cells), we focus the analysis on genes that are consistently observed across multiple cells, improving the reliability and interpretability of the results.

```python
print(f"Total number of genes: {adata.n_vars}")

# Min 20 cells - filters out 0 count genes
sc.pp.filter_genes(adata, min_cells=20)
print(f"Number of genes after cell filter: {adata.n_vars}")
```

Output:
```text
Total number of genes: 36601
Number of genes after cell filter: 20362
```

Note that the number of genes after cell filter might vary slightly between runs due to differences in the random number generator (RNG) state.

## Doublet Detection

Doublets are defined as two cells that are sequenced under the same cellular barcode, for example, if they were captured in the same droplet.
That’s why we used the term “barcode” instead of “cell” until now.
A doublet is called homotypic if it is formed by the same cell type (but from different individuals) and heterotypic otherwise.
Homotypic doublets are not necessarily identifiable from count matrices and are often considered innocuous as they can be identified with cell hashing or SNPs.
Hence, their identification is not the main goal of the doublet detection methods.

Doublets formed from different cell types or states are called heterotypic.
Their identification is crucial as they are most likely misclassified and can lead to distorted downstream analysis steps.
Hence, doublet detection and removal are typically initial preprocessing steps.
Doublets can be either identified through their high number of reads and detected features, or with methods that create artificial doublets and compare these with the cells present in the dataset.
Doublet detection methods are computationally efficient and there exist several software packages for this task.

(Xi & Li, 2021 [6]) benchmarked nine different doublet detection methods and assessed their performance with respect to computational efficiency and doublet detection accuracy.
They additionally assessed scDblFinder in an addendum to their benchmark which achieved the highest doublet detection accuracy and a good computational efficiency and stability (Xi & Li, 2021 [7]).

In this tutorial, we will showcase the scDblFinder R package.
scDblFinder randomly selects two droplets and creates artificial doublets from those by averaging their gene expression profiles.
The doublet score is then defined as the fraction of artificial doublets in the k-nearest neighbor graph of each droplet in the principal component space.

Like ambient RNA correction, doublet detection has to be run per sample, as doublets only form between cells captured together.
In plate-based protocols such as Smart-seq2, cells are sorted into separate wells, so doublets are much rarer than in droplets and ambient RNA correction does not apply, while filtering low quality cells does.
Whether it should run before or after ambient RNA correction is unsettled ([scDblFinder documentation](https://bioconductor.org/packages/release/bioc/vignettes/scDblFinder/inst/doc/scDblFinder.html)), and we run it on the SoupX-corrected counts.

![Doublet detection overview](https://www.sc-best-practices.org/build/doublet_detection-e6131221262b7461d299f3f4fe571fe5.jpeg)

*Figure 3: Doublets are droplets that contain more than one cell.
Common doublet detection methods generate artificial doublets by randomly subsampling pairs of cells and averaging their gene expression profile to obtain doublet counts.
These artificial doublets are projected together with the remaining calls into a lower dimensional principal component space.
The doublet detection method computes a doublet score based on the number of artificial doublet neighbors in the k nearest neighbor graph.*

We first load some additional R packages.

```python
%%R
library(scater)
library(scDblFinder)
library(SingleCellExperiment)
library(BiocParallel)
```

Output:
```text
Loading required package: SingleCellExperiment
Loading required package: SummarizedExperiment
Loading required package: MatrixGenerics
Loading required package: matrixStats

Attaching package: ‘MatrixGenerics’

The following objects are masked from ‘package:matrixStats’:

    colAlls, colAnyNAs, colAnys, colAvgsPerRowSet, colCollapse,
    colCounts, colCummaxs, colCummins, colCumprods, colCumsums,
    colDiffs, colIQRDiffs, colIQRs, colLogSumExps, colMadDiffs,
    colMads, colMaxs, colMeans2, colMedians, colMins, colOrderStats,
    colProds, colQuantiles, colRanges, colRanks, colSdDiffs, colSds,
    colSums2, colTabulates, colVarDiffs, colVars, colWeightedMads,
    colWeightedMeans, colWeightedMedians, colWeightedSds,
    colWeightedVars, rowAlls, rowAnyNAs, rowAnys, rowAvgsPerColSet,
    rowCollapse, rowCounts, rowCummaxs, rowCummins, rowCumprods,
    rowCumsums, rowDiffs, rowIQRDiffs, rowIQRs, rowLogSumExps,
    rowMadDiffs, rowMads, rowMaxs, rowMeans2, rowMedians, rowMins,
    rowOrderStats, rowProds, rowQuantiles, rowRanges, rowRanks,
    rowSdDiffs, rowSds, rowSums2, rowTabulates, rowVarDiffs, rowVars,
    rowWeightedMads, rowWeightedMeans, rowWeightedMedians,
    rowWeightedSds, rowWeightedVars

... (66 more lines)
```

```python
data_mat = adata.X.T
```

We can now launch the doublet detection by using data_mat as input to scDblFinder within a SingleCellExperiment.
`scDblFinder` adds several columns to the colData of sce.
Three of them might be interesting for the analysis:

- `sce$scDblFinder.score`: the final doublet score (the higher the more likely that the cell is a doublet)
- `sce$scDblFinder.ratio` : the ratio of artificial doublets in the cell’s neighborhood
- `sce$scDblFinder.class` : the classification (doublet or singlet)

We will only output the class argument and store it in the AnnData object in `.obs` .
The other arguments can be added to the AnnData object similarly.

Again, we first have to convert the matrix from python to R.

```python
data_mat = adata.X.T.tocsc()

x = data_mat.data.astype(np.float64)
i = data_mat.indices.astype(np.int32)
p = data_mat.indptr.astype(np.int32)
dims = np.array(data_mat.shape, dtype=np.int32)

with localconverter(ro.default_converter + numpy2ri.converter):
    ro.globalenv["x"] = x
    ro.globalenv["i"] = i
    ro.globalenv["p"] = p
    ro.globalenv["dims"] = dims
```

Now:

```python
%%R -o doublet_score -o doublet_class

x <- as.numeric(x)
i <- as.integer(i)
p <- as.integer(p)
dims <- as.integer(dims)

data_mat <- new("dgCMatrix", Dim = dims, x = x, i = i, p = p)

set.seed(123)
sce <- scDblFinder(SingleCellExperiment(list(counts = data_mat)))

doublet_score <- sce$scDblFinder.score
doublet_class <- sce$scDblFinder.class
```

Output:
```text
Creating ~12799 artificial doublets...
Dimensional reduction
Evaluating kNN...
Training model...
iter=0, 2608 cells excluded from training.
iter=1, 2608 cells excluded from training.
iter=2, 2608 cells excluded from training.
Threshold found:0.382
2330 (14.6%) doublets called
In addition: Warning message:
In .checkSCE(sce, coerce = is.null(samples)) :
  Some cells in `sce` have an extremely low read counts; note that these could trigger errors and might best be filtered out
```

scDblFinder outputs a class with the classification `Singlet` (1) and `Doublet` (2).
We add this to our AnnData object in `.obs`.

```python
adata.obs["scDblFinder_score"] = doublet_score
adata.obs["scDblFinder_class"] = doublet_class
adata.obs.scDblFinder_class.value_counts()
```

Output:
```text
scDblFinder_class
singlet    13668
doublet     2330
Name: count, dtype: int64
```

We advise to leave identified doublets in the dataset for now and inspect doublets during [visualization](../preprocessing-visualization/dimensionality-reduction.md).

During downstream [clustering](../cellular-structure/clustering.md) it might be useful to reassess quality control and the chosen parameters to potentially filter out more or less cells.
We will now save the dataset into `lamindb`, so that we can continue with the [normalization chapter](../preprocessing-visualization/normalization.md).

```python
af = ln.Artifact.from_anndata(
    adata,
    key="preprocessing_visualization/s4d8_quality_control.h5ad",
    description="anndata after quality control",
).save()
af
```

Output:
```text
→ creating new artifact version for key 'preprocessing_visualization/s4d8_quality_control.h5ad' in storage 's3://lamin-eu-central-1/VPwcjx3CDAa2'

... uploading Y8EIAWzUB42V1j3S000E.h5ad:  0.0%

... uploading Y8EIAWzUB42V1j3S000E.h5ad:  9.3%

... uploading Y8EIAWzUB42V1j3S000E.h5ad: 18.7%

... uploading Y8EIAWzUB42V1j3S000E.h5ad: 74.7%

... uploading Y8EIAWzUB42V1j3S000E.h5ad: 100.0%
• replacing the existing cache path /home/lheumos/.cache/lamindb/lamin-eu-central-1/VPwcjx3CDAa2/preprocessing_visualization/s4d8_quality_control.h5ad
Artifact(uid='Y8EIAWzUB42V1j3S000E', key='preprocessing_visualization/s4d8_quality_control.h5ad', description='anndata after quality control', suffix='.h5ad', kind='dataset', otype='AnnData', size=561375384, hash='Bzar7U_R7HI20VZRMnB_MI', n_files=None, n_observations=15998, extra_data=None, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=146, schema_id=None, created_by_id=2, created_at=2026-09-29 11:55:25 UTC, is_locked=False, version_tag=None, is_latest=True)
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Anna Schaar
- Seo H. Kim

### Reviewers

- Lukas Heumos
- Luke Zappia

## References

1. Zappia, L., & Theis, F. J. (2021). Over 1000 tools reveal trends in the single-cell RNA-seq analysis landscape. *Genome Biology*, *22*(1), 301. https://doi.org/10.1186/s13059-021-02519-4
2. Luecken, M. D., Burkhardt, D. B., Cannoodt, R., Lance, C., Agrawal, A., Aliee, H., Chen, A. T., Deconinck, L., Detweiler, A. M., Granados, A. A., Huynh, S., Isacco, L., Kim, Y. J., Klein, D., KUMAR, B. D., Kuppasani, S., Lickert, H., McGeever, A., Mekonen, H., … Bloom, J. M. (2021). A sandbox for prediction and integration of DNA, RNA, and proteins in single cells. *Thirty-Fifth Conference on Neural Information Processing Systems Datasets and Benchmarks Track (Round 2)*. https://openreview.net/forum?id=gN35BGa1Rt
3. Germain, P.-L., Sonrel, A., & Robinson, M. D. (2020). pipeComp, a general framework for the evaluation of computational pipelines, reveals performant single cell RNA-seq preprocessing tools. *Genome Biology*, *21*(1), 227. https://doi.org/10.1186/s13059-020-02136-7
4. Young, M. D., & Behjati, S. (2020). SoupX removes ambient RNA contamination from droplet-based single-cell RNA sequencing data. *GigaScience*, *9*(12). https://doi.org/10.1093/gigascience/giaa151
5. Yang, S., Corbett, S. E., Koga, Y., Wang, Z., Johnson, W. E., Yajima, M., & Campbell, J. D. (2020). Decontamination of ambient RNA in single-cell RNA-seq with DecontX. *Genome Biology*, *21*(1), 57. https://doi.org/10.1186/s13059-020-1950-6
6. Xi, N. M., & Li, J. J. (2021). Benchmarking Computational Doublet-Detection Methods for Single-Cell RNA Sequencing Data. *Cell Systems*, *12*(2), 176-194.e6. https://doi.org/10.1016/j.cels.2020.11.008
7. Xi, N. M., & Li, J. J. (2021). Protocol for executing and benchmarking eight computational doublet-detection methods in single-cell RNA sequencing data analysis. *STAR Protocols*, *2*(3), 100699. https://doi.org/10.1016/j.xpro.2021.100699
