# Data integration

Source: https://www.sc-best-practices.org/cellular-structure/integration  
Authors: Luke Zappia, Malte Lücken, Seo H. Kim, Lukas Heumos

**🧠 Key takeaways**

- Visualize your data before attempting to correct for batch effects to assess the extent of the issue.
Batch effect correction is not always required and it might mask the biological variation of interest.
- If cell labels are available and biological variation is the most important, the usage of methods that can use these labels (such as scANVI) is advised.
- Consider running several integration methods on your dataset and evaluating them with the **scIB** metrics to use the integration that is most robust for your use case.

**⚙️ Environment setup**

**yml:**

```yaml
name: integration
channels:
  - conda-forge
  - bioconda
  - defaults
dependencies:
  - conda-forge::python=3.11
  - conda-forge::ipykernel=7.1.0
  - conda-forge::jupyterlab=4.5.1
  - conda-forge::scanpy=1.11.5
  - bioconda::anndata2ri=2.0
  - bioconda::bioconductor-singlecellexperiment=1.28.0
  - igraph=1.0.1
  - pip=25.3
  - python-igraph=1.0.0
  - conda-forge::r-base=4.4.3
  - r-sessioninfo=1.2.3
  - r-seurat=5.4.0
  - r-spatstat=3.5_0
  - rpy2=3.6.4
  - scikit-learn=1.8.0
  - scikit-misc=0.5.2
  - scvi-tools=1.4.1
  - session-info=1.0.0
  - pip:
      - scib==1.1.7
      - lamindb
      - bbknn
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

A central challenge in most scRNA-seq data analyses is presented by batch effects.
Batch effects are changes in measured expression levels that are the result of handling cells in distinct groups or “batches”.
For example, a batch effect can arise if two labs have taken samples from the same cohort, but these samples are dissociated differently.
If Lab A optimizes its dissociation protocol to dissociate cells in the sample while minimizing the stress on them, and Lab B does not, then it is likely that the cells in the data from the group B will express more stress-linked genes (JUN, JUNB, FOS, etc. see (Brink *et al.*, 2017 [1])) even if the cells had the same profile in the original tissue.
In general, the origins of batch effects are diverse and difficult to pin down.
Some batch effect sources might be technical, such as differences in sample handling, experimental protocols, or [sequencing](../glossary.md#term-sequencing) depths, but biological effects such as donor variation, tissue, or sampling location are also often interpreted as a batch effect (Luecken *et al.*, 2021 [2]).
Whether biological factors should be considered as batch effects depends on the experimental design and the question being asked.
Removing batch effects is crucial to enable joint analysis that can focus on identifying common structure in the data across batches, allowing us to perform queries across datasets.
Often, it is only after removing these effects that rare cell populations can be identified that were previously obscured by differences between batches.
Enabling queries across datasets allows us to ask questions that could not be answered by analysing individual datasets, such as *Which cell types express SARS-CoV-2 entry factors and how does this expression differ between individuals?* (Muus *et al.*, 2021 [3]).

When removing batch effects from omics data, one must make two central choices: (1) the method and parameterization, and (2) the batch covariate.
As batch effects can arise between groupings of cells at different levels (i.e., samples, donors, datasets, etc.), the choice of batch covariate indicates which level of variation should be retained and which level removed.
The finer the batch resolution, the more effects will be removed. However, fine batch variation is also more likely to be confounded with biologically meaningful signals.
For example, samples typically come from different individuals or different locations in the tissue.
These effects may be worth examining.
Thus, the choice of batch covariate will depend on the goal of your integration task.
Do you want to see differences between individuals, or are you focused on common variations within cell types?
An approach to batch covariate selection based on quantitative analyses was pioneered in a recent effort to build an integrated atlas of the human lung, where the variance attributable to different technical covariates was used to make this choice (Sikkema *et al.*, 2022 [4]).

### Types of integration models

Methods that remove batch effects in scRNA-seq are typically composed of (up to) three steps:

1. Dimensionality reduction
2. Modeling and removing the batch effect
3. Projection back into a [high-dimensional](../glossary.md#term-high-dimensional-data) space

While modeling and removing the batch effect (Step 2) is the central part of any batch removal method, many methods first project the data to a lower dimensional space (Step 1) to improve the signal-to-noise ratio (see the [dimensionality reduction chapter](../preprocessing-visualization/dimensionality-reduction.md)) and perform batch correction in that space to achieve better performance (see (Luecken *et al.*, 2021 [2])).
In the third step, a method may project the data back into the original high-dimensional feature space after removing the fitted batch effect, thereby outputting a batch-corrected gene expression matrix.

Batch-effect removal methods can vary in each of these three steps.
They may use various linear or non-linear dimensionality reduction approaches, linear or non-linear batch effect models, and output different formats of batch-corrected data.
Overall, we can divide methods for batch effect removal into 4 categories.
In their order of development, these are global models, linear embedding models, graph-based methods, and deep learning approaches (Fig. I1).

**Global models** originate from bulk transcriptomics and model the batch effect as a consistent (additive and/or multiplicative) effect across all cells.
A common example is ComBat (Johnson *et al.*, 2007 [5]).

**Linear embedding models** were the first single-cell-specific batch removal methods.
These approaches often use a variant of singular value decomposition (SVD) to embed the data, then look for local neighborhoods of similar cells across batches in the embedding, which they use to correct the batch effect in a locally adaptive (non-linear) manner.
Methods often project the data back into gene expression space using the SVD loadings, but may also only output a corrected embedding.
This is the most common group of methods and prominent examples include the pioneering mutual nearest neighbors (MNN) method (Haghverdi *et al.*, 2018 [6]) (which does not perform any dimensionality reduction), Seurat integration (Butler *et al.*, 2018 [7]; Stuart *et al.*, 2019 [8]), Scanorama (Hie *et al.*, 2019 [9]), FastMNN (Haghverdi *et al.*, 2018 [6]), and Harmony (Korsunsky *et al.*, 2019 [10]).

**Graph-based methods** are typically the fastest methods to run.
These approaches use a nearest-neighbor graph to represent the data from each batch.
Batch effects are corrected by forcing connections between cells from different batches and then allowing for differences in cell type compositions by pruning the forced edges.
The most prominent example of these approaches is the Batch-Balanced *k*-Nearest Neighbor (BBKNN) method (Polański *et al.*, 2019 [11]).

**Deep learning (DL) approaches** are the most recent, and most complex methods for batch effect removal that typically require the most data for good performance.
Most deep learning integration methods are based on autoencoder networks, where either the dimensionality reduction is conditioned on the batch covariate in a conditional variational autoencoder (CVAE) or a locally linear correction is fitted in the embedded space.
Prominent examples of DL methods are **scVI** (Lopez *et al.*, 2018 [12]), **scANVI** (Xu *et al.*, 2021 [13]), and **scGen** (Lotfollahi *et al.*, 2019 [14]).

Some methods can use cell identity labels to provide the method with a reference for what biological variation should not be removed as a batch effect.
As batch-effect removal is typically a preprocessing task, such approaches may not be applicable to many integration scenarios, as labels are generally not yet available at this stage.

More detailed overviews of batch-effect removal methods can be found in (Argelaguet *et al.*, 2021 [15]) and (Luecken *et al.*, 2021 [2]).

![Overview_fig](https://www.sc-best-practices.org/build/integration_overview-99526232a426b2909a020deb1e7b36a4.jpeg)
Fig. I1: Overview of different types of integration methods with examples.

### Batch removal complexity

The removal of batch effects in scRNA-seq data has previously been divided into two subtasks: batch correction and data integration (Luecken & Theis, 2019 [16]).
These subtasks differ in the complexity of the batch effect that must be removed.
Batch correction methods address batch effects between samples in the same experiment, where cell identity compositions are consistent, and the effect is often quasi-linear.
In contrast, data integration methods deal with complex, often nested, batch effects between datasets that may be generated using different protocols, where cell identities may not be shared across batches.
While we use this distinction here, it is worth noting that these terms are often used interchangeably in general usage.
Given the differences in complexity, it is not surprising that different methods have been benchmarked as being optimal for these two subtasks.

### Comparisons of data integration methods

Several benchmarks have previously evaluated the performance of methods for batch correction and data integration.
When removing batch effects, methods may overcorrect and remove meaningful biological variation in addition to the batch effect.
For this reason, it is important that integration performance is evaluated by considering both batch effect removal and the conservation of biological variation.

The *k*-nearest-neighbor Batch-Effect Test (kBET) was the first metric for quantifying batch correction of scRNA-seq data  (Büttner *et al.*, 2019 [17]).
Using kBET, the authors found that **ComBat** outperformed other approaches for batch correction while comparing predominantly global models.
Building on this, two recent benchmarks (Tran *et al.*, 2020 [18]) and (Chazarra-Gil *et al.*, 2021 [19]) also benchmarked linear-embedding and deep-learning models on batch correction tasks with few batches or low biological complexity.
These studies found that the linear-embedding models **Seurat** (Butler *et al.*, 2018 [7]; Stuart *et al.*, 2019 [8]) and **Harmony** (Korsunsky *et al.*, 2019 [10]) performed well for simple batch correction tasks.

Benchmarking complex integration tasks poses additional challenges due to both the size and number of datasets, as well as the diversity of scenarios.
Recently, a large study used 14 metrics to benchmark 16 methods across integration method classes on five RNA tasks and two simulations (Luecken *et al.*, 2021 [2]).
While top-performing methods varied by task, approaches that utilized cell type labels performed better across tasks.
Furthermore, deep learning approaches **scANVI** (with labels), **scVI**, and **scGen** (with labels), as well as the linear embedding model **Scanorama,** performed best, particularly on complex tasks, while **Harmony** performed well on less complex tasks.
A similar benchmark performed for the specific purpose of integrating retina datasets to build an *ocular mega-atlas* also found that **scVI** outperformed other methods (Swamy *et al.*, 2021 [20]).

### Choosing an integration method

While integration methods have now been extensively benchmarked, an optimal method for all scenarios does not exist.
Packages of integration performance metrics and evaluation pipelines like [**scIB**](https://github.com/theislab/scib) and [**batchbench**](https://github.com/cellgeni/batchbench) can be used to evaluate integration performance on your own data.
However, many metrics (particularly those that measure the conservation of biological variation) require ground-truth cell identity labels.
Parameter optimization may tune many methods to work for particular tasks, yet in general, one can say that **Harmony** and **Seurat** consistently perform well for simple batch correction tasks, and **scVI**, **scGen**, **scANVI**, and **Scanorama** perform well for more complex data integration tasks.
When choosing a method, we recommend considering these options first.
Additionally, frameworks like [**Open Problems**](https://openproblems.bio) provide benchmarking platforms, including a leaderboard with results from various tasks such as batch integration (Luecken *et al.*, 2025 [21]).

Furthermore, the choice of integration method may be guided by the required output data format (i.e., do you need corrected gene expression data or does an integrated embedding suffice?).
It would be prudent to test multiple methods and evaluate the outputs based on quantitative definitions of success before selecting one.
Extensive guidelines for choosing a data integration method can be found in (Luecken *et al.*, 2021 [2]).

In the rest of this chapter, we demonstrate some of the best-performing methods and quickly demonstrate how integration performance can be evaluated.

Let’s silence some warnings, that will not affect our code:

```python
import warnings

# This looks for any warning containing this specific text
warnings.filterwarnings("ignore", message=".*encoding metadata.*")
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.simplefilter(action="ignore", category=FutureWarning)
warnings.filterwarnings(
    "ignore", message=".*The default of observed=False is deprecated.*"
)
```

Now setting up the environments:

```python
# Python packages
import anndata2ri
import bbknn
import lamindb as ln
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import scanpy as sc
import scib
import scvi

# R interface

%load_ext rpy2.ipython
anndata2ri.set_ipython_converter()

ln.connect("theislab/sc-best-practices")

ln.track("0VP4jDUT9P3E")
```

Output:
```text
The rpy2.ipython extension is already loaded. To reload it, use:
  %reload_ext rpy2.ipython
→ loaded Transform('0VP4jDUT9P3E0000', key='integration.ipynb'), re-started Run('zYZOfUIlcXImvYWR') at 2026-02-16 19:19:58 UTC
→ notebook imports: anndata2ri==2.0 bbknn==1.6.0 lamindb==2.0.1 matplotlib==3.10.8 numpy==2.3.5 pandas==2.3.3 scanpy==1.11.5 scib==1.1.7 scvi-tools==1.4.1 session-info==1.0.0
```

Current environment dependencies are pinned to older versions of Python and Scanpy for BBKNN compatibility.
A version upgrade is planned following the upcoming integration of BBKNN into the Scanpy library.

```python
%%R
# R packages
library(Seurat)
```

## Dataset

The dataset we will use to demonstrate data integration contains several samples of bone marrow mononuclear cells.
These samples were originally created for the Open Problems in Single-Cell Analysis [NeurIPS Competition 2021](https://openproblems.bio/events/2021-09_neurips/) (Luecken *et al.*, 2022 [22]; Lance *et al.*, 2022 [23]).
The [10x Multiome](https://www.10xgenomics.com/products/single-cell-multiome-atac-plus-gene-expression) protocol was used which measures both RNA expression (scRNA-seq) and chromatin accessibility (scATAC-seq) in the same cells.
The version of the data we use here was already pre-processed to remove low-quality cells.

Let’s read in the dataset using **scanpy** to get an `AnnData` object.

```python
af = ln.Artifact.get(
    key="cellular_structure/openproblems_bmmc_multiome_genes_filtered.h5ad",
    is_latest=True,
)
adata_raw = af.load()
adata_raw.layers["logcounts"] = adata_raw.X
adata_raw
```

Output:
```text
AnnData object with n_obs × n_vars = 69249 × 129921
    obs: 'GEX_pct_counts_mt', 'GEX_n_counts', 'GEX_n_genes', 'GEX_size_factors', 'GEX_phase', 'ATAC_nCount_peaks', 'ATAC_atac_fragments', 'ATAC_reads_in_peaks_frac', 'ATAC_blacklist_fraction', 'ATAC_nucleosome_signal', 'cell_type', 'batch', 'ATAC_pseudotime_order', 'GEX_pseudotime_order', 'Samplename', 'Site', 'DonorNumber', 'Modality', 'VendorLot', 'DonorID', 'DonorAge', 'DonorBMI', 'DonorBloodType', 'DonorRace', 'Ethnicity', 'DonorGender', 'QCMeds', 'DonorSmoker'
    var: 'feature_types', 'gene_id'
    uns: 'ATAC_gene_activity_var_names', 'dataset_id', 'genome', 'organism'
    obsm: 'ATAC_gene_activity', 'ATAC_lsi_full', 'ATAC_lsi_red', 'ATAC_umap', 'GEX_X_pca', 'GEX_X_umap'
    layers: 'counts', 'logcounts'
```

The full dataset contains 69,249 cells and measurements for 129,921 features.
There are two versions of the expression matrix, `counts`, which contains the raw count values, and `logcounts`, which contains normalized log counts (these values are also stored in `adata.X`).

The `obs` slot contains several variables, some of which were calculated during pre-processing (for quality control) and others that contain metadata about the samples.
The ones we are interested in here are:

- `cell_type` - The annotated label for each cell
- `batch` - The sequencing batch for each cell

For a real analysis, it would be important to consider more variables, but to keep it simple here, we will only look at these.

We define variables to hold these names so that it is clear how we are using them in the code.
This also helps with reproducibility because if we decide to change one of them for whatever reason, we can be sure it has changed throughout the entire notebook.

```python
label_key = "cell_type"
batch_key = "batch"
```

> **What to use as the batch label?**
> 
> As mentioned above, deciding what to use as a “batch” for data integration is one of the central choices when integrating your data.
> The most common approach is to define each sample as a batch (as we have here), which generally produces the strongest batch correction.
> However, samples are usually confounded with biological factors that you may want to preserve.
> For example, consider an experiment that collected samples from two locations within a tissue.
> If samples are considered as batches, then data integration methods will attempt to remove differences between them and therefore differences between the locations.
> In this case, it may be more appropriate to use the donor as the batch to remove differences between individuals but not between locations.
> The planned analysis should also be considered.
> In cases where you are integrating many datasets and want to capture differences between individuals, the dataset may be a useful batch covariate.
> In our example, it may be better to have consistent cell type labels for the two locations and then test for differences between them than to have separate clusters for each location, which need to be annotated separately and then matched.
> 
> The issue of confounding between samples and biological factors can be mitigated through careful experimental design that minimizes the batch effect overall by using multiplexing techniques that allow biological samples to be combined into a single sequencing sample.
> However, this is not always possible and requires both extra processing in the lab and extra computational steps.

Now, let’s review the batches and their cell counts.

```python
adata_raw.obs[batch_key].value_counts()
```

Output:
```text
batch
s4d8     9876
s4d1     8023
s3d10    6781
s1d2     6740
s1d1     6224
s2d4     6111
s2d5     4895
s3d3     4325
s4d9     4325
s1d3     4279
s2d1     4220
s3d7     1771
s3d6     1679
Name: count, dtype: int64
```

There are 13 different batches in the dataset.
During this experiment, multiple samples were taken from a set of donors and sequenced at different facilities so the names here are a combination of the sample number (eg. “s1”) and the donor (eg. “d2”).
For simplicity, and to reduce computational time, we will select three samples to use.

```python
keep_batches = ["s1d3", "s2d1", "s3d7"]
adata = adata_raw[adata_raw.obs[batch_key].isin(keep_batches)].copy()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 10270 × 129921
    obs: 'GEX_pct_counts_mt', 'GEX_n_counts', 'GEX_n_genes', 'GEX_size_factors', 'GEX_phase', 'ATAC_nCount_peaks', 'ATAC_atac_fragments', 'ATAC_reads_in_peaks_frac', 'ATAC_blacklist_fraction', 'ATAC_nucleosome_signal', 'cell_type', 'batch', 'ATAC_pseudotime_order', 'GEX_pseudotime_order', 'Samplename', 'Site', 'DonorNumber', 'Modality', 'VendorLot', 'DonorID', 'DonorAge', 'DonorBMI', 'DonorBloodType', 'DonorRace', 'Ethnicity', 'DonorGender', 'QCMeds', 'DonorSmoker'
    var: 'feature_types', 'gene_id'
    uns: 'ATAC_gene_activity_var_names', 'dataset_id', 'genome', 'organism'
    obsm: 'ATAC_gene_activity', 'ATAC_lsi_full', 'ATAC_lsi_red', 'ATAC_umap', 'GEX_X_pca', 'GEX_X_umap'
    layers: 'counts', 'logcounts'
```

After subsetting to select these batches we are left with 10,270 cells.

We have two annotations for the features stored in `var`:

- `feature_types` - The type of each feature (RNA or ATAC)
- `gene_id` - The gene associated with each feature

Let’s have a look at the feature types.

```python
adata.var["feature_types"].value_counts()
```

Output:
```text
feature_types
ATAC    116490
GEX      13431
Name: count, dtype: int64
```

We can see that there are over 100,000 ATAC features, but only around 13,000 gene expression (“GEX”) features.
Integration of multiple modalities is a complex problem that will be described in the [multimodal integration chapter](../multimodal-integration/advanced-integration.md), so for now we will subset to only the gene expression features.
We also perform simple filtering to make sure we have no features with zero counts (this is necessary because by selecting a subset of samples, we may have removed all the cells that expressed a particular feature).

```python
adata = adata[:, adata.var["feature_types"] == "GEX"].copy()
sc.pp.filter_genes(adata, min_cells=1)
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 10270 × 13431
    obs: 'GEX_pct_counts_mt', 'GEX_n_counts', 'GEX_n_genes', 'GEX_size_factors', 'GEX_phase', 'ATAC_nCount_peaks', 'ATAC_atac_fragments', 'ATAC_reads_in_peaks_frac', 'ATAC_blacklist_fraction', 'ATAC_nucleosome_signal', 'cell_type', 'batch', 'ATAC_pseudotime_order', 'GEX_pseudotime_order', 'Samplename', 'Site', 'DonorNumber', 'Modality', 'VendorLot', 'DonorID', 'DonorAge', 'DonorBMI', 'DonorBloodType', 'DonorRace', 'Ethnicity', 'DonorGender', 'QCMeds', 'DonorSmoker'
    var: 'feature_types', 'gene_id', 'n_cells'
    uns: 'ATAC_gene_activity_var_names', 'dataset_id', 'genome', 'organism'
    obsm: 'ATAC_gene_activity', 'ATAC_lsi_full', 'ATAC_lsi_red', 'ATAC_umap', 'GEX_X_pca', 'GEX_X_umap'
    layers: 'counts', 'logcounts'
```

Because of the subsetting we also need to re-normalise the data. Here we just normalise using global scaling by the total counts per cell.

```python
adata.X = adata.layers["counts"].copy()
sc.pp.normalize_total(adata)
sc.pp.log1p(adata)
adata.layers["logcounts"] = adata.X.copy()
```

We will use this dataset to demonstrate integration.

Most integration methods require a single object containing all the samples and a batch variable (like we have here).
If instead, you have separate objects for each of your samples you can join them using the **anndata** `concat()` function.
See the [concatenation tutorial](https://anndata.readthedocs.io/en/stable/tutorials/concatenation.html) for more details.
Similar functionality exists in other ecosystems.

> **Integrating UMI and full-length data**
> 
> Integrating samples from UMI and full-length protocols can present additional challenges.
> This is because full-length protocols are affected by gene-length bias (longer genes are more highly expressed), whereas UMI data is not (Phipson *et al.*, 2017 [24]).
> Because of this, it is generally recommended to transform counts for full-length samples into a unit that corrects for gene-length (such as transcripts per million (TPM) (Wagner *et al.*, 2012 [25])) before attempting integration.
> This isn’t necessary, however, if all the samples being integrated used a full-length protocol.

> **Integrating tumor samples**
> 
> Non-malignant cells from different tumors usually cluster by cell type, whereas malignant cells form patient-specific clusters that largely reflect genuine biological differences (Tirosh *et al.*, 2016 [26]; Tirosh, 2026 [27]).
> Using the patient as the batch covariate therefore risks removing real tumor biology, because integration methods cannot fully separate technical from biological differences between tumors (Tirosh, 2026 [27]).
> A common strategy is to first separate malignant from non-malignant cells by inferring copy number alterations with tools such as **inferCNV** or **CopyKAT** (Tirosh *et al.*, 2016 [26]; Gao *et al.*, 2021 [28]), and then integrate only the non-malignant cells across patients.
> Malignant cells are often best analyzed one tumor at a time, and if they are integrated, key results should be checked by repeating the analysis without batch correction (Tirosh, 2026 [27]).

## Unintegrated data

It is always recommended to look at the raw data before performing any integration.
This can provide some indication of the magnitude of any batch effects and what might be causing them (and therefore which variables to consider as the batch label).
For some experiments, it might even suggest that integration is not required if samples already overlap.
This is not uncommon for mouse or cell line studies from a single lab, for example, where most of the variables that contribute to batch effects can be controlled (i.e., the batch correction setting).

We will perform highly variable gene (HVG) selection, PCA, and [UMAP](../glossary.md#term-uniform-manifold-approximation-and-projection-umap) dimensionality reduction as we have seen in previous chapters.

```python
sc.pp.highly_variable_genes(adata)
sc.tl.pca(adata)
sc.pp.neighbors(adata)
sc.tl.umap(adata)
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 10270 × 13431
    obs: 'GEX_pct_counts_mt', 'GEX_n_counts', 'GEX_n_genes', 'GEX_size_factors', 'GEX_phase', 'ATAC_nCount_peaks', 'ATAC_atac_fragments', 'ATAC_reads_in_peaks_frac', 'ATAC_blacklist_fraction', 'ATAC_nucleosome_signal', 'cell_type', 'batch', 'ATAC_pseudotime_order', 'GEX_pseudotime_order', 'Samplename', 'Site', 'DonorNumber', 'Modality', 'VendorLot', 'DonorID', 'DonorAge', 'DonorBMI', 'DonorBloodType', 'DonorRace', 'Ethnicity', 'DonorGender', 'QCMeds', 'DonorSmoker'
    var: 'feature_types', 'gene_id', 'n_cells', 'highly_variable', 'means', 'dispersions', 'dispersions_norm'
    uns: 'ATAC_gene_activity_var_names', 'dataset_id', 'genome', 'organism', 'log1p', 'hvg', 'pca', 'neighbors', 'umap'
    obsm: 'ATAC_gene_activity', 'ATAC_lsi_full', 'ATAC_lsi_red', 'ATAC_umap', 'GEX_X_pca', 'GEX_X_umap', 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts', 'logcounts'
    obsp: 'distances', 'connectivities'
```

This adds several new items to our AnnData object.
The `var` slot now includes means, dispersions and the selected variable genes.
In the `obsp` slot we have distances and connectivities for our KNN graph and in `obsm` are the PCA and UMAP embeddings.

Let’s plot the UMAP, colouring the points by cell identity and batch labels.
If the dataset had not already been labelled (which is often the case) we would only be able to consider the batch labels.

```python
adata.uns[batch_key + "_colors"] = [
    "#1b9e77",
    "#d95f02",
    "#7570b3",
]  # Set custom colours for batches
sc.pl.umap(adata, color=[label_key, batch_key], wspace=1)
```

Often, when examining these plots, you will notice a clear separation between batches.
In this case, what we see is more subtle, and while cells from the same label are generally near each other, there is a shift between batches.
If we were to perform a clustering analysis using this raw data, we would probably end up with some clusters containing a single batch, which would be difficult to interpret at the annotation stage.
We are also likely to overlook rare cell types that are not common enough in any single sample to produce their own cluster.
While UMAPs can often display batch effects, it is always important, when considering these 2D representations, not to overinterpret them.
For a real analysis, you should confirm the integration in other ways, such as by inspecting the distribution of marker genes.
In the “Benchmarking your own integration” section below, we discuss metrics for quantifying the quality of an integration.

Now that we have confirmed the presence of batch effects that need to be corrected, we can proceed to the various integration methods.
If the batches perfectly overlaid each other, or we could discover meaningful cell clusters without correction, then there would be no need to perform integration.

## Batch-aware feature selection

As shown in [previous chapters](../preprocessing-visualization/feature-selection.md), we often select a subset of genes to use for our analysis in order to reduce noise and processing time.
We follow the same approach when we have multiple samples; however, it is crucial that gene selection is performed in a batch-aware manner.
This is because genes that are variable across the whole dataset could be capturing batch effects rather than the biological signals we are interested in.
It also helps to select genes relevant to rare cell identities.

For example, if an identity is only present in one sample, then markers for it may not be variable across all samples, but should be present in that one sample.

We can perform batch-aware highly variable gene selection by setting the batch_key argument in the **scanpy** highly_variable_genes() function.
**scanpy** will then calculate HVGs for each batch separately and combine the results by selecting those genes that are highly variable in the highest number of batches.
We use the **scanpy** function here because it has built-in batch awareness.
For other methods, we would have to run them on each batch individually and then manually combine the results.

```python
sc.pp.highly_variable_genes(
    adata, n_top_genes=2000, flavor="cell_ranger", batch_key=batch_key
)
adata.var
```

We can see there are now some additional columns in `var`:

- `highly_variable_nbatches` - The number of batches where each gene was found to be highly variable
- `highly_variable_intersection` - Whether each gene was highly variable in every batch
- `highly_variable` - Whether each gene was selected as highly variable after combining the results from each batch

Let’s check how many batches each gene was variable in:

```python
n_batches = adata.var["highly_variable_nbatches"].value_counts()
ax = n_batches.plot(kind="bar")
n_batches
```

Output:
```text
highly_variable_nbatches
0    9931
1    1824
2     852
3     824
Name: count, dtype: int64
```

The first thing we notice is that most genes are not highly variable.
This is typically the case, but it can depend on how different the samples we are trying to integrate are.
The overlap then decreases as we add more samples, with relatively few genes being highly variable in all three batches.
By selecting the top 2000 genes, we have selected all HVGs that are present in two or three batches and most of those that are present in one batch.

> **How many genes to use?**
> 
> This is a question that doesn’t have a clear answer.
> The authors of the **scvi-tools** package which we use below recommend between 1000 and 10000 genes but how many depends on the context including the complexity of the dataset and the number of batches.
> A survey from a previous best practices paper (Luecken & Theis, 2019 [16]) indicated people typically use between 1000 and 6000 HVGs in a standard analysis. While selecting fewer genes can aid in the removal of batch effects (Luecken *et al.*, 2021 [2]) (the most highly-variable genes often describe only dominant biological variation), we recommend selecting slightly too many genes rather than selecting too few and risk removing genes that are important for a rare cell type or a pathway of interest.
> It should, however, be noted that more genes will also increase the time required to run the integration methods.

We will create an object with just the selected genes to use for integration.

```python
adata_hvg = adata[:, adata.var["highly_variable"]].copy()
adata_hvg
```

Output:
```text
AnnData object with n_obs × n_vars = 10270 × 2000
    obs: 'GEX_pct_counts_mt', 'GEX_n_counts', 'GEX_n_genes', 'GEX_size_factors', 'GEX_phase', 'ATAC_nCount_peaks', 'ATAC_atac_fragments', 'ATAC_reads_in_peaks_frac', 'ATAC_blacklist_fraction', 'ATAC_nucleosome_signal', 'cell_type', 'batch', 'ATAC_pseudotime_order', 'GEX_pseudotime_order', 'Samplename', 'Site', 'DonorNumber', 'Modality', 'VendorLot', 'DonorID', 'DonorAge', 'DonorBMI', 'DonorBloodType', 'DonorRace', 'Ethnicity', 'DonorGender', 'QCMeds', 'DonorSmoker'
    var: 'feature_types', 'gene_id', 'n_cells', 'highly_variable', 'means', 'dispersions', 'dispersions_norm', 'highly_variable_nbatches', 'highly_variable_intersection'
    uns: 'ATAC_gene_activity_var_names', 'dataset_id', 'genome', 'organism', 'log1p', 'hvg', 'pca', 'neighbors', 'umap', 'batch_colors', 'cell_type_colors'
    obsm: 'ATAC_gene_activity', 'ATAC_lsi_full', 'ATAC_lsi_red', 'ATAC_umap', 'GEX_X_pca', 'GEX_X_umap', 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts', 'logcounts'
    obsp: 'distances', 'connectivities'
```

## Variational autoencoder (VAE) based integration

The first integration method we will use is **scVI** (single-cell Variational Inference), a method based on a conditional variational autoencoder (Lopez *et al.*, 2018 [12]) available in the **scvi-tools** package (Gayoso *et al.*, 2022 [29]).
A [variational autoencoder](https://towardsdatascience.com/understanding-variational-autoencoders-vaes-f70510919f73) is a type of artificial neural network that attempts to reduce the dimensionality of a dataset.
The conditional part refers to conditioning this dimensionality reduction process on a particular covariate (in this case, batches) such that the covariate does not affect the low-dimensional representation.
In benchmarking studies **scVI** has been shown to perform well across a range of datasets with a good balance of batch correction while conserving biological variability (Luecken *et al.*, 2021 [2]).
**scVI** models raw counts directly, so it is important that we provide it with a count matrix rather than a normalized expression matrix.

First, let’s make a copy of our dataset to use for this integration.
Normally, it is not necessary to do this, but as we will demonstrate multiple integration methods, making a copy makes it easier to show what has been added by each method.

```python
adata_scvi = adata_hvg.copy()
```

### Data preparation

The first step in using **scVI** is to prepare our AnnData object.
This step stores some information required by **scVI** such as which expression matrix to use and what the batch key is.

```python
scvi.model.SCVI.setup_anndata(adata_scvi, layer="counts", batch_key=batch_key)
adata_scvi
```

Output:
```text
AnnData object with n_obs × n_vars = 10270 × 2000
    obs: 'GEX_pct_counts_mt', 'GEX_n_counts', 'GEX_n_genes', 'GEX_size_factors', 'GEX_phase', 'ATAC_nCount_peaks', 'ATAC_atac_fragments', 'ATAC_reads_in_peaks_frac', 'ATAC_blacklist_fraction', 'ATAC_nucleosome_signal', 'cell_type', 'batch', 'ATAC_pseudotime_order', 'GEX_pseudotime_order', 'Samplename', 'Site', 'DonorNumber', 'Modality', 'VendorLot', 'DonorID', 'DonorAge', 'DonorBMI', 'DonorBloodType', 'DonorRace', 'Ethnicity', 'DonorGender', 'QCMeds', 'DonorSmoker', '_scvi_batch', '_scvi_labels'
    var: 'feature_types', 'gene_id', 'n_cells', 'highly_variable', 'means', 'dispersions', 'dispersions_norm', 'highly_variable_nbatches', 'highly_variable_intersection'
    uns: 'ATAC_gene_activity_var_names', 'dataset_id', 'genome', 'organism', 'log1p', 'hvg', 'pca', 'neighbors', 'umap', 'batch_colors', 'cell_type_colors', '_scvi_uuid', '_scvi_manager_uuid'
    obsm: 'ATAC_gene_activity', 'ATAC_lsi_full', 'ATAC_lsi_red', 'ATAC_umap', 'GEX_X_pca', 'GEX_X_umap', 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts', 'logcounts'
    obsp: 'distances', 'connectivities'
```

The fields created by **scVI** are prefixed with `_scvi`.
These are designed for internal use and should not be manually modified.
The general advice from the **scvi-tools** authors is not to make any changes to our object until after the model is trained.
On other datasets, you may see a warning about the input expression matrix containing unnormalised count data.
This usually means you should check that the layer provided to the setup function does actually contain count values but it can also happen if you have values from performing gene length correction on data from a full-length protocol or from another quantification method that does not produce integer counts.

### Building the model

We can now construct an **scVI** model object.
As well as the **scVI** model we use here, the **scvi-tools** package contains various other models (we will use the **scANVI** model below).

```python
model_scvi = scvi.model.SCVI(adata_scvi)
model_scvi
```

The **scVI** model object contains the provided AnnData object as well as the neural network for the model itself.
You can see that currently the model is not trained.
If we wanted to modify the structure of the network, we could provide additional arguments to the model construction function, but here we just use the defaults.

We can also print a more detailed description of the model that shows us where things are stored in the associated AnnData object.

```python
model_scvi.view_anndata_setup()
```

Here we can see exactly what information has been assigned by **scVI**, including details like how each different batch is encoded in the model.

### Training the model

The model will be trained for a given number of *epochs*, a training iteration where every cell is passed through the network.
By default **scVI** uses the following heuristic to set the number of epochs.
For datasets with fewer than 20,000 cells, 400 epochs will be used, and as the number of cells grows above 20,000, the number of epochs is continuously reduced.
The reasoning behind this is that as the network sees more cells during each epoch, it can learn the same amount of information as it would from more epochs with fewer cells.

```python
max_epochs_scvi = np.min([round((20000 / adata.n_obs) * 400), 400])
print(max_epochs_scvi)
```

Output:
```text
400
```

We now train the model for the selected number of epochs (this will take ~20-40 minutes depending on the computer you are using).

```python
model_scvi.train()
```

Output:
```text
Epoch 400/400: 100%|██████████| 400/400 [27:37<00:00,  3.98s/it, v_num=1, train_loss=645]
Epoch 400/400: 100%|██████████| 400/400 [27:37<00:00,  4.14s/it, v_num=1, train_loss=645]
```

> **Early stopping**
> 
> In addition to setting a target number of epochs, it is also possible to set `early_stopping=True` in the training function.
> This will let **scVI** decide to stop training early depending on the convergence of the model.
> The exact conditions for stopping can be controlled by other parameters.

### Extracting the embedding

The main result we want to extract from the trained model is the latent representation for each cell.
This is a multi-dimensional embedding where the batch effects have been removed, which can be used in a similar way to how we use PCA dimensions when analysing a single dataset.
We store this in `obsm` with the key `X_scvi`.

```python
adata_scvi.obsm["X_scVI"] = model_scvi.get_latent_representation()
```

### Calculate a batch-corrected UMAP

We will now visualise the data as we did before integration.
We calculate a new UMAP embedding but instead of finding nearest neighbors in PCA space, we start with the corrected representation from **scVI**.

```python
sc.pp.neighbors(adata_scvi, use_rep="X_scVI")
sc.tl.umap(adata_scvi)
adata_scvi
```

Output:
```text
AnnData object with n_obs × n_vars = 10270 × 2000
    obs: 'GEX_pct_counts_mt', 'GEX_n_counts', 'GEX_n_genes', 'GEX_size_factors', 'GEX_phase', 'ATAC_nCount_peaks', 'ATAC_atac_fragments', 'ATAC_reads_in_peaks_frac', 'ATAC_blacklist_fraction', 'ATAC_nucleosome_signal', 'cell_type', 'batch', 'ATAC_pseudotime_order', 'GEX_pseudotime_order', 'Samplename', 'Site', 'DonorNumber', 'Modality', 'VendorLot', 'DonorID', 'DonorAge', 'DonorBMI', 'DonorBloodType', 'DonorRace', 'Ethnicity', 'DonorGender', 'QCMeds', 'DonorSmoker', '_scvi_batch', '_scvi_labels'
    var: 'feature_types', 'gene_id', 'n_cells', 'highly_variable', 'means', 'dispersions', 'dispersions_norm', 'highly_variable_nbatches', 'highly_variable_intersection'
    uns: 'ATAC_gene_activity_var_names', 'dataset_id', 'genome', 'organism', 'log1p', 'hvg', 'pca', 'neighbors', 'umap', 'batch_colors', 'cell_type_colors', '_scvi_uuid', '_scvi_manager_uuid'
    obsm: 'ATAC_gene_activity', 'ATAC_lsi_full', 'ATAC_lsi_red', 'ATAC_umap', 'GEX_X_pca', 'GEX_X_umap', 'X_pca', 'X_umap', 'X_scVI'
    varm: 'PCs'
    layers: 'counts', 'logcounts'
    obsp: 'distances', 'connectivities'
```

Once we have the new UMAP representation we can plot it colored by batch and identity labels as before.

```python
sc.pl.umap(adata_scvi, color=[label_key, batch_key], wspace=1)
```

This looks better!
Before, the various batches were shifted apart from each other.
Now, the batches overlap more, and we have a single blob for each cell identity label.

In many cases, we would not already have identity labels, so from this stage, we would continue with clustering, annotation, and further analysis as described in other chapters.

## VAE integration using cell labels

When performing integration with **scVI** we pretended that we didn’t already have any cell labels (although we showed them in plots).
While this scenario is common, there are some cases where we do know something about cell identity in advance.
Most often, this is when we want to combine one or more publicly available datasets with data from a new study.
When we have labels for at least some of the cells we can use **scANVI** (single-cell ANnotation using Variational Inference) (Xu *et al.*, 2021 [13]).
This is an extension of the **scVI** model that can incorporate cell identity label information as well as batch information.
Because it has this extra information, it can try to keep the differences between cell labels while removing batch effects.
Benchmarking suggests that **scANVI** tends to better preserve biological signals compared to **scVI** but sometimes it is not as effective at removing batch effects (Luecken *et al.*, 2021 [2]).
While we have labels for all cells here it is also possible to use **scANVI** in a semi-supervised manner where labels are only provided for some cells.

> **Label harmonization**
> 
> If you are using **scANVI** to integrate multiple datasets for which you already have labels it is important to first perform *label harmonization*.
> This refers to a process of checking that labels are consistent across the datasets that are being integrated.
> For example, a cell may be annotated as a “T cell” in one dataset, but a cell of the same type could have been given the label “CD8+ T cell” in another dataset.
> How best to harmonize labels is an open question, but it often requires input from subject-matter experts.

We start by creating a **scANVI** model object.
Note that because **scANVI** refines an already trained **scVI** model, we provide the scVI model rather than an AnnData object.
If we had not already trained an **scVI** model we would need to do that first.
We also provide a key for the column of `adata.obs` which contains our cell labels as well as the label which corresponds to unlabelled cells.
In this case, all of our cells are labelled, so we just provide a dummy value.
In most cases, it is important to check that this is set correctly so that **scANVI** knows which label to ignore during training.

```python
# Normally we would need to run scVI first but we have already done that here
# model_scvi = scvi.model.SCVI(adata_scvi) etc.
model_scanvi = scvi.model.SCANVI.from_scvi_model(
    model_scvi, labels_key=label_key, unlabeled_category="unlabelled"
)
print(model_scanvi)
model_scanvi.view_anndata_setup()
```

This **scANVI** model object is very similar to what we saw before for **scVI**.
As mentioned previously, we could modify the structure of the model network but here we just use the default parameters.

Again, we have a heuristic for selecting the number of training epochs.
Note that this is much fewer than before as we are just refining the **scVI** model, rather than training a whole network from scratch.

```python
max_epochs_scanvi = int(np.min([10, np.max([2, round(max_epochs_scvi / 3.0)])]))
model_scanvi.train(max_epochs=max_epochs_scanvi)
```

Output:
```text
INFO     Training for 10 epochs.                                                                                   
Epoch 10/10: 100%|██████████| 10/10 [01:06<00:00,  6.74s/it, v_num=1, train_loss=637]
Epoch 10/10: 100%|██████████| 10/10 [01:06<00:00,  6.61s/it, v_num=1, train_loss=637]
```

We can extract the new latent representation from the model and create a new UMAP embedding as we did for **scVI**.

```python
adata_scanvi = adata_scvi.copy()
adata_scanvi.obsm["X_scANVI"] = model_scanvi.get_latent_representation()
sc.pp.neighbors(adata_scanvi, use_rep="X_scANVI")
sc.tl.umap(adata_scanvi)
sc.pl.umap(adata_scanvi, color=[label_key, batch_key], wspace=1)
```

By looking at the UMAP representation it is difficult to tell the difference between **scANVI** and **scVI** but as we will see below there are differences in metric scores when the quality of the integrations is quantified.
This is a reminder that we shouldn’t overinterpret these two-dimensional representations, especially when comparing methods.

## Graph-based integration

The next method we will look at is **BBKNN** or “Batch Balanced KNN” (Polański *et al.*, 2019 [11]). This is a very different approach to **scVI**, which rather than using a neural network to embed cells in a batch corrected space, instead modifies how the *k*-nearest neighbor (KNN) graph used for clustering and embedding is constructed.
As we have seen in [previous chapters](../cellular-structure/clustering.md), the normal KNN procedure connects cells to the most similar cells across the whole dataset.
The change that **BBKNN** makes is to enforce that cells are connected to cells from other batches.
While this is a simple modification, it can be quite effective, particularly when there are very strong batch effects.
However, as the output is an integrated graph, it can have limited downstream uses, as few packages will accept this as an input.

An important parameter for **BBKNN** is the number of neighbors per batch.
A suggested heuristic for this is to use 25 if there are more than 100,000 cells or the default of 3 if there are fewer than 100,000.

```python
neighbors_within_batch = 25 if adata_hvg.n_obs > 100000 else 3
neighbors_within_batch
```

Output:
```text
3
```

Before using **BBKNN** we first perform a PCA as we would before building a normal KNN graph.
Unlike **scVI** which models raw counts here, we start with the log-normalised expression matrix.

```python
adata_bbknn = adata_hvg.copy()
adata_bbknn.X = adata_bbknn.layers["logcounts"].copy()
sc.pp.pca(adata_bbknn)
```

We can now run **BBKNN**, replacing the call to the **scanpy** `neighbors()` function in a standard workflow.
An important difference is to make sure the `batch_key` argument is set which specifies a column in `adata_hvg.obs` that contains batch labels.

```python
bbknn.bbknn(
    adata_bbknn, batch_key=batch_key, neighbors_within_batch=neighbors_within_batch
)
adata_bbknn
```

Output:
```text
AnnData object with n_obs × n_vars = 10270 × 2000
    obs: 'GEX_pct_counts_mt', 'GEX_n_counts', 'GEX_n_genes', 'GEX_size_factors', 'GEX_phase', 'ATAC_nCount_peaks', 'ATAC_atac_fragments', 'ATAC_reads_in_peaks_frac', 'ATAC_blacklist_fraction', 'ATAC_nucleosome_signal', 'cell_type', 'batch', 'ATAC_pseudotime_order', 'GEX_pseudotime_order', 'Samplename', 'Site', 'DonorNumber', 'Modality', 'VendorLot', 'DonorID', 'DonorAge', 'DonorBMI', 'DonorBloodType', 'DonorRace', 'Ethnicity', 'DonorGender', 'QCMeds', 'DonorSmoker'
    var: 'feature_types', 'gene_id', 'n_cells', 'highly_variable', 'means', 'dispersions', 'dispersions_norm', 'highly_variable_nbatches', 'highly_variable_intersection'
    uns: 'ATAC_gene_activity_var_names', 'dataset_id', 'genome', 'organism', 'log1p', 'hvg', 'pca', 'neighbors', 'umap', 'batch_colors', 'cell_type_colors'
    obsm: 'ATAC_gene_activity', 'ATAC_lsi_full', 'ATAC_lsi_red', 'ATAC_umap', 'GEX_X_pca', 'GEX_X_umap', 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts', 'logcounts'
    obsp: 'distances', 'connectivities'
```

Unlike the default **scanpy** function, **BBKNN** does not allow specifying a key for storing results so they are always stored under the default “neighbors” key.

We can use this new integrated graph just like we would use a normal KNN graph to construct a UMAP embedding.

```python
sc.tl.umap(adata_bbknn)
sc.pl.umap(adata_bbknn, color=[label_key, batch_key], wspace=1)
```

This integration is also improved compared to the unintegrated data, with cell identities grouped together, but we still see some shifts between batches.

## Linear embedding integration using Mutual Nearest Neighbors (MNN)

Some downstream applications cannot accept an integrated embedding or neighborhood graph and require a corrected expression matrix.
One approach that can produce this output is the integration method in **Seurat** (Satija *et al.*, 2015 [30]; Butler *et al.*, 2018 [7]; Stuart *et al.*, 2019 [8]).
The **Seurat** integration method belongs to a class of *linear embedding models* that make use of the idea of *mutual nearest neighbors* (which **Seurat** calls *anchors*) to correct batch effects (Haghverdi *et al.*, 2018 [6]).
Mutual nearest neighbors are pairs of cells from two different datasets that are in the neighborhood of each other when the datasets are placed in the same (latent) space.
After finding these cells, they can be used to align the two datasets and correct the differences between them.
**Seurat** has also been found to be one of the top mixing methods in some evaluations (Tran *et al.*, 2020 [18]).

As **Seurat** is an R package we must transfer our data from Python to R.
Here we prepare the AnnData to convert so that it can be handled by **rpy2** and **anndata2ri**.

```python
adata_seurat = adata_hvg.copy()
# Convert categorical columns to strings
adata_seurat.obs[batch_key] = adata_seurat.obs[batch_key].astype(str)
adata_seurat.obs[label_key] = adata_seurat.obs[label_key].astype(str)
# Delete uns as this can contain arbitrary objects which are difficult to convert
del adata_seurat.uns
adata_seurat
```

Output:
```text
AnnData object with n_obs × n_vars = 10270 × 2000
    obs: 'GEX_pct_counts_mt', 'GEX_n_counts', 'GEX_n_genes', 'GEX_size_factors', 'GEX_phase', 'ATAC_nCount_peaks', 'ATAC_atac_fragments', 'ATAC_reads_in_peaks_frac', 'ATAC_blacklist_fraction', 'ATAC_nucleosome_signal', 'cell_type', 'batch', 'ATAC_pseudotime_order', 'GEX_pseudotime_order', 'Samplename', 'Site', 'DonorNumber', 'Modality', 'VendorLot', 'DonorID', 'DonorAge', 'DonorBMI', 'DonorBloodType', 'DonorRace', 'Ethnicity', 'DonorGender', 'QCMeds', 'DonorSmoker'
    var: 'feature_types', 'gene_id', 'n_cells', 'highly_variable', 'means', 'dispersions', 'dispersions_norm', 'highly_variable_nbatches', 'highly_variable_intersection'
    obsm: 'ATAC_gene_activity', 'ATAC_lsi_full', 'ATAC_lsi_red', 'ATAC_umap', 'GEX_X_pca', 'GEX_X_umap', 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts', 'logcounts'
    obsp: 'distances', 'connectivities'
```

The prepared AnnData is now available in R as a SingleCellExperiment object thanks to **anndata2ri**.
Note that this is transposed compared to an AnnData object so our observations (cells) are now the columns and our variables (genes) are now the rows.

```python
%%R -i adata_seurat
adata_seurat
```

Output:
```text
class: SingleCellExperiment 
dim: 2000 10270 
metadata(0):
assays(3): X counts logcounts
rownames(2000): GPR153 TNFRSF25 ... TMLHE-AS1 MT-ND3
rowData names(9): feature_types gene_id ... highly_variable_nbatches
  highly_variable_intersection
colnames(10270): TCACCTGGTTAGGTTG-3-s1d3 CGTTAACAGGTGTCCA-3-s1d3 ...
  AGCAGGTAGGCTATGT-12-s3d7 GCCATGATCCCTTGCG-12-s3d7
colData names(28): GEX_pct_counts_mt GEX_n_counts ... QCMeds
  DonorSmoker
reducedDimNames(8): ATAC_gene_activity ATAC_lsi_full ... PCA UMAP
mainExpName: NULL
altExpNames(0):
```

**Seurat** uses its own object to store data.
Helpfully the authors provide a function to convert from SingleCellExperiment.
We just provide the SingleCellExperiment object and tell **Seurat** which assays (layers in our AnnData object) contain raw counts and normalised expression (which **Seurat** stores in a slot called “data”).

```python
%%R -i adata_seurat
seurat <- as.Seurat(adata_seurat, counts = "counts", data = "logcounts")
seurat
```

Output:
```text
An object of class Seurat 
2000 features across 10270 samples within 1 assay 
Active assay: originalexp (2000 features, 0 variable features)
 2 layers present: counts, data
 8 dimensional reductions calculated: ATAC_gene_activity, ATAC_lsi_full, ATAC_lsi_red, ATAC_umap, GEX_X_pca, GEX_X_umap, PCA, UMAP
In addition: Warning messages:
1: In asMethod(object) :
  sparse->dense coercion: allocating vector of size 1.5 GiB
2: Keys should be one or more alphanumeric characters followed by an underscore, setting key from ATAC_gene_activity_ to ATACgeneactivity_ 
3: Keys should be one or more alphanumeric characters followed by an underscore, setting key from ATAC_lsi_full_ to ATAClsifull_ 
4: Keys should be one or more alphanumeric characters followed by an underscore, setting key from ATAC_lsi_red_ to ATAClsired_ 
5: Keys should be one or more alphanumeric characters followed by an underscore, setting key from ATAC_umap_ to ATACumap_ 
6: Keys should be one or more alphanumeric characters followed by an underscore, setting key from GEX_X_pca_ to GEXXpca_ 
7: Keys should be one or more alphanumeric characters followed by an underscore, setting key from GEX_X_umap_ to GEXXumap_ 
```

Unlike some of the other methods, we have seen which take a single object and a batch key, the **Seurat** integration functions require a list of objects.
We create this using the `SplitObject()` function.

```python
%%R -i batch_key
batch_list <- SplitObject(seurat, split.by = batch_key)
batch_list
```

Output:
```text
$s1d3
An object of class Seurat 
2000 features across 4279 samples within 1 assay 
Active assay: originalexp (2000 features, 0 variable features)
 2 layers present: counts, data
 8 dimensional reductions calculated: ATAC_gene_activity, ATAC_lsi_full, ATAC_lsi_red, ATAC_umap, GEX_X_pca, GEX_X_umap, PCA, UMAP

$s2d1
An object of class Seurat 
2000 features across 4220 samples within 1 assay 
Active assay: originalexp (2000 features, 0 variable features)
 2 layers present: counts, data
 8 dimensional reductions calculated: ATAC_gene_activity, ATAC_lsi_full, ATAC_lsi_red, ATAC_umap, GEX_X_pca, GEX_X_umap, PCA, UMAP

$s3d7
An object of class Seurat 
2000 features across 1771 samples within 1 assay 
Active assay: originalexp (2000 features, 0 variable features)
 2 layers present: counts, data
 8 dimensional reductions calculated: ATAC_gene_activity, ATAC_lsi_full, ATAC_lsi_red, ATAC_umap, GEX_X_pca, GEX_X_umap, PCA, UMAP
```

We can now use this list to find anchors for each pair of datasets.
Usually, you would identify batch-aware highly variable genes first (using the `FindVariableFeatures()` and `SelectIntegrationFeatures()` functions) but as we have done that already we tell **Seurat** to use all the features in the object.

```python
%%R
anchors <- FindIntegrationAnchors(batch_list, anchor.features = rownames(seurat))
anchors
```

Output:
```text
  |                                                  | 0 % ~calculating  
  |+++++++++++++++++                                 | 33% ~02s           |++++++++++++++++++++++++++++++++++                | 67% ~01s           |++++++++++++++++++++++++++++++++++++++++++++++++++| 100% elapsed=02s  
  |                                                  | 0 % ~calculating   |+++++++++++++++++                                 | 33% ~02m 30s       |++++++++++++++++++++++++++++++++++                | 67% ~58s           |++++++++++++++++++++++++++++++++++++++++++++++++++| 100% elapsed=02m 46s
An AnchorSet object containing 25352 anchors between 3 Seurat objects 
 This can be used as input to IntegrateData.
Scaling features for provided objects
Finding all pairwise anchors
Running CCA
Merging objects
Finding neighborhoods
Finding anchors
	Found 7195 anchors
Filtering anchors
	Retained 5146 anchors
Running CCA
Merging objects
Finding neighborhoods
Finding anchors
	Found 4619 anchors
Filtering anchors
	Retained 3588 anchors
Running CCA
Merging objects
Finding neighborhoods
Finding anchors
... (3 more lines)
```

**Seurat** can then use the anchors to compute a transformation that maps one dataset onto another.
This is done in a pairwise way until all the datasets are merged.
By default **Seurat** will determine a merge order so that more similar datasets are merged together first but it is also possible to define this order.

```python
%%R
integrated <- IntegrateData(anchors)
integrated
```

Output:
```text
An object of class Seurat 
4000 features across 10270 samples within 2 assays 
Active assay: integrated (2000 features, 2000 variable features)
 1 layer present: data
 1 other assay present: originalexp
Merging dataset 3 into 2
Extracting anchors for merged samples
Finding integration vectors
Finding integration vector weights
0%   10   20   30   40   50   60   70   80   90   100%
[----|----|----|----|----|----|----|----|----|----|
**************************************************|
Integrating data
Warning: Layer counts isn't present in the assay object; returning NULL
Merging dataset 1 into 2 3
Extracting anchors for merged samples
Finding integration vectors
Finding integration vector weights
0%   10   20   30   40   50   60   70   80   90   100%
[----|----|----|----|----|----|----|----|----|----|
**************************************************|
Integrating data
Warning: Layer counts isn't present in the assay object; returning NULL
```

The result is another Seurat object, but notice now that the active assay is called “integrated”.
This contains the corrected expression matrix which is the final output of the integration.

Here we extract that matrix and prepare it for transfer back to Python.

```python
%%R -o integrated_expr
# Extract the integrated expression matrix
integrated_expr <- GetAssayData(integrated)
# Make sure the rows and columns are in the same order as the original object
integrated_expr <- integrated_expr[rownames(seurat), colnames(seurat)]
# Transpose the matrix to AnnData format
integrated_expr <- t(integrated_expr)
print(integrated_expr[1:10, 1:10])
```

Output:
```text
10 x 10 sparse Matrix of class "dgCMatrix"
                                                                               
TCACCTGGTTAGGTTG-3-s1d3  .            -0.0005365199  1.032812e-02 -2.653187e-02
CGTTAACAGGTGTCCA-3-s1d3  0.0001382038 -0.1809919666 -1.454901e-02  3.608087e-03
ATTCGTTTCAGTATTG-3-s1d3 -0.0121073019 -0.0634131448  .             2.144075e-02
GGACCGAAGTGAGGTA-3-s1d3  .             .             2.972292e-04  .           
ATGAAGCCAGGGAGCT-3-s1d3 -0.0139047070 -0.0313151266  .             2.239855e-02
AGTGCGGAGTAAGGGC-3-s1d3 -0.0004299227 -0.0002657828  .            -1.871410e-03
CTACCTCAGACACCGC-3-s1d3 -0.0055208619 -0.0398862165  7.182254e-06  8.240408e-03
CTTCAATTCACGAATC-3-s1d3  .            -0.0109928444  .             1.935677e-04
CCATTGTGTAGACAAA-3-s1d3  .             0.0171909577  .             5.711312e-05
CCGTTACTCAATGTGC-3-s1d3  0.0139905520  0.0007981117  2.303345e-03  1.356206e-02
                                                                          
TCACCTGGTTAGGTTG-3-s1d3 -0.023237586  0.031938501 -0.003196878  0.01777767
CGTTAACAGGTGTCCA-3-s1d3  0.114149769 -0.013183394  0.038076742  0.80491293
ATTCGTTTCAGTATTG-3-s1d3 -0.054419899  0.010955781 -0.005951631  0.37223307
GGACCGAAGTGAGGTA-3-s1d3  0.002305526  0.011544715  0.011133475  0.02366670
ATGAAGCCAGGGAGCT-3-s1d3 -0.123505735 -0.009382413  0.002153629 -0.07013587
AGTGCGGAGTAAGGGC-3-s1d3  0.035848769  0.013858992 -0.000379393  0.05617137
CTACCTCAGACACCGC-3-s1d3 -0.003837946  0.082027593 -0.001109389 -0.06307770
CTTCAATTCACGAATC-3-s1d3  0.052970709  0.153601548  0.247920321 -0.01143158
CCATTGTGTAGACAAA-3-s1d3 -0.015445186  0.025763467 -0.003632830  0.02040172
CCGTTACTCAATGTGC-3-s1d3 -0.018025403  0.022560138  0.005755798  0.61496229
                                                   
TCACCTGGTTAGGTTG-3-s1d3 -6.661644e-03 -0.0183198202
... (10 more lines)
```

We will now store the corrected expression matrix as a layer in our AnnData object.
We also set `adata.X` to use this matrix.

```python
adata_seurat.X = integrated_expr
adata_seurat.layers["seurat"] = integrated_expr
print(adata_seurat)
adata.X
```

Output:
```text
AnnData object with n_obs × n_vars = 10270 × 2000
    obs: 'GEX_pct_counts_mt', 'GEX_n_counts', 'GEX_n_genes', 'GEX_size_factors', 'GEX_phase', 'ATAC_nCount_peaks', 'ATAC_atac_fragments', 'ATAC_reads_in_peaks_frac', 'ATAC_blacklist_fraction', 'ATAC_nucleosome_signal', 'cell_type', 'batch', 'ATAC_pseudotime_order', 'GEX_pseudotime_order', 'Samplename', 'Site', 'DonorNumber', 'Modality', 'VendorLot', 'DonorID', 'DonorAge', 'DonorBMI', 'DonorBloodType', 'DonorRace', 'Ethnicity', 'DonorGender', 'QCMeds', 'DonorSmoker'
    var: 'feature_types', 'gene_id', 'n_cells', 'highly_variable', 'means', 'dispersions', 'dispersions_norm', 'highly_variable_nbatches', 'highly_variable_intersection'
    obsm: 'ATAC_gene_activity', 'ATAC_lsi_full', 'ATAC_lsi_red', 'ATAC_umap', 'GEX_X_pca', 'GEX_X_umap', 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts', 'logcounts', 'seurat'
    obsp: 'distances', 'connectivities'
<Compressed Sparse Row sparse matrix of dtype 'float32'
	with 14348115 stored elements and shape (10270, 13431)>
```

Now that we have the results of our integration we can calculate a UMAP and plot it as we have for the other methods (we could also have done this in R).

```python
# Reset the batch colours because we deleted them earlier
adata_seurat.uns[batch_key + "_colors"] = [
    "#1b9e77",
    "#d95f02",
    "#7570b3",
]
sc.tl.pca(adata_seurat)
sc.pp.neighbors(adata_seurat)
sc.tl.umap(adata_seurat)
sc.pl.umap(adata_seurat, color=[label_key, batch_key], wspace=1)
```

As we have previously seen, the batches are mixed while the labels are separated.
It is tempting to select an integration based on the UMAPs, but this does not fully represent the quality of an integration.
In the next section, we present some approaches to more rigorously evaluate integration methods.

> **A note on scalability**
> 
> As you ran the different integration methods you may have noticed that **scVI** took the most time.
> While this is true for small datasets like the example shown here, [benchmarks have shown](https://www.nature.com/articles/s41592-021-01336-8/figures/13) that **scVI** scales well for larger datasets.
> This is largely because the number of training epochs is adjusted for larger dataset sizes.
> MNN methods typically don’t scale as well, partly because they perform several pairwise integrations, so if you have 20 batches, you are performing 20 integrations, while other methods can consider all batches at once.

## Benchmarking your own integration

The methods demonstrated here are selected based on results from benchmarking experiments, including the [single-cell integration benchmarking project](https://theislab.github.io/scib-reproducibility/) (Luecken *et al.*, 2021 [2]).
This project also produced a software package called [**scib**](https://www.github.com/theislab/scib) that can be used to run a range of integration methods as well as the metrics that were used for evaluation.
In this section, we demonstrate how to utilize this package to assess the quality of an integration.

> **What is the ground truth?**
> 
> Some of these metrics, particularly those that evaluate the conservation of biological variation, require a known ground truth for comparison.
> Typically, this is a cell identity label, but it can also include other information, such as known trajectories.
> Because of this requirement, it is difficult to evaluate integration for a completely new dataset where it is unclear what biological signal should be preserved.

The **scib** metrics can be run individually but there are also wrappers for running multiple metrics at once.
Here we run a subset of the metrics, which are quick to compute using the `metrics_fast()` function.
This function takes a few arguments: the original unintegrated dataset, the integrated dataset, a batch key, and a label key.
Depending on the output of the integration method we might also need to supply additional arguments, for example here we specify the embedding to use for **scVI** and **scANVI** with the `embed` argument.
You can also control how some metrics are run with additional arguments.
Also note that you may need to check that objects are formatted properly so that **scIB** can find the required information.

Let’s run the metrics for each of the integrations we have performed above, as well as the unintegrated data (after highly variable gene selection).

```python
metrics_scvi = scib.metrics.metrics_fast(
    adata, adata_scvi, batch_key, label_key, embed="X_scVI"
)
metrics_scanvi = scib.metrics.metrics_fast(
    adata, adata_scanvi, batch_key, label_key, embed="X_scANVI"
)
metrics_bbknn = scib.metrics.metrics_fast(adata, adata_bbknn, batch_key, label_key)
metrics_seurat = scib.metrics.metrics_fast(adata, adata_seurat, batch_key, label_key)
metrics_hvg = scib.metrics.metrics_fast(adata, adata_hvg, batch_key, label_key)
```

Output:
```text
Silhouette score...
PC regression...
Isolated labels ASW...
Graph connectivity...
Silhouette score...
PC regression...
Isolated labels ASW...
Graph connectivity...
Silhouette score...
PC regression...
Isolated labels ASW...
Graph connectivity...
Silhouette score...
PC regression...
Isolated labels ASW...
Graph connectivity...
Silhouette score...
PC regression...
Isolated labels ASW...
Graph connectivity...
```

Here is an example of what one of the metrics results looks like for a single integration:

```python
metrics_hvg
```

Each row is a different metric, and the values show the score for that metric.
Scores are between 0 and 1, where 1 is a good performance and 0 is a poor performance (**scib** can also return unscaled scores for some metrics if required).
Because we have only run the fast metrics here, some of the metrics have `NaN` scores.
Also, note that some metrics cannot be used with some output formats, which can also be a reason for `NaN` values being returned.

To compare the methods, it is useful to have all the metric results in one table.
This code combines them and tidies them into a more convenient format.

```python
# Concatenate metrics results
metrics = pd.concat(
    [metrics_scvi, metrics_scanvi, metrics_bbknn, metrics_seurat, metrics_hvg],
    axis="columns",
)
# Set methods as column names
metrics = metrics.set_axis(
    ["scVI", "scANVI", "BBKNN", "Seurat", "Unintegrated"], axis="columns"
)
# Select only the fast metrics
metrics = metrics.loc[
    [
        "ASW_label",
        "ASW_label/batch",
        "PCR_batch",
        "isolated_label_silhouette",
        "graph_conn",
        "hvg_overlap",
    ],
    :,
]
# Transpose so that metrics are columns and methods are rows
metrics = metrics.T
# Remove the HVG overlap metric because it's not relevant to embedding outputs
metrics = metrics.drop(columns=["hvg_overlap"])
metrics
```

We now have all the scores in one table with metrics as columns and methods as rows.
Styling the table with a gradient can make it easier to see the differences between scores.

```python
metrics.style.background_gradient(cmap="Blues")
```

For some metrics, the scores tend to be in a relatively small range.
To emphasise the differences between methods and place each metric on the same scale, we scale them so that the worst performer gets a score of 0, the best performer gets a score of 1 and the others are somewhere in between.

```python
metrics_scaled = (metrics - metrics.min()) / (metrics.max() - metrics.min())
metrics_scaled.style.background_gradient(cmap="Blues")
```

The values now better represent the differences between methods (and better match the colour scale).
However, it is important to note that the scaled scores can only be used to compare the relative performance of this specific set of integrations.
If we wanted to add another method, we would need to perform the scaling again. We also can’t say that an integration is definitely “good”, only that it is better than the other methods we have tried.
This scaling emphasises differences between methods.
For example, if we had metric scores of 0.92, 0.94, and 0.96, these would be scaled to 0, 0.5, and 1.0.
This makes the first method appear to score much worse, even though it is only slightly lower than the other two and still got a very high score.
This effect is bigger when comparing a few methods and when they get similar raw scores.
Whether you look at raw or scaled scores depends on whether you want to focus on absolute performance or the difference in performance between methods.

The evaluation metrics can be grouped into two categories: those that measure the removal of batch effects and those that measure the conservation of biological variation.
We can calculate summary scores for each of these categories by taking the mean of the scaled values for each group.
This type of summary score wouldn’t make sense with raw values, as some metrics consistently produce higher scores than others (and therefore have a greater impact on the mean).

```python
metrics_scaled["Batch"] = metrics_scaled[
    ["ASW_label/batch", "PCR_batch", "graph_conn"]
].mean(axis=1)
metrics_scaled["Bio"] = metrics_scaled[["ASW_label", "isolated_label_silhouette"]].mean(
    axis=1
)
metrics_scaled.style.background_gradient(cmap="Blues")
```

Plotting the two summary scores against each other gives an indication of the priorities of each method.
Some will be biased towards batch correction while others will favour retaining biological variation.

```python
fig, ax = plt.subplots()
ax.set_xlim(0, 1)
ax.set_ylim(0, 1)
metrics_scaled.plot.scatter(
    x="Batch",
    y="Bio",
    c=range(len(metrics_scaled)),
    ax=ax,
)

for k, v in metrics_scaled[["Batch", "Bio"]].iterrows():
    ax.annotate(
        k,
        v,
        xytext=(6, -3),
        textcoords="offset points",
        family="sans-serif",
        fontsize=12,
    )
```

In our small example scenario **BBKNN** is clearly the worst performer, getting the lowest scores for both batch removal and biological conservation.
The other three methods have similar batch correction scores with **scANVI** scoring highest for biological conservation followed by **Seurat** and **scVI**.

To get an overall score for each method, we can combine the two summary scores.
The **scIB** paper suggests a weighting of 40% batch correction and 60% biological conservation but you may prefer to weight things differently depending on the priorities for your dataset.

```python
metrics_scaled["Overall"] = 0.4 * metrics_scaled["Batch"] + 0.6 * metrics_scaled["Bio"]
metrics_scaled.style.background_gradient(cmap="Blues")
```

Let’s make a quick bar chart to visualise the overall performance.

```python
metrics_scaled.plot.bar(y="Overall")
```

Output:
```text
<Axes: >
```

As we have already seen **scANVI** is the best performer followed by **scVI** and **Seurat**.
It is important to note that this is just an example of how to run these metrics for this specific dataset, not a proper evaluation of these methods.
For that, you should refer to existing benchmarking publications.
In particular, we have only run a small selection of high-performing methods and a subset of metrics.
Also, remember that scores are relative to the methods used, so even if the methods perform almost equally well, small differences will be exaggerated.

Existing benchmarks have suggested methods that generally perform well, but performance can also be quite variable across scenarios.
For some analyses, it may be worthwhile performing your own evaluation of integration.
The **scib** package makes this process easier, but it can still be a significant undertaking, relying on a good knowledge of the ground truth and interpretation of the metrics.

## Quiz

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q1",
        "What are the sources of batch effects?",
        "e.g. Differences in sample handling, experimental protocols, factors such as donor differences, tissue heterogeneity",
    )
    flip_card(
        "q2",
        "What is the difference between technical and biological variation?",
        "Technical variation refers to inconsistencies arising from the experimental process itself. In contrast, biological variation encompasses intrinsic differences between samples.",
        back_font_size=15,
    )
    flip_card(
        "q3",
        "How does one evaluate whether the integration worked well or not? What are useful metrics for this purpose?",
        "To evaluate integration effectiveness, visualization techniques like UMAP plots help assess whether cells from different batches mix well. Quantitative metrics include graph connectivity, batch entropy mixing, and silhouette scores. Combining these methods ensures that batch effects are minimized while preserving true biological signals.",
        back_font_size=13,
    )
```

## Session information

### Python

```python
import session_info

session_info.show()
```

### R

```python
%%R
sessioninfo::session_info()
```

Output:
```text
─ Session info ───────────────────────────────────────────────────────────────
 setting  value
 version  R version 4.4.3 (2025-02-28)
 os       macOS 26.2
 system   x86_64, darwin13.4.0
 ui       unknown
 language (EN)
 collate  C.UTF-8
 ctype    C.UTF-8
 tz       Europe/Berlin
 date     2026-02-16
 pandoc   3.8.3 @ /Users/seohyon/miniconda3/envs/integration/bin/pandoc
 quarto   NA

─ Packages ───────────────────────────────────────────────────────────────────
 package              * version date (UTC) lib source
 abind                  1.4-8   2024-09-12 [1] CRAN (R 4.4.3)
 Biobase              * 2.66.0  2024-10-29 [1] Bioconductor 3.20 (R 4.4.2)
 BiocGenerics         * 0.52.0  2024-10-29 [1] Bioconductor 3.20 (R 4.4.2)
 cli                    3.6.5   2025-04-23 [1] CRAN (R 4.4.3)
 cluster                2.1.8.1 2025-03-12 [1] CRAN (R 4.4.3)
 codetools              0.2-20  2024-03-31 [1] CRAN (R 4.4.3)
 cowplot                1.2.0   2025-07-07 [1] CRAN (R 4.4.3)
 crayon                 1.5.3   2024-06-20 [1] CRAN (R 4.4.3)
 data.table             1.17.8  2025-07-10 [1] CRAN (R 4.4.3)
... (114 more lines)
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Luke Zappia
- Malte Lücken
- Seo H. Kim

### Reviewers

- Lukas Heumos

## References

1. van den Brink, S. C., Sage, F., Vértesy, Á., Spanjaard, B., Peterson-Maduro, J., Baron, C. S., Robin, C., & van Oudenaarden, A. (2017). Single-cell sequencing reveals dissociation-induced gene expression in tissue subpopulations. *Nature Methods*, *14*(10), 935–936. https://doi.org/10.1038/nmeth.4437
2. Luecken, M. D., Büttner, M., Chaichoompu, K., Danese, A., Interlandi, M., Mueller, M. F., Strobl, D. C., Zappia, L., Dugas, M., Colomé-Tatché, M., & Theis, F. J. (2021). Benchmarking atlas-level data integration in single-cell genomics. *Nature Methods*. https://doi.org/10.1038/s41592-021-01336-8
3. Muus, C., Luecken, M. D., Eraslan, G., Sikkema, L., Waghray, A., Heimberg, G., Kobayashi, Y., Vaishnav, E. D., Subramanian, A., Smillie, C., Jagadeesh, K. A., Duong, E. T., Fiskin, E., Torlai Triglia, E., Ansari, M., Cai, P., Lin, B., Buchanan, J., Chen, S., … Human Cell Atlas Lung Biological Network. (2021). Single-cell meta-analysis of SARS-CoV-2 entry genes across tissues and demographics. *Nature Medicine*, *27*(3), 546–559. https://doi.org/10.1038/s41591-020-01227-z
4. Sikkema, L., Strobl, D. C., Zappia, L., Madissoon, E., Markov, N. S., Zaragosi, L.-E., Ansari, M., Arguel, M.-J., Apperloo, L., Becavin, C., Berg, M., Chichelnitskiy, E., Chung, M.-I., Collin, A., Gay, A. C. A., Kashani, B. H., Jain, M., Kapellos, T., Kole, T. M., … Theis, F. J. (2022). An integrated cell atlas of the human lung in health and disease. *bioRxiv*, 2022.03.10.483747. https://doi.org/10.1101/2022.03.10.483747
5. Johnson, W. E., Li, C., & Rabinovic, A. (2007). Adjusting batch effects in microarray expression data using empirical Bayes methods. *Biostatistics*, *8*(1), 118–127. https://doi.org/10.1093/biostatistics/kxj037
6. Haghverdi, L., Lun, A. T. L., Morgan, M. D., & Marioni, J. C. (2018). Batch effects in single-cell RNA-sequencing data are corrected by matching mutual nearest neighbors. *Nature Biotechnology*. https://doi.org/10.1038/nbt.4091
7. Butler, A., Hoffman, P., Smibert, P., Papalexi, E., & Satija, R. (2018). Integrating single-cell transcriptomic data across different conditions, technologies, and species. *Nature Biotechnology*. https://doi.org/10.1038/nbt.4096
8. Stuart, T., Butler, A., Hoffman, P., Hafemeister, C., Papalexi, E., Mauck, W. M., 3rd, Hao, Y., Stoeckius, M., Smibert, P., & Satija, R. (2019). Comprehensive Integration of Single-Cell Data. *Cell*, *177*(7), 1888-1902.e21. https://doi.org/10.1016/j.cell.2019.05.031
9. Hie, B., Bryson, B., & Berger, B. (2019). Efficient integration of heterogeneous single-cell transcriptomes using Scanorama. *Nature Biotechnology*. https://doi.org/10.1038/s41587-019-0113-3
10. Korsunsky, I., Millard, N., Fan, J., Slowikowski, K., Zhang, F., Wei, K., Baglaenko, Y., Brenner, M., Loh, P.-R., & Raychaudhuri, S. (2019). Fast, sensitive and accurate integration of single-cell data with Harmony. *Nature Methods*. https://doi.org/10.1038/s41592-019-0619-0
11. Polański, K., Park, J.-E., Young, M. D., Miao, Z., Meyer, K. B., & Teichmann, S. A. (2019). BBKNN: Fast Batch Alignment of Single Cell Transcriptomes. *Bioinformatics*. https://doi.org/10.1093/bioinformatics/btz625
12. Lopez, R., Regier, J., Cole, M. B., Jordan, M. I., & Yosef, N. (2018). Deep generative modeling for single-cell transcriptomics. *Nature Methods*, *15*(12), 1053–1058. https://doi.org/10.1038/s41592-018-0229-2
13. Xu, C., Lopez, R., Mehlman, E., Regier, J., Jordan, M. I., & Yosef, N. (2021). Probabilistic harmonization and annotation of single-cell transcriptomics data with deep generative models. *Molecular Systems Biology*, *17*(1), e9620. https://doi.org/10.15252/msb.20209620
14. Lotfollahi, M., Wolf, F. A., & Theis, F. J. (2019). scGen predicts single-cell perturbation responses. *Nature Methods*, *16*(8), 715–721. https://doi.org/10.1038/s41592-019-0494-8
15. Argelaguet, R., Cuomo, A. S. E., Stegle, O., & Marioni, J. C. (2021). Computational principles and challenges in single-cell data integration. *Nature Biotechnology*, 1–14. https://doi.org/10.1038/s41587-021-00895-7
16. Luecken, M. D., & Theis, F. J. (2019). Current best practices in single‐cell RNA‐seq analysis: a tutorial. *Molecular Systems Biology*, *15*(6). https://doi.org/10.15252/msb.20188746
17. Büttner, M., Miao, Z., Wolf, F. A., Teichmann, S. A., & Theis, F. J. (2019). A test metric for assessing single-cell RNA-seq batch correction. *Nature Methods*, *16*(1), 43–49. https://doi.org/10.1038/s41592-018-0254-1
18. Tran, H. T. N., Ang, K. S., Chevrier, M., Zhang, X., Lee, N. Y. S., Goh, M., & Chen, J. (2020). A benchmark of batch-effect correction methods for single-cell RNA sequencing data. *Genome Biology*, *21*(1), 12. https://doi.org/10.1186/s13059-019-1850-9
19. Chazarra-Gil, R., van Dongen, S., Kiselev, V. Y., & Hemberg, M. (2021). Flexible comparison of batch correction methods for single-cell RNA-seq using BatchBench. *Nucleic Acids Research*, *49*(7), e42. https://doi.org/10.1093/nar/gkab004
20. Swamy, V. S., Fufa, T. D., Hufnagel, R. B., & McGaughey, D. M. (2021). Building the mega single-cell transcriptome ocular meta-atlas. *GigaScience*, *10*(10). https://doi.org/10.1093/gigascience/giab061
21. Luecken, M. D., Gigante, S., Burkhardt, D. B., Cannoodt, R., Strobl, D. C., Markov, N. S., Zappia, L., Palla, G., Lewis, W., Dimitrov, D., Vinyard, M. E., Magruder, D. S., Mueller, M. F., Andersson, A., Dann, E., Qin, Q., Otto, D. J., Klein, M., Botvinnik, O. B., … Krishnaswamy, S. (2025). Defining and Benchmarking Open Problems in Single-Cell Analysis. *Nature Biotechnology*, *43*(7), 1035–1040. https://doi.org/10.1038/s41587-025-02694-w
22. Luecken, M. D., Burkhardt, D. B., Cannoodt, R., Lance, C., Agrawal, A., Aliee, H., Chen, A. T., Deconinck, L., Detweiler, A. M., Granados, A. A., Huynh, S., Isacco, L., Kim, Y. J., Klein, D., de Kumar, B., Kuppasani, S., Lickert, H., McGeever, A., Mekonen, H., … Bloom, J. M. (2022, January). A sandbox for prediction and integration of DNA, RNA, and proteins in single cells. *Thirty-Fifth Conference on Neural Information Processing Systems Datasets and Benchmarks Track (Round 2)*.
23. Lance, C., Luecken, M. D., Burkhardt, D. B., Cannoodt, R., Rautenstrauch, P., Laddach, A., Ubingazhibov, A., Cao, Z.-J., Deng, K., Khan, S., Liu, Q., Russkikh, N., Ryazantsev, G., Ohler, U., Data integration competition participants, N. 2021 M., Pisco, A. O., Bloom, J., Krishnaswamy, S., & Theis, F. J. (2022). Multimodal single cell data integration challenge: Results and lessons learned. In D. Kiela, M. Ciccone, & B. Caputo (Eds.), *Proceedings of the NeurIPS 2021 Competitions and Demonstrations Track* (Vol. 176, pp. 162–176). PMLR.
24. Phipson, B., Zappia, L., & Oshlack, A. (2017). Gene length and detection bias in single cell RNA sequencing protocols. *F1000Research*, *6*. https://doi.org/10.12688/f1000research.11290.1
25. Wagner, G. P., Kin, K., & Lynch, V. J. (2012). Measurement of mRNA abundance using RNA-seq data: RPKM measure is inconsistent among samples. *Theory in Biosciences*, *131*(4), 281–285. https://doi.org/10.1007/s12064-012-0162-3
26. Tirosh, I., Izar, B., Prakadan, S. M., Wadsworth, M. H., Treacy, D., Trombetta, J. J., Rotem, A., Rodman, C., Lian, C., Murphy, G., Fallahi-Sichani, M., Dutton-Regester, K., Lin, J.-R., Cohen, O., Shah, P., Lu, D., Genshaft, A. S., Hughes, T. K., Ziegler, C. G. K., … Garraway, L. A. (2016). Dissecting the multicellular ecosystem of metastatic melanoma by single-cell RNA-seq. *Science*, *352*(6282), 189–196. https://doi.org/10.1126/science.aad0501
27. Tirosh, I. (2026). Pitfalls in analysis and interpretation of single-cell RNA-seq data in cancer. *Neuro-Oncology Advances*, *8*(Supplement_1), i57–i60. https://doi.org/10.1093/noajnl/vdaf047
28. Gao, R., Bai, S., Henderson, Y. C., Lin, Y., Schalck, A., Yan, Y., Kumar, T., Hu, M., Sei, E., Davis, A., Wang, F., Shaitelman, S. F., Wang, J. R., Chen, K., Moulder, S., Lai, S. Y., & Navin, N. E. (2021). Delineating copy number and clonal substructure in human tumors from single-cell transcriptomes. *Nature Biotechnology*, *39*(5), 599–608. https://doi.org/10.1038/s41587-020-00795-2
29. Gayoso, A., Lopez, R., Xing, G., Boyeau, P., Valiollah Pour Amiri, V., Hong, J., Wu, K., Jayasuriya, M., Mehlman, E., Langevin, M., Liu, Y., Samaran, J., Misrachi, G., Nazaret, A., Clivio, O., Xu, C., Ashuach, T., Gabitto, M., Lotfollahi, M., … Yosef, N. (2022). A Python library for probabilistic analysis of single-cell omics data. *Nature Biotechnology*. https://doi.org/10.1038/s41587-021-01206-w
30. Satija, R., Farrell, J. A., Gennert, D., Schier, A. F., & Regev, A. (2015). Spatial reconstruction of single-cell gene expression data. *Nature Biotechnology*, *33*(5), 495–502. https://doi.org/10.1038/nbt.3192
