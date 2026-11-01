# Dimensionality Reduction

Source: https://www.sc-best-practices.org/preprocessing-visualization/dimensionality-reduction  
Authors: Anna Schaar, Seo H. Kim, Lukas Heumos

**🧠 Key takeaways**

- PCA is a linear dimensionality reduction technique that creates uncorrelated principal components ranked by variance, making it interpretable and efficient but less suitable for visualizing highly non-linear scRNA-seq data.
- UMAP is a non-linear method that constructs and optimizes graph representations to preserve the local data structure, making it highly effective for visualization and clustering of single-cell data.
- Cluster sizes and distances between clusters in t-SNE and UMAP plots carry little meaning, and their arrangement changes with the initialization.

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

scRNA-seq is a high-throughput [sequencing](../glossary.md#term-sequencing) technology that produces datasets with high dimensions in the number of cells and genes.
Therefore, scRNA-seq data suffers from the ‘curse of dimensionality’.

> **Curse of dimensionality**
> 
> The Curse of dimensionality was first brought up by R. Bellman (Bellman *et al.*, 1957 [1]) and describes that, in theory, [high-dimensional data](../glossary.md#term-high-dimensional-data) contains more information, but in practice this is not the case.
> Higher-dimensional data often contains more noise and redundancy, and therefore, adding more information does not provide benefits for downstream analysis steps.

Not all genes are informative and therefore not all genes are essential for tasks such as clustering.
We already aimed to reduce the dimensionality of the data with feature selection.
As a next step, we will further reduce the dimensions of single-cell RNA-seq data with dimensionality reduction algorithms.
These algorithms are an important step during preprocessing to reduce the data complexity and for visualization.

![Dimensionality reduction](https://www.sc-best-practices.org/build/dimensionality_reduc-4d4d298968d5a7202a6bbad2d33811b6.jpeg)

*Figure 1: Dimensionality reduction embeds the high-dimensional data into a lower-dimensional space.
The low-dimensional representation still captures the underlying structure of the data while having as few dimensions as possible.
Here we visualize a three-dimensional object projected into two dimensions.*

Xing et al. compared in an independent comparison the stability, accuracy, and computing cost of 10 different dimensionality reduction methods (Xiang *et al.*, 2021 [2]).
They propose to use [t-distributed stochastic neighbor embedding (t-SNE)](../glossary.md#term-t-distributed-stochastic-neighbor-embedding-t-sne) as it yielded the best overall performance.
[Uniform manifold approximation and projection (UMAP)](../glossary.md#term-uniform-manifold-approximation-and-projection-umap) showed the highest stability and separated the original cell populations best.
An additional dimensionality reduction worth mentioning in this context is principal component analysis (PCA), which is still widely used.

Generally, t-SNE and UMAP are very robust and mostly equivalent if specific choices for the initialization are selected (Kobak & Linderman, 2021 [3]).

All aforementioned methods are implemented in scanpy.

Now we start with importing all required Python packages and load the dataset after [quality control](../preprocessing-visualization/quality-control.md), [normalization](../preprocessing-visualization/normalization.md), and [feature selection](../preprocessing-visualization/feature-selection.md).

> **Running this on a GPU**
> 
> PCA, t-SNE, UMAP, and the neighbor graph are among the steps that benefit most from GPU acceleration.
> On large datasets, [rapids-singlecell](../introduction/rapids-singlecell.md) drops their runtime by 1–2 orders of magnitude with a near-identical API.

```python
import anndata as ad
import lamindb as ln
import matplotlib.pyplot as plt
import pandas as pd
import scanpy as sc

# Suppress verbose logging from Scanpy
sc.settings.verbosity = 0

# Set figure parameters for clean, minimal plots
sc.set_figure_params(dpi=80, facecolor="white", frameon=False)

ln.connect("theislab/sc-best-practices")

ln.track("liGMVGre4G5H")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ loaded Transform('liGMVGre4G5H0008', key='dimensionality_reduction.ipynb'), started new Run('jAZqcc9RSdWRu2Jq') at 2026-09-29 11:59:14 UTC
→ notebook imports: anndata==0.13.2 lamindb-core==2.10.0 matplotlib==3.11.2 pandas==3.0.6 scanpy==1.12.4
• tip: to identify the notebook across renames, pass the uid: ln.track("liGMVGre4G5H")
```

```python
af = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="preprocessing_visualization/s4d8_feature_selection.h5ad", is_latest=True
)
adata = af.load()
```

We will use a normalized representation of the dataset for dimensionality reduction and visualization, specifically the shifted logarithm.

> **Why should you use normalized data for dimensionality reduction?**
> 
> First, gene expression data is typically heavily right-skewed with many zeros and a few highly expressed genes.
> Log transformation helps normalize this distribution, making it more symmetric and reducing the impact of extreme values.
> This prevents highly expressed genes from dominating any distance calculations.
> 
> Second, biological signals in expression data often follow multiplicative rather than additive patterns.
> Log transformation converts multiplicative relationships to additive ones, which most dimensionality reduction algorithms (PCA, t-SNE, UMAP) are designed to detect.
> 
> Third, variance in raw expression data typically scales with mean expression levels.
> Log transformation stabilizes this variance, preventing highly expressed genes from dominating the analysis.
> For zero values (dropout events common in single-cell data), a pseudocount is typically added before log transformation (log1p) to avoid mathematical errors.

```python
adata.X = adata.layers["scran_normalization"]
```

We start with:

## PCA

In our dataset, each cell is a vector of a `n_var`-dimensional vector space spanned by some orthonormal basis.
As scRNA-seq suffers from the ‘curse of dimensionality’, we know that not all features are important to understand the underlying dynamics of the dataset and that there is an inherent redundancy(Grün *et al.*, 2014 [4]).
PCA creates a new set of uncorrelated variables, so-called principal components (PCs), via an orthogonal transformation of the original dataset.
The PCs are linear combinations of features in the original dataset and are ranked in decreasing order of variance to define the transformation.
In the ranking, the first PC typically captures the greatest amount of variance.
PCs with the lowest variance are discarded to effectively reduce the dimensionality of the data without losing information.

PCA offers the advantage that it is highly interpretable and computationally efficient.
However, as scRNA-seq datasets are rather sparse due to dropout events and therefore highly non-linear, visualization with the linear dimensionality reduction technique PCA is not very appropriate.
PCA is typically used to select the top 10-50 PCs, which are used for downstream analysis tasks.

> **Should you scale genes before PCA?**
> 
> Many tutorials z-score every gene to zero mean and unit variance before running PCA, and we deliberately do not.
> Scaling weights all genes equally in the components that follow, so a lowly expressed gene can contribute as much variance as a strongly expressed one.
> Refraining from it keeps the magnitude of expression as a proxy for how informative a gene is.
> 
> There is no consensus on which of the two is correct.
> The choice comes down to whether all genes should count equally for downstream analysis, or whether the magnitude of expression is itself informative, and we opt for the latter to retain as much biological signal as possible.
> Selecting highly deviant genes beforehand already restricts the components to genes that vary meaningfully across cells.
> 
> This is separate from centering.
> `sc.pp.pca` centers the data internally, so PCA is well defined without a preceding scaling step.

```python
# setting highly variable as highly deviant to use scanpy 'use_highly_variable' argument in sc.pp.pca
adata.var["highly_variable"] = adata.var["highly_deviant"]
sc.pp.pca(adata, svd_solver="arpack", mask_var="highly_variable")
```

```python
sc.pl.pca(adata, color="total_counts")
```

> **How to understand a PCA scatter plot**
> 
> PCA looks for the directions in the data where the values of the cells (or samples) differ the most.
> 
> 1. Axes: PC1 and PC2 are the first and second principal components(directions).
>    PC1 is the direction where the data is most spread out, and PC2 is the next most variable direction, perpendicular to PC1.
> 2. Points: Each point is a single cell.
>    The color of each point represents the total number of transcripts ([UMIs](../glossary.md#term-unique-molecular-identifier-umi)) detected in that cell.
> 
> By projecting the data onto PC1 and PC2, we capture most of the meaningful variation in fewer dimensions.
> 
> Although we do not aim to interpret biological meaning directly from this PCA plot at this stage, we can observe cellular heterogeneity: cells with similar expression profiles tend to cluster together, which may reflect different cell types or states.

## t-SNE

t-SNE is a graph based, non-linear dimensionality reduction technique which projects the high dimensional data onto 2D or 3D components.
The method defines a Gaussian probability distribution based on the high-dimensional Euclidean distances between data points.
Subsequently, a Student t-distribution is used to recreate the probability distribution in a low dimensional space where the embeddings are optimized using gradient descent.

```python
sc.tl.tsne(adata, use_rep="X_pca")
```

```python
sc.pl.tsne(adata, color="total_counts")
```

> **How to understand t-SNE plot**
> 
> 1. Axes have no meaning!
> 2. Points: Each point represents a single cell.
>    Color represents the total number of transcripts ([UMIs](../glossary.md#term-unique-molecular-identifier-umi)) detected in that cell.
> 
> This plot helps reveal cellular subpopulations: tight clusters may correspond to distinct cell types or states.
> Unlike PCA, which preserves global variance, t-SNE emphasizes local structure.
> For this reason, it is best practice to initialize t-SNE from PCA to reduce noise and improve stability of the embedding.

## UMAP

UMAP is a graph-based, non-linear dimensionality reduction technique and is principally similar to t-SNE.
It constructs a high-dimensional graph representation of the dataset and optimizes the low-dimensional graph representation to be as structurally similar as possible to the original graph.

We first calculate PCA and subsequently create a neighborhood graph based on our data.

```python
sc.pp.neighbors(adata)
sc.tl.umap(adata)
```

```python
sc.pl.umap(adata, color="total_counts")
```

> **How to understand a UMAP plot**
> 
> 1. Axes have no meaning!
> 2. Points: Each point represents a single cell.  
>    Color indicates the total number of transcripts ([UMIs](../glossary.md#term-unique-molecular-identifier-umi)) detected in that cell.
> 
> Like t-SNE, UMAP emphasizes local structure, and the arrangement of its clusters depends on the initialization, as we will see below.
> It constructs a neighborhood graph based on PCA-reduced data, then optimizes a low-dimensional layout that reflects relationships in the original high-dimensional space.
> UMAP is widely used for visualizing cell clusters and trajectories in single-cell data.

**Interpreting t-SNE and UMAP**

t-SNE and UMAP preserve which cells are neighbors, not the distances between cells that are far apart, so cluster sizes and distances between clusters carry little meaning (Kobak & Berens, 2019 [5]; Chari & Pachter, 2023 [6]).
Where clusters end up relative to each other also depends on the initialization, and with the informative initializations scanpy uses, a spectral embedding for UMAP and PCA for t-SNE, the two methods arrange the data similarly, although UMAP keeps fewer exact neighbors because of its stronger attraction between neighbors (Kobak & Linderman, 2021 [3]; Böhm *et al.*, 2022 [7]).
To see the effect of the initialization, we also compute UMAP from a random starting point.

```python
sc.tl.umap(adata, init_pos="random", key_added="X_umap_random")
```

We color both embeddings by the coarse Leiden clusters that we computed for SoupX during [quality control](../preprocessing-visualization/quality-control.md).

```python
initializations = {
    "X_umap": "UMAP, spectral initialization",
    "X_umap_random": "UMAP, random initialization",
}

fig, axes = plt.subplots(1, 2, figsize=(10, 5))
for ax, (basis, title) in zip(axes, initializations.items(), strict=True):
    sc.pl.embedding(
        adata,
        basis=basis,
        color="soupx_groups",
        title=title,
        legend_loc="on data",
        ax=ax,
        show=False,
    )
plt.show()
```

Which clusters end up next to each other changes with the initialization, so neighboring clusters in an embedding are no evidence that the populations are related.
To quantify how much of the local structure survives, we compute the neighborhood graph of every embedding and the fraction of the neighbors of every cell in the 50 principal components that it keeps, using the first two principal components as a linear reference.

```python
embeddings = ad.AnnData(
    obsm={
        key: adata.obsm[key] for key in ["X_pca", "X_tsne", "X_umap", "X_umap_random"]
    }
)
reference = adata.obsp["distances"] > 0

preservation = {}
for title, kwargs in {
    "PCA, first two components": {"use_rep": "X_pca", "n_pcs": 2},
    "t-SNE, PCA initialization": {"use_rep": "X_tsne"},
    "UMAP, spectral initialization": {"use_rep": "X_umap"},
    "UMAP, random initialization": {"use_rep": "X_umap_random"},
}.items():
    sc.pp.neighbors(embeddings, **kwargs)
    neighbors = embeddings.obsp["distances"] > 0
    preservation[title] = neighbors.multiply(reference).sum() / reference.sum()
pd.Series(preservation, name="neighbor preservation").round(2)
```

Output:
```text
PCA, first two components        0.03
t-SNE, PCA initialization        0.25
UMAP, spectral initialization    0.11
UMAP, random initialization      0.11
Name: neighbor preservation, dtype: float64
```

No two-dimensional embedding keeps the neighborhoods of the data: t-SNE keeps a quarter of the nearest neighbors of every cell, UMAP a tenth and the first two principal components almost none.
The initialization rearranges the clusters of UMAP but not the neighborhoods, so any structure an embedding suggests, such as a cluster splitting off or two populations lying close together, should be checked in the high-dimensional data, for example with clustering and marker genes.

```python
sc.tl.umap(adata, init_pos="random", key_added="X_umap_random")
```

```python
initializations = {
    "X_umap": "UMAP, spectral initialization",
    "X_umap_random": "UMAP, random initialization",
}

fig, axes = plt.subplots(1, 2, figsize=(10, 5))
for ax, (basis, title) in zip(axes, initializations.items(), strict=True):
    sc.pl.embedding(
        adata,
        basis=basis,
        color="soupx_groups",
        title=title,
        legend_loc="on data",
        ax=ax,
        show=False,
    )
plt.show()
```

```python
embeddings = ad.AnnData(
    obsm={
        key: adata.obsm[key] for key in ["X_pca", "X_tsne", "X_umap", "X_umap_random"]
    }
)
reference = adata.obsp["distances"] > 0

preservation = {}
for title, kwargs in {
    "PCA, first two components": {"use_rep": "X_pca", "n_pcs": 2},
    "t-SNE, PCA initialization": {"use_rep": "X_tsne"},
    "UMAP, spectral initialization": {"use_rep": "X_umap"},
    "UMAP, random initialization": {"use_rep": "X_umap_random"},
}.items():
    sc.pp.neighbors(embeddings, **kwargs)
    neighbors = embeddings.obsp["distances"] > 0
    preservation[title] = neighbors.multiply(reference).sum() / reference.sum()
pd.Series(preservation, name="neighbor preservation").round(2)
```

Output:
```text
PCA, first two components        0.03
t-SNE, PCA initialization        0.25
UMAP, spectral initialization    0.11
UMAP, random initialization      0.11
Name: neighbor preservation, dtype: float64
```

## Inspecting quality control metrics

We can now also inspect the quality control metrics we calculated previously in our PCA, TSNE or UMAP plot and potentially identify low-quality cells.

```python
sc.pl.umap(
    adata,
    color=["total_counts", "pct_counts_mt", "scDblFinder_score", "scDblFinder_class"],
)
```

Cells with a high doublet score are projected to the same region in the UMAP.
We will keep them in the dataset for now but generally this suggests to potentially re-visit the quality control strategy again to ensure that as few doublets as possible are retained.

```python
af = ln.Artifact.from_anndata(
    adata,
    key="preprocessing_visualization/s4d8_dimensionality_reduction.h5ad",
    description="anndata after dimensionality reduction",
).save()
af
```

Output:
```text
→ creating new artifact version for key 'preprocessing_visualization/s4d8_dimensionality_reduction.h5ad' in storage 's3://lamin-eu-central-1/VPwcjx3CDAa2'

... uploading 6MXF3Uy8DkG9wy720009.h5ad:  0.0%

... uploading 6MXF3Uy8DkG9wy720009.h5ad:  1.1%

... uploading 6MXF3Uy8DkG9wy720009.h5ad:  2.1%

... uploading 6MXF3Uy8DkG9wy720009.h5ad:  3.2%

... uploading 6MXF3Uy8DkG9wy720009.h5ad:  4.3%

... uploading 6MXF3Uy8DkG9wy720009.h5ad:  7.5%

... uploading 6MXF3Uy8DkG9wy720009.h5ad: 10.7%

... uploading 6MXF3Uy8DkG9wy720009.h5ad: 11.8%

... uploading 6MXF3Uy8DkG9wy720009.h5ad: 18.2%

... uploading 6MXF3Uy8DkG9wy720009.h5ad: 22.4%

... uploading 6MXF3Uy8DkG9wy720009.h5ad: 26.7%

... uploading 6MXF3Uy8DkG9wy720009.h5ad: 33.1%
... (39 more lines)
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Anna Schaar
- Seo H. Kim

### Reviewers

- Lukas Heumos

## References

1. Bellman, R., Bellman, R. E., & Corporation, R. (1957). *Dynamic Programming*. Princeton University Press. https://books.google.de/books?id=rZW4ugAACAAJ
2. Xiang, R., Wang, W., Yang, L., Wang, S., Xu, C., & Chen, X. (2021). A Comparison for Dimensionality Reduction Methods of Single-Cell RNA-seq Data. *Frontiers in Genetics*, *12*. https://doi.org/10.3389/fgene.2021.646936
3. Kobak, D., & Linderman, G. C. (2021). Initialization is critical for preserving global data structure in both t-SNE and UMAP. *Nature Biotechnology*, *39*(2), 156–157. https://doi.org/10.1038/s41587-020-00809-z
4. Grün, D., Kester, L., & Van Oudenaarden, A. (2014). Validation of noise models for single-cell transcriptomics. *Nature Methods*, *11*(6), 637–640.
5. Kobak, D., & Berens, P. (2019). The art of using t-SNE for single-cell transcriptomics. *Nature Communications*, *10*(1), 5416. https://doi.org/10.1038/s41467-019-13056-x
6. Chari, T., & Pachter, L. (2023). The specious art of single-cell genomics. *PLOS Computational Biology*, *19*(8), e1011288. https://doi.org/10.1371/journal.pcbi.1011288
7. Böhm, J. N., Berens, P., & Kobak, D. (2022). Attraction-Repulsion Spectrum in Neighbor Embeddings. *Journal of Machine Learning Research*, *23*(95), 1–32.
