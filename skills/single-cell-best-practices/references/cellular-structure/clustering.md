# Clustering

Source: https://www.sc-best-practices.org/cellular-structure/clustering  
Authors: Anna Schaar, Seo H. Kim, Lukas Heumos

**🧠 Key takeaways**

- Use Leiden community detection on a single-cell KNN graph.
- Sub-clustering with different resolution parameters allows the user to focus on more detailed substructures in the dataset to potentially identify finer cell states.

**⚙️ Environment setup**

**yml:**

```yaml
name: clustering
channels:
  - defaults
  - conda-forge
dependencies:
  - conda-forge::python=3.13
  - conda-forge::scanpy=1.12.4
  - conda-forge::pynndescent=0.5.13
  - conda-forge::ipykernel=7.1.0
  - conda-forge::ipywidgets=8.1.9
  - pip
  - pip:
      - igraph==1.0.0
      - lamindb==2.10.0
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

Preprocessing and visualization enabled us to describe our scRNA-seq dataset and reduce its dimensionality.
Up to this point, we embedded and visualized cells to understand the underlying properties of our dataset.
However, they are still rather abstractly defined.
The next natural step in single-cell analysis is the identification of cellular structure in the dataset.

In scRNA-seq data analysis, we describe cellular structure in our dataset by finding cell identities that relate to known cell states or cell cycle stages.
This process is usually called cell identity annotation.
For this purpose, we structure cells into clusters to infer the identity of similar cells. Clustering itself is a common unsupervised machine learning problem.
We can derive clusters by minimizing the intra-cluster distance in the reduced expression space.
In this case, the expression space determines the gene expression similarity of cells with respect to a dimensionality-reduced representation.
This lower-dimensional representation is, for example, determined with a principal-component analysis, and the similarity scoring is then based on Euclidean distances.

The KNN(K-Nearest-Neighbor) graph consists of nodes reflecting the cells in the dataset.
We first calculate a Euclidean distance matrix on the PC-reduced expression space for all cells and then connect each cell to its K most similar cells.
Usually, `K` is set to values between 5 and 100, depending on the size of the dataset.
The KNN graph reflects the underlying topology of the expression data by representing dense regions with respect to expression space, as well as as densely connected regions in the graph (Wolf *et al.*, 2019 [1]).
Dense regions in the KNN-graph are detected by community detection methods like Leiden and Louvain(Blondel *et al.*, 2008 [2]).

> **PC-reduced expression space**
> 
> PC-reduced expression space refers to the lower-dimensional space obtained after using Principal Component Analysis (PCA) to [high-dimensional](../glossary.md#term-high-dimensional-data) gene expression data. After PCA, for example, we are working with the top 10-50 principal components instead of 20,000 genes.

The Leiden algorithm is an improved version of the Louvain algorithm, which outperformed other clustering methods for single-cell RNA-seq data analysis ((Du *et al.*, 2018 [3]; Freytag *et al.*, 2018 [4]; Weber & Robinson, 2016 [5])).
Since the Louvain algorithm is no longer maintained, using Leiden instead is preferred.

We, therefore, propose to use the Leiden algorithm(Traag *et al.*, 2019 [6]) on single-cell k-nearest-neighbour (KNN) graphs to cluster single-cell datasets.

Leiden creates clusters by taking into account the number of links between cells in a cluster versus the overall expected number of links in the dataset.

![Clustering Overview](https://www.sc-best-practices.org/build/clustering-f6bf7813488086e4c150831b7150fb45.jpeg)

*Figure 1: The Leiden algorithm computes a clustering on a KNN graph obtained from the PC reduced expression space.
The starting point is a singleton partition in which each node functions as its own community.
As a next step, the algorithm creates partitions by moving individual nodes from one community to another, which is refined afterwards to enhance the partitioning.
The refined partition is then aggregated to a network.
Subsequently, the algorithm moves again individual nodes in the aggregate network, until refinement no longer changes the partition.
All steps are repeated until the final clustering is created and partitions no longer change.*

The Leiden module has a resolution parameter that allows for determining the scale of the partition cluster and therefore the coarseness of the clustering.
A higher resolution parameter leads to more clusters.
The algorithm additionally allows efficient sub-clustering of particular clusters in the dataset by sub-setting the KNN graph.
Sub-clustering enables the user to identify cell-type specific states within clusters or a finer cell type labeling(Wagner *et al.*, 2016 [7]), but can also lead to patterns that are only due to noise present in the data.

As mentioned before, the Leiden algorithm is implemented in scanpy.

> **Running this on a GPU**
> 
> Leiden clustering on a million-cell graph is one of the worst CPU bottlenecks in a typical pipeline and one of the best GPU wins.
> [rapids-singlecell](../introduction/rapids-singlecell.md) provides `rapids_singlecell.tl.leiden` with the same signature and routinely runs 50–100× faster than the CPU implementation.

```python
import lamindb as ln
import scanpy as sc

# Configuring scanpy's settings for outfits and visualization
sc.settings.verbosity = 0
sc.set_figure_params(dpi=80, facecolor="white", frameon=False)

ln.connect("theislab/sc-best-practices")

ln.track("rJhR7SskiROg")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ loaded Transform('rJhR7SskiROg0001', key='clustering.ipynb'), started new Run('5laRCo4plJDmKFCt') at 2026-09-29 12:55:56 UTC
→ notebook imports: lamindb-core==2.10.0 scanpy==1.12.4
```

## Clustering human bone marrow cells

Firstly, we load the sample `site4-donor8` of the NeurIPS human bone marrow dataset as we left it after [dimensionality reduction](../preprocessing-visualization/dimensionality-reduction.md), normalized with scran.
We remove the cells that scDblFinder called doublets during [quality control](../preprocessing-visualization/quality-control.md), drop the representations computed with them that we do not use further, and recompute the principal components on the remaining cells.

```python
af = ln.Artifact.get(
    key="preprocessing_visualization/s4d8_dimensionality_reduction.h5ad", is_latest=True
)
adata = af.load()
adata = adata[adata.obs["scDblFinder_class"] == "singlet"].copy()
del (
    adata.layers["analytic_pearson_residuals"],
    adata.obsm["X_tsne"],
    adata.obsm["X_umap_random"],
)
del adata.uns["tsne"], adata.uns["X_umap_random"], adata.uns["hvg"]
sc.pp.pca(adata, svd_solver="arpack", mask_var="highly_variable")
```

The Leiden algorithm leverages a KNN graph on the reduced expression space.
We can calculate the KNN graph on a lower-dimensional gene expression representation with the scanpy function `scanpy.pp.neighbors`.
We call this function on the top 30 principal-components as these capture most of the variance in the dataset.
Visualizing the clustering can help us to understand the results, we therefore embed our cells into a [UMAP](../glossary.md#term-uniform-manifold-approximation-and-projection-umap) embedding.
More details can be found in the [dimensionality reduction chapter](../preprocessing-visualization/dimensionality-reduction.md).

```python
sc.pp.neighbors(adata, n_pcs=30)
sc.tl.umap(adata)
```

We can now call the Leiden algorithm.

```python
sc.tl.leiden(adata, flavor="igraph", n_iterations=2)
```

> **Optimizing Leiden Iterations**
> 
> The `n_iterations` parameter in `scanpy.tl.leiden()` determines how many refinement passes the algorithm performs to optimize its community detection.
> 
> - **`n_iterations = 2` (Recommended):** The standard choice for most analyses.
>   It offers a significant boost in cluster quality over the Louvain algorithm while remaining computationally efficient.
> - **`n_iterations = -1` (Optimal):** Forces the algorithm to run until it reaches full convergence.
>   While this produces the “perfect” mathematical clustering, it can be significantly slower on large datasets.
> - **`n_iterations > 2`:** Allows you to specify a fixed number of passes to balance precision and speed.
> 
> **Tip:** Even at 2 iterations, Leiden effectively prevents the “disconnected clusters” issue often found in older methods.

In scanpy, the resolution parameter is used in clustering methods, such as the Louvain or Leiden methods.
It controls the granularity or coarseness of the resulting clusters.
The default resolution parameter in scanpy is 1.0.
However, in many cases the analyst may want to try different resolution parameters to control the coarseness of the clustering.
Hence, we recommend to save the clustering result under a specified key which indicates the selected resolution.

```python
sc.tl.leiden(
    adata, key_added="leiden_res0_25", resolution=0.25, flavor="igraph", n_iterations=2
)
sc.tl.leiden(
    adata, key_added="leiden_res0_5", resolution=0.5, flavor="igraph", n_iterations=2
)
sc.tl.leiden(
    adata, key_added="leiden_res1", resolution=1.0, flavor="igraph", n_iterations=2
)
```

We now visualize the different clustering results obtained with the Leiden algorithm at different resolutions.
As we can see, the resolution heavily influences how coarse our clustering is.
Higher resolution parameters lead to more communities, i.e., more identified clusters, while lower resolution parameters lead to fewer communities.
You can think of it like zooming, where we take a closer look at the clusters with higher resolution.
The resolution parameter, therefore, controls how densely clustered regions in the KNN-embedding are grouped together by the algorithm.
This will become especially important for annotating the clusters.

```python
sc.pl.umap(
    adata,
    color=["leiden_res0_25", "leiden_res0_5", "leiden_res1"],
    legend_loc="on data",
)
```

We now clearly inspect the impact of different resolutions on the clustering result.
For a resolution of 0.25, the clustering is much coarser, and the algorithm detected fewer communities.
Additionally, clustered regions are less dense compared to the clustering obtained at a resolution of 1.0.

We would like to highlight again that distances between the displayed clusters must be interpreted with caution.
As the UMAP embedding is in 2D, distances are not necessarily captured well between all points.
We recommend not interpreting distances between clusters visualized on UMAP embeddings.

As usual, we will upload the processed anndata to `lamindb`.
You can skip this part.

```python
af = ln.Artifact.from_anndata(
    adata,
    key="cellular_structure/s4d8_clustered.h5ad",
    description="anndata after clustering",
).save()
af
```

Output:
```text
→ creating new artifact version for key 'cellular_structure/s4d8_clustered.h5ad' in storage 's3://lamin-eu-central-1/VPwcjx3CDAa2'

... uploading UIb3nBOY3Xcejedh0005.h5ad:  0.0%

... uploading UIb3nBOY3Xcejedh0005.h5ad:  6.7%

... uploading UIb3nBOY3Xcejedh0005.h5ad: 13.4%

... uploading UIb3nBOY3Xcejedh0005.h5ad: 20.1%

... uploading UIb3nBOY3Xcejedh0005.h5ad: 46.9%

... uploading UIb3nBOY3Xcejedh0005.h5ad: 73.2%
... uploading UIb3nBOY3Xcejedh0005.h5ad: 100.0%
• replacing the existing cache path /home/lheumos/.cache/lamindb/lamin-eu-central-1/VPwcjx3CDAa2/cellular_structure/s4d8_clustered.h5ad
Artifact(uid='UIb3nBOY3Xcejedh0005', key='cellular_structure/s4d8_clustered.h5ad', description='anndata after clustering', suffix='.h5ad', kind='dataset', otype='AnnData', size=782282530, hash='MRpqammkfZYccrhHjkWCXn', n_files=None, n_observations=13668, extra_data=None, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=156, schema_id=None, created_by_id=2, created_at=2026-09-29 12:56:24 UTC, is_locked=False, version_tag=None, is_latest=True)
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Anna Schaar
- Seo H. Kim

### Reviewers

- Lukas Heumos

## References

1. Wolf, F. A., Hamey, F. K., Plass, M., Solana, J., Dahlin, J. S., Göttgens, B., Rajewsky, N., Simon, L., & Theis, F. J. (2019). PAGA: graph abstraction reconciles clustering with trajectory inference through a topology preserving map of single cells. *Genome Biology*, *20*(1), 59. https://doi.org/10.1186/s13059-019-1663-x
2. Blondel, V. D., Guillaume, J.-L., Lambiotte, R., & Lefebvre, E. (2008). Fast unfolding of communities in large networks. *Journal of Statistical Mechanics: Theory and Experiment*, *2008*(10), P10008. https://doi.org/10.1088/1742-5468/2008/10/p10008
3. Du, A., Robinson, M., & Soneson, C. (2018). A systematic performance evaluation of clustering methods for single-cell RNA-seq data [version 1; peer review: 2 approved with reservations]. *F1000Research*, *7*(1141). https://doi.org/10.12688/f1000research.15666.1
4. Freytag, S., Tian, L., L�nnstedt, I., Ng, M., & Bahlo, M. (2018). Comparison of clustering tools in R for medium-sized 10x Genomics single-cell RNA-sequencing data [version 1; peer review: 1 approved, 2 approved with reservations]. *F1000Research*, *7*(1297). https://doi.org/10.12688/f1000research.15809.1
5. Weber, L. M., & Robinson, M. D. (2016). Comparison of clustering methods for high-dimensional single-cell flow and mass cytometry data. *Cytometry Part A*, *89*(12), 1084–1096. https://doi.org/10.1002/cyto.a.23030
6. Traag, V. A., Waltman, L., & van Eck, N. J. (2019). From Louvain to Leiden: guaranteeing well-connected communities. *Scientific Reports*, *9*(1), 5233. https://doi.org/10.1038/s41598-019-41695-z
7. Wagner, A., Regev, A., & Yosef, N. (2016). Revealing the vectors of cellular identity with single-cell genomics. *Nature Biotechnology*, *34*(11), 1145–1160. https://doi.org/10.1038/nbt.3711
