# Spatially variable genes

Source: https://www.sc-best-practices.org/spatial/spatially-variable-genes  
Authors: Giovanni Palla, Anna Schaar, Lukas Heumos

**🧠 Key takeaways**

- Spatially variable genes (SVGs) are genes that show a significant spatial pattern.
- Methods designed for this task vary in complexity and model assumptions.
- We recommend using multiple methods to identify SVGs and assess the result by plotting the gene’s expression in space.

**⚙️ Environment setup**

**yml:**

```yaml
name: spatial
channels:
  - defaults
  - conda-forge
dependencies:
  - conda-forge::python=3.12.12
  - conda-forge::scanpy=1.12
  - conda-forge::leidenalg
  - conda-forge::pytorch-cpu
  - conda-forge::pip
  - pip:
      - squidpy==1.8.1
      - SpaGCN==1.2.7
      - SpatialDE==1.1.3
      - tangram-sc==1.0.4
      - cell2location==0.1.5
```

## Motivation

One main analysis step for single-cell data is to identify highly-variable genes (HVGs) and perform feature selection to reduce the dimensionality of the dataset. HVGs are genes which show significantly different expression profiles between cells or distinct groups. Methods designed for this task, however, neglect the spatial context of cells and can therefore not identify spatial variation. A gene might for example be highly variable, but not show a distinct spatial pattern and is therefore not spatially variable.

![Difference highly variable gene versus spatially variable gene](https://www.sc-best-practices.org/build/svg-b7d88512ca43723a8f8d577956222d95.jpeg)

*Figure 1: Spatially variable genes are genes that show a distinct spatial pattern, whereas highly variable genes reflect genes that differ significantly between cells or groups of cells.*

Spatial variation can be caused by differences in cell-type composition, overall functional dependencies or cell-cell communication events and help to understand the underlying tissue biology. Methods designed to identify spatially variable genes (SVGs) are designed to quantify whether a gene shows a significant spatial pattern by typically decomposing spatial and non-spatial variation in the dataset (Walker *et al.*, 2022 [1]).

Several methods have been proposed for this task with varying complexity and different assumptions. Currently there is no consensus on which method works best and how to define spatial variability in general. SpatialDE (Svensson *et al.*, 2018 [2]), SpatialDE2 (Kats *et al.*, 2021 [3]) and SPARK(Zhu *et al.*, 2021 [4]) (Sun *et al.*, 2020 [5]) use spatial correlation testing, Sepal(Andersson & Lundeberg, 2021 [6]) leverages a Gaussian diffusion on spatial expression, scGCO(Zhang *et al.*, 2022 [7]) utilizes a graph cut method and SpaGCN (Hu *et al.*, 2021 [8]) identifies SVGs based on spatial domains identified through a graph convolutional neural network.

In this notebook we provide a pedagogical example using Squidpy (Palla *et al.*, 2022 [9]) and its implementation of Moran’s I to find SVGs and subsequently an example workflow for SpatialDE.

## Environment setup and data

We first load the respective packages needed in this tutorial and the dataset.

```python
import NaiveDE
import scanpy as sc
import SpatialDE
import squidpy as sq

sc.settings.verbosity = 3
sc.settings.set_figure_params(dpi=80, facecolor="white")
```

The dataset used in this tutorial consists of 1 tissue slides from 1 mouse and is provided by [10x Genomics Space Ranger 1.1.0](https://support.10xgenomics.com/spatial-gene-expression/datasets/1.1.0/V1_Adult_Mouse_Brain). The dataset was pre-processed in Squidpy, which provides a loading function for this dataset.

```python
adata = sq.datasets.visium_hne_adata()
```

## Moran’s I score in Squidpy

One approach for the identification of spatially variable genes is the Moran’s I score, a measure of spatial autocorrelation (correlation of signal, such as gene expression, in observations close in space).

It is defined as:
$I = \frac{n}{W}\frac{{\mathop {\sum }\nolimits_{i = 1}^n \mathop {\sum }\nolimits_{j = 1}^n w_{i,j}z_iz_j}}{{\mathop {\sum }\nolimits_{i = 1}^n z_i^2}}$
where

- $z_{i}$ is the deviation of the feature from the mean $\left( {x_i - \bar X} \right)$
- $w_{i,j}$ is the spatial weight between observations
- $n$ is the number of spatial units
- $W$ is the sum of all $w_{i,j}$

It can be computed with Squidpy with 1 line. For the purpose of the example, we will compute it only for a few genes.

```python
sq.gr.spatial_neighbors(adata)
sq.gr.spatial_autocorr(adata, mode="moran", genes=adata.var_names)
```

Output:
```text
Creating graph using `grid` coordinates and `None` transform and `1` libraries.
Adding `adata.obsp['spatial_connectivities']`
       `adata.obsp['spatial_distances']`
       `adata.uns['spatial_neighbors']`
Finish (0:00:00)
Calculating moran's statistic for `None` permutations using `1` core(s)
Adding `adata.uns['moranI']`
Finish (0:00:00)
```

The method adds a dataframe to `adata.uns` under the key `moranI`. We can inspect the result now:

```python
adata.uns["moranI"].head()
```

The Squidpy implementation of Moran’s I computed for every gene

- `I` so the Moran’s I,
- `pval_norm` a p-value under normality assumption.
- `var_norm` the variance of the Moran’s I under normality assumption.
- `{p_val}_{corr_method}` the corrected p-values.

Let us look at two of the identified and significant genes, for example *Nrgn* and *Ttr*.
The table reports corrected p-values of 0.0 for both, which is a property of the representation rather than a result.
A p-value cannot be exactly zero, and what happened here is that the value fell below the smallest positive number double precision can hold and underflowed, so these entries should be read as smaller than anything the table can display.

The p-values here are computed analytically under a normality assumption, which puts no lower bound on how small they can get.
Passing `n_perms` to `spatial_autocorr` estimates them by permutation instead, where the number of permutations bounds how small a p-value can be reported.

```python
sq.pl.spatial_scatter(adata, color=["Nrgn", "Ttr"])
```

We can see that the expression of both of these genes seems to show a distinct localization in the tissue. It should be noted that they might (or might not) be also marker genes for specific cell clusters. One interpretation of spatially variable genes identification is that it is an orthogonal way to perform feature selection, by selecting genes that show a variability in space (instead of, for instance, across observations, as it is usually done).

## SpatialDE

SpatialDE identifies spatially variable genes through Gaussian process regression. The spatial method decomposes each gene’s expression variability into a spatial and nonspatial component. It then computes the ratio between the spatial and nonspatial variance term to quantify the overall spatial variance present in the dataset. In order to identify significant spatially variable genes, SpatialDE compares the full model that has access to the spatial component to a model without this term.

We are using the same dataset as we did for computing Moran’s I. As SpatialDE requires the counts table saved as a DataFrame with unique variable names, we first make all variable names unique with the help of the respective Scanpy function.

```python
adata.var_names_make_unique()
```

Next, we collect the raw count table with all barcode names and variable names saved as dataframe indexes and columns. Scanpy provides an efficient function for this, `get.obs_df` which collects the respective keys stored in `adata`.

```python
counts = sc.get.obs_df(adata, keys=list(adata.var_names), use_raw=True)
```

SpatialDE additionally requires the total counts and the spatial coordinates in the form of a DataFrame. We can use the same Scanpy function of collecting these items as before.

```python
total_counts = sc.get.obs_df(adata, keys=["total_counts"])
```

SpatialDE assumes a normally distributed noise. Since we just extracted raw counts, which empirically follow a negative binomial distribution, the counts data first needs to be transformed to a normal distributed noise. For this purpose SpatialDE uses a technique based on Anscombe:

```python
norm_expr = NaiveDE.stabilize(counts.T).T
```

The transformed data still might include a varying library size across the spatial samples which can introduce a bias in the gene expression. SpatialDE recommends to account for this before actually performing the spatial test and regressing it out with the provided function:

```python
resid_expr = NaiveDE.regress_out(total_counts, norm_expr.T, "np.log(total_counts)").T
```

We can now run the actual spatial test by passing the spatial coordinates and the normalized counts to SpatialDE. On the dataset, we are using here SpatialDE takes roughly 15 minutes when running it on all genes.

```python
results = SpatialDE.run(adata.obsm["spatial"], resid_expr)
```

Output:
```text
Models:   0%|          | 0/10 [00:00<?, ?it/s]
  0%|          | 0/18078 [00:00<?, ?it/s]
  0%|          | 0/18078 [00:00<?, ?it/s]
  0%|          | 0/18078 [00:00<?, ?it/s]
  0%|          | 0/18078 [00:00<?, ?it/s]
  0%|          | 0/18078 [00:00<?, ?it/s]
  0%|          | 0/18078 [00:00<?, ?it/s]
  0%|          | 0/18078 [00:00<?, ?it/s]
  0%|          | 0/18078 [00:00<?, ?it/s]
  0%|          | 0/18078 [00:00<?, ?it/s]
  0%|          | 0/18078 [00:00<?, ?it/s]
```

We can now inspect the result:

```python
results.head()
```

The resulting DataFrame contains the following important columns:

- `g`, the gene name
- `l`, a parameter indicating the genes distance scale a gene changes expression over
- `pval`, the p-value for spatial [differential expression](../glossary.md#term-differential-gene-expression-dge)
- `qval`, the corrected p-value after correcting for multiple testing

We can now sort the result based on the corrected p-values (`qval`) and to better read the DataFrame, subset the table to only show `g`, `l` and `qval`. We will additionally save the object as `top10` to conveniently use it for downstream plotting.

```python
top10 = results.sort_values("qval").head(10)[["g", "l", "qval"]]
top10
```

We can now plot the top-three significant genes and inspect their spatial pattern. We additionally plot the clusters of the dataset to analyze whether the detected genes might be linked to specific clusters.

```python
sq.pl.spatial_scatter(adata, color=list(top10["g"][:3]) + ["cluster"])
```

As we can observe, all three genes show spatial patterns. *Esrra* does not seem to be associated with a specific cluster, but shows a spatial pattern in primarily the cortex layers, the thalamus and hypothalamus. *Fbxo31* and *Jph3* are primarily expressed in the pyramidal layer.

## Contributors

### Authors

- Giovanni Palla
- Anna Schaar

### Reviewers

- Lukas Heumos

## References

1. Walker, B. L., Cang, Z., Ren, H., Bourgain-Chang, E., & Nie, Q. (2022). Deciphering tissue structure and function using spatial transcriptomics. *Communications Biology*, *5*(1), 220. https://doi.org/10.1038/s42003-022-03175-5
2. Svensson, V., Teichmann, S. A., & Stegle, O. (2018). SpatialDE: identification of spatially variable genes. *Nature Methods*, *15*(5), 343–346. https://doi.org/10.1038/nmeth.4636
3. Kats, I., Vento-Tormo, R., & Stegle, O. (2021). SpatialDE2: Fast and localized variance component analysis of spatial transcriptomics. *bioRxiv*, 2021.10.27.466045. https://doi.org/10.1101/2021.10.27.466045
4. Zhu, J., Sun, S., & Zhou, X. (2021). SPARK-X: non-parametric modeling enables scalable and robust detection of spatial expression patterns for large spatial transcriptomic studies. *Genome Biology*, *22*(1), 184. https://doi.org/10.1186/s13059-021-02404-0
5. Sun, S., Zhu, J., & Zhou, X. (2020). Statistical analysis of spatial expression patterns for spatially resolved transcriptomic studies. *Nature Methods*, *17*(2), 193–200. https://doi.org/10.1038/s41592-019-0701-7
6. Andersson, A., & Lundeberg, J. (2021). sepal: identifying transcript profiles with spatial patterns by diffusion-based modeling. *Bioinformatics*, *37*(17), 2644–2650. https://doi.org/10.1093/bioinformatics/btab164
7. Zhang, K., Feng, W., & Wang, P. (2022). Identification of spatially variable genes with graph cuts. *Nature Communications*, *13*(1), 5488. https://doi.org/10.1038/s41467-022-33182-3
8. Hu, J., Li, X., Coleman, K., Schroeder, A., Ma, N., Irwin, D. J., Lee, E. B., Shinohara, R. T., & Li, M. (2021). SpaGCN: Integrating gene expression, spatial location and histology to identify spatial domains and spatially variable genes by graph convolutional network. *Nat. Methods*, *18*(11), 1342–1351.
9. Palla, G., Spitzer, H., Klein, M., Fischer, D., Schaar, A. C., Kuemmerle, L. B., Rybakov, S., Ibarra, I. L., Holmberg, O., Virshup, I., Lotfollahi, M., Richter, S., & Theis, F. J. (2022). Squidpy: a scalable framework for spatial omics analysis. *Nature Methods*, *19*(2), 171–178. https://doi.org/10.1038/s41592-021-01358-2
