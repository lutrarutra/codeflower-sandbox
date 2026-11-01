# Differential gene expression analysis

Source: https://www.sc-best-practices.org/conditions/differential-gene-expression  
Authors: Lukas Heumos, Anastasia Litinetskaya, Soroor Hediyeh-Zadeh

**🧠 Key takeaways**

- In scRNA-seq, there are two main approaches to identify differentially expressed genes: the sample-level view and the cell-level view.
The sample-level approach has been shown to outperform the cell-level approach for scRNA-seq data.
- In the sample-level view, a pseudobulk sample is created for each patient and cell type by aggregating counts (e.g., summing across cells).
These pseudobulk profiles can then be analyzed using tools such as edgeR or DESeq2, which were originally developed for bulk RNA-seq data.
- Explore your data before modeling.
Performing PCA on pseudobulk samples can reveal major sources of variation that should be accounted for in your design matrix.
- Remove lowly expressed genes separately for each cell type, as different cell populations express distinct gene sets.
- If your dataset contains different subgroups, construct a design matrix that includes all relevant covariates.
You can then define contrasts to test the specific comparisons of interest.

**⚙️ Environment setup**

**yml:**

```yaml
name: differential-gene-expression
channels:
  - conda-forge
  - bioconda
dependencies:
  - conda-forge::python=3.14.6
  - conda-forge::pertpy=1.2.0
  - conda-forge::scanpy=1.12.3
  - bioconda::pydeseq2=0.5.4
  - pip
  - pip:
      - decoupler==2.2.0
      - lamindb==2.8.1
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

This chapter is a more detailed continuation of the [annotation](../glossary.md#term-annotation) [subchapter](../cellular-structure/annotation.md#cellular-structure-annotation-dge) which already introduced [differential gene expression (DGE)](../glossary.md#term-differential-gene-expression-dge) as a tool to annotate [clusters](../glossary.md#term-cluster) with [cell types](../glossary.md#term-cell-type).
Here, we focus on more advanced use-cases of differential gene expression testing in complex experimental designs, which involve one or more conditions such as diseases, genetic knockouts or drugs.
In such cases we are commonly interested in the magnitude and significance of differences in gene expression patterns between the condition of interest and a reference.
This reference can be everything but is commonly a healthy sample.
This statistical test can be applied to arbitrary groups, but in the case of single-cell [RNA](../glossary.md#term-rna)-Seq is commonly applied on the cell type level.

![DGE analysis overview](https://www.sc-best-practices.org/build/differential_gene_ex-31d9553d65c44f674ce98b52d87aa7ec.jpg)

*Figure 1: DGE analysis attempts to infer genes that are statistically significantly over- or underexpressed between any compared groups (commonly between healthy and condition per cell type).*

The outcome of such an analysis could be genesets which effect and potentially explain any observed phenotypes.
These genesets can then be examined more closely with respect to, for example, affected pathways or induced cell-cell communication changes.

A differential gene expression test usually returns the log2 fold-change and the adjusted p-value per compared genes per compared conditions. This list can then be sorted by p-value and investigated in more detail.

The popular student’s t-test is one way of conducting such a test.
However, it fails to take several single-cell RNA-seq peculiarities into account such as the excess number of zeros originating from [dropouts](../glossary.md#term-dropout) or the need for complex experimental designs.
More specifically, very rarely does one have sufficient sample numbers to accurately estimate the variance without pooling information across genes.
Moreover, raw counts are never an absolute measurement of expression for a specific gene within a given sample.
The actual read number per gene depends on the efficiency of the [library](../glossary.md#term-library) preparation, the amount of contamination from non-coding transcripts and the [sequencing](../glossary.md#term-sequencing) depth.
It does therefore lack in both, sensitivity and specificity for single-cell RNA-seq, let alone experimental design flexibility.

As a result, DGE testing is a classic bioinformatics problem which has been tackled by many tools already.
Generally, the problem is currently being approached from two views, the sample-level view where expression is aggregated to create “[pseudobulks](../glossary.md#term-pseudobulk)" and then analysed with methods originally designed for [bulk expression](../glossary.md#term-bulk-rna-sequencing) samples such as edgeR (Robinson *et al.*, 2010 [1]) or DEseq2 (Love *et al.*, 2014 [2]) and the cell-level view where [cells](../glossary.md#term-cell) are modeled individually using generalized mixed effect models such as MAST (Finak *et al.*, 2015 [3]) or glmmTMB (Brooks *et al.*, 2017 [4]).
The consensus and robustness across datasets for DGE tools is low (Wang *et al.*, 2019 [5]; Das *et al.*, 2021 [6]). As previously described, although single-cell data contains technical noise artifacts such as dropout, zero-inflation and high cell-to-cell variability (Hicks *et al.*, 2017 [7]; Vallejos *et al.*, 2017 [8]; Luecken & Theis, 2019 [9]), methods designed for bulk RNA-seq data performed favorably compared to methods explicitly designed for scRNA-seq data (Das *et al.*, 2021 [6]; Soneson & Robinson, 2018 [10]; Jaakkola *et al.*, 2016 [11]; Squair *et al.*, 2021 [12]).
Single-cell specific methods were found to be especially prone to wrongly labeling highly expressed genes as differentially expressed.

A recent study highlighted the issue of pseudoreplication where inferential statistics is applied to biological replicates which are not statistically independent.
Failing to account for the inherent correlation of replicates (cells from the same individual) inflates the false discovery rate (FDR) (Squair *et al.*, 2021 [12]; Zimmerman *et al.*, 2021 [13]; Junttila *et al.*, 2022 [14]).
Therefore, [batch effect](../glossary.md#term-batch-effect) correction or the aggregation of cell-type-specific expression values within an individual through either a sum, mean or random effect per individual, that is pseudobulk generation, should be applied prior to DGE analysis to account for within-sample correlations (Zimmerman *et al.*, 2021 [13]).
Generally, both, pseudobulk methods with sum aggregation such as edgeR, DESeq2, or Limma (Ritchie *et al.*, 2015 [15]) and mixed models such as MAST with random effect setting were found to be superior compared to naive methods, such as the popular Wilcoxon rank-sum test or Seurat’s (Hao *et al.*, 2021 [16]) latent models, which do not account for them (Junttila *et al.*, 2022 [14]).

In matters arising from the Zimmerman paper, Murphy et al. critically examined the Zimmerman [benchmarking](../glossary.md#term-benchmark) strategy and improved it (Murphy & Skene, 2022 [17]).
They came to the conclusion that pseudobulk methods perform best but whether sum or mean aggregation works better requires further investigation.

Hence, in this notebook, we demonstrate how to perform DGE analysis using the pseudobulk approach.
We choose DESeq2 due to its Python implementation, PyDESeq2.
However, the code can be easily adapted for use with edgeR by following the [pertpy tutorial on differential gene expression](https://pertpy.readthedocs.io/en/stable/tutorials/notebooks/differential_gene_expression.html#differential-expression-testing-with-edger).
For this chapter, we combined parts of the tutorials from [decoupler](https://decoupler.readthedocs.io/en/latest/notebooks/scell/rna_psbk.html) and [pertpy](https://pertpy.readthedocs.io/en/stable/tutorials/notebooks/differential_gene_expression.html).
Please refer to their documentation for more details.

## Environment setup

```python
import warnings

warnings.filterwarnings("ignore")
```

```python
import decoupler as dc
import lamindb as ln
import numpy as np
import pandas as pd
import pertpy as pt
import scanpy as sc

ln.connect("theislab/sc-best-practices")

ln.track("zt7x1ebMcoIA")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ found notebook differential_gene_expression.ipynb, making new version -- luisheinzlmeier already works on this draft
→ created Transform('zt7x1ebMcoIA0001', key='differential_gene_expression.ipynb'), started new Run('vEbb3sduUoKQ5nDY') at 2026-09-29 19:17:12 UTC
→ notebook imports: decoupler==2.2.0 lamindb-core==2.8.1 numpy==2.5.3 pandas==2.3.3 pertpy==1.2.0 scanpy==1.12.3
```

## Preparing the dataset

We will use the Kang dataset, which is a 10x droplet-based scRNA-seq peripheral blood mononuclear cell (PBMC) data from 8 Lupus patients before and after 6h-treatment with INF-β (16 samples in total) (Kang *et al.*, 2018 [18]).
Interferon beta is used in the form of natural fibroblast or recombinant preparations (interferon beta-1a and interferon beta-1b) and exerts antiviral and antiproliferative properties similar to those of interferon alpha.
Interferon beta has been approved for the treatment of relapsing–remitting multiple sclerosis and secondary progressive multiple sclerosis.

First, we load the full dataset.

```python
adata = ln.Artifact.get(
    key="conditions/differential_gene_expression.h5ad",
).load()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 24673 × 15706
    obs: 'nCount_RNA', 'nFeature_RNA', 'tsne1', 'tsne2', 'label', 'cluster', 'cell_type', 'replicate', 'nCount_SCT', 'nFeature_SCT', 'integrated_snn_res.0.4', 'seurat_clusters'
    var: 'name'
    obsm: 'X_pca', 'X_umap'
```

We will need `label` (which contains the condition label), `replicate` (patient id) and `cell_type` columns of the `.obs`.

```python
adata.obs[:5]
```

We will need to work with raw counts so we check that `.X` indeed contains raw counts and put them into the `counts` layer of our [AnnData](../glossary.md#term-anndata) object.

```python
X = adata.X.data
np.array_equal(X, np.round(X))
```

Output:
```text
True
```

```python
adata.layers["counts"] = adata.X.copy()
```

We have 8 control and 8 disease patients.

```python
print(len(adata[adata.obs["label"] == "ctrl"].obs["replicate"].cat.categories))
print(len(adata[adata.obs["label"] == "stim"].obs["replicate"].cat.categories))
```

Output:
```text
8
8
```

We filter cells which have less than 200 genes and genes which were found in less than 3 cells for a rudimentary quality control.

```python
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)
adata.shape
```

Output:
```text
(24562, 15701)
```

## Pseudobulking

Since PyDESeq2 was introduced as a method for DGE analysis for bulk data, we first need to create pseudobulk samples from our single-cell dataset.
For each patient we create one pseudobulk sample per cell type by aggregating the cells from each subpopulation and taking the sum of gene expression counts.
Regardless of whether we want to run the analysis only on a few cell subpopulations and fit a model for each one of them separately or fit one model for all of them, we first need to prepare the data.

Since we need to create pseudobulks for each patient-condition combination, we first need to create such a column by concatenating `replicate` and `label`.

```python
adata.obs["sample"] = pd.Categorical(
    f"{rep}_{l}" for rep, l in zip(
        adata.obs["replicate"],
        adata.obs["label"],
        strict=False
    )
)
```

Next, we generate pseudobulk samples using decoupler. With 8 patients, 8 cell types, and 2 conditions (`ctrl` and `stim`), this yields a total of 128 pseudobulks (8 x 8 x 2).

```python
adata_pb = dc.pp.pseudobulk(
    adata, sample_col="sample",
    groups_col="cell_type",
    layer="counts",
    mode="sum"
)
adata_pb
```

Output:
```text
AnnData object with n_obs × n_vars = 128 × 15701
    obs: 'sample', 'cell_type', 'label', 'replicate', 'psbulk_cells', 'psbulk_counts'
    var: 'name', 'n_cells'
    layers: 'psbulk_props'
```

Low-quality samples can be filtered using two criteria: the number of cells (`psbulk_cells`) and the total count sum (`psbulk_counts`).
These metrics can be visualized in the following plot to guide filtering decisions.

```python
dc.pl.filter_samples(
    adata=adata_pb,
    groupby=["label", "cell_type", "replicate"],
    min_cells=10,
    min_counts=1000,
    figsize=(5, 8),
)
```

While thresholds are dataset-specific and arbitrary, a commonly used guideline is to retain samples with a minimum of 10 cells and 1,000 total counts.
Applying these thresholds (indicated by dashed lines) restricts the dataset to pseudobulks in the upper-right quadrant.
The filtering step can be carried out with `decoupler.pp.filter_samples()`.

```python
dc.pp.filter_samples(adata_pb, min_cells=10,min_counts=1000)
```

After filtering out low-quality samples, we can visualize the remaining profiles.
All megakaryocyte pseudobulk samples failed quality control, and two CD8 T cell samples were removed.

```python
dc.pl.obsbar(adata=adata_pb, y="cell_type", hue="label", figsize=(6, 3))
```

## Variability Exploration

The validity of DGE results highly depends on the capture of the major axis of variations in the statistical model.
Intermediate data exploration steps such as [principal component analysis (PCA)](../glossary.md#term-principal-component-analysis-pca) or multidimensional scaling (MDS) on pseudobulk samples allow for the identification of the sources of variation and thus can guide the construction of corresponding design and contrast matrices that model the data (Law *et al.*, 2020 [19]).

Failing to account for multiple sources of biological variability for experiments which include biological replicates will inflate the FDR (Thurman *et al.*, 2021 [20]; Lähnemann *et al.*, 2020 [21]).
While increasing the number of cells per individual increases the precision, it has a limited effect on the power for the detection of differences across individuals.
Therefore, the best way to increase statistical power is to increase the number of independent experimental samples (Zimmerman *et al.*, 2021 [13]).

Since our data has already been generated, we cannot further increase the number of independent experimental samples.
Nevertheless, we will now explore our data to determine the major axes of variation to properly generate our design matrices.

We perform very basic exploratory data analysis on the generated pseudo-replicates to identify potential outliers among patients or pseudobulks.
These outliers can then be excluded to avoid biasing the differential expression results.
We store the raw counts in the `'counts'` layer, then normalize and scale them before computing PCA.
Afterwards, we revert to the raw counts for [downstream analysis](../glossary.md#term-downstream-analysis).

```python
adata_pb.layers['counts'] = adata_pb.X.copy()

sc.pp.normalize_total(adata_pb, target_sum=1e6)
sc.pp.log1p(adata_pb)
sc.pp.scale(adata_pb, max_value=10)
sc.tl.pca(adata_pb)

dc.pp.swap_layer(adata=adata_pb, key="counts", inplace=True)
```

We also include `psbulk_counts_log` and `psbulk_cells_log` because taking the log makes library sizes (`psbulk_counts` and `psbulk_cells`) less skewed and allows more reliable detection of correlations with principal components.

```python
adata_pb.obs["psbulk_counts_log"] = np.log(adata_pb.obs["psbulk_counts"])
adata_pb.obs["psbulk_cells_log"] = np.log(adata_pb.obs["psbulk_cells"])
```

```python
dc.tl.rankby_obsm(adata_pb, key="X_pca")
sc.pl.pca_variance_ratio(adata_pb)
dc.pl.obsm(
    adata=adata_pb,
    return_fig=True,
    nvar=5,
    titles=["PC scores", "Adjusted p-values"],
    figsize=(10, 5)
)
```

In this dataset, PC1 appears to explain the largest proportion of variance because it shows the highest variance ratio of around 0.13.
It is associated with the metadata variables cell type and pseudobulk cells.
Metadata variables associated with PCs that capture a substantial amount of variance are important and should be accounted for as relevant covariates (e.g., include in the design matrix) in downstream differential expression analysis when possible.
The principal components can also be directly visualized, colored by these metadata variables.

```python
adata_pb.obs = adata_pb.obs.sort_index(axis=1)
sc.pl.pca(adata_pb, color=adata_pb.obs, ncols=2, size=300)
```

We observe separation of cell types on the PCA plots as well as the separation into stimulated and unstimulated cells.
For pseudobulk cells and counts, we can also observe some clustering, with high values appearing in the top left and top right regions.
Looking more closely, we see that these clusters of high values partially overlap with specific cell type clusters: the top right cluster overlaps with CD4 T cells, while the top left cluster overlaps with CD14+ monocytes.
This suggests that the number of cells and counts assigned to a pseudospot may depend on the pseudospot’s cell type.
The covariates replicate and sample do not seem to be clearly correlated with the PCA components so we do not include any of them in our design matrix.

## One cell type or group

If you already know which cell types to focus on, subset them at this step to reduce confounding factors.
Otherwise, you can first analyze the full dataset to identify the most affected cell types, then return to this step.

If variability exploration showed that cell types are associated with PCs, it may help to rerun it on your cell type subsets to see if covariate effects disappear.
In our case, the association with pseudobulk cells disappears in CD14+ monocytes.
That’s why we won’t include it into our first design matrix.

### Feature selection

In addition to filtering low-quality samples, lowly or noisily expressed genes can also be filtered prior to DGE analysis.
This step should be performed at the cell type level, as different cell types may express distinct sets of genes.
We run the [pipeline](../glossary.md#term-pipeline) on CD14+ monocytes subset of the data, as it was shown in the paper that the highest number of differentially expressed genes was identified in this subpopulation.

```python
adata_mono = adata_pb[adata_pb.obs["cell_type"] == "CD14+ Monocytes"].copy()
adata_mono.shape
```

Output:
```text
(16, 15701)
```

Two strategies are used to filter genes:

1. `decoupler.pp.filter_by_expr`: Retains genes with a minimum total number of reads across all samples (`min_total_count`) and a minimum number of counts in a given number of samples (`min_count`).
   This approach was introduced in [edgeR](https://rdrr.io/bioc/edgeR/man/filterByExpr.html) (Robinson *et al.*, 2010 [1]).
2. `decoupler.pp.filter_by_prop`: Retains genes that are expressed in at least a specified proportion of cells (`min_prop`) across a minimum number of samples (`min_smpls`).
   The number of retained genes can be visualized, and the filtering parameters can be adjusted interactively.

```python
dc.pl.filter_by_expr(
    adata=adata_mono,
    group="label",
    min_count=10,
    min_total_count=15,
    large_n=10,
    min_prop=0.7,
)
dc.pl.filter_by_prop(
    adata=adata_mono,
    min_prop=0.1,
    min_smpls=2,
)
```

The top plot displays gene frequencies based on the `filter_by_expr` metrics, while the bottom plot corresponds to `filter_by_prop`.
Dashed lines indicate the current threshold values.
In the top plot, only genes in the upper-right quadrant are retained, in the bottom plot, only those to the right of the vertical line are kept.

Although filtering thresholds are arbitrary, a common heuristic is to look for bimodal distributions and set thresholds that separate low-quality genes from the rest.
In this example, the default parameters retain a substantial number of genes while removing potentially noisy ones.

Once the threshold parameters are set, the actual gene filtering can be performed by simply changing `pl` to `pp`.

```python
dc.pp.filter_by_expr(
    adata=adata_mono,
    group="label",
    min_count=10,
    min_total_count=15,
    large_n=10,
    min_prop=0.7,
)
dc.pp.filter_by_prop(
    adata=adata_mono,
    min_prop=0.1,
    min_smpls=2,
)
adata_mono.shape
```

Output:
```text
(16, 2345)
```

### Differential expression testing with PyDESeq2

We now switch to the pertpy package, as it makes it easier to use its built-in plotting functions.
However, DGE analysis can also be performed manually using PyDESeq2.
The interface of PyDESeq2 in pertpy is very similar.

At the next step, it is important to define an appropriate design matrix for the model.
For this purpose, we strongly recommend reading [this guide](https://f1000research.com/articles/9-1444), which provides a helpful introduction to design matrices.

> **Understand the design syntax**
> 
> We combine all the variables we would like to include in our model with a `+`.
> The variable names correspond to the column names ins `.obs`.
> Interactions between variables can be added to the model with `:`.
> For example, the model `y ~ a + b + a:b` includes the effect of `a` and `b` on `y` as well as how the effect of `a` on `y` changes depending on `b` and vice versa.
> In our context, `y` is the observed gene expression and `a` and `b` could be `label` and `cell_type`.
> Now it also becomes clear where the `~` comes from: It separates the two sides of a formula.
> So just add `~` at the beginning of your design.
> Besides that, it might be useful to know that `a * b` is shorthand for `a + b + a:b`.
> In most cases, this is all you need.
> For a deeper dive, we recommend reading the [formulaic](https://matthew.wardrop.casa/formulaic/latest/formulas/) and [patsy](https://patsy.readthedocs.io/en/latest/formulas.html) documentation.

```python
pds2 = pt.tl.PyDESeq2(adata=adata_mono,design='~ label')
```

```python
pds2.fit()
```

Output:
```text
Using None as control genes, passed at DeseqDataSet initialization
```

Before testing, we check the dispersion estimates of the fitted model.

```python
pds2.plot_disp_ests()
```

The gene-wise estimates (black) are shrunk towards the fitted trend (red) to obtain the final estimates (blue) used for testing.
Here, the trend is flat because PyDESeq2 could not fit a parametric mean-dispersion relationship and fell back to the mean dispersion.

```python
res_df = pds2.test_contrasts(pds2.contrast(
    column="label",
    baseline="ctrl",
    group_to_compare="stim")
)
```

Output:
```text
Log2 fold change & Wald test p-value, contrast vector: [0. 1.]
              baseMean  log2FoldChange     lfcSE       stat        pvalue  \
index                                                                       
HES4        179.827743        6.600818  0.378994  17.416675  6.165787e-68   
ISG15     19252.031373        7.076825  0.420063  16.847048  1.102835e-63   
SDF4         28.927758       -0.757190  0.178373  -4.244993  2.186003e-05   
UBE2J2       25.529327       -0.889015  0.187872  -4.732029  2.222861e-06   
AURKAIP1    115.547324       -0.572923  0.097558  -5.872663  4.288503e-09   
...                ...             ...       ...        ...           ...   
CSTB       1201.426144        0.864196  0.189353   4.563945  5.020113e-06   
SUMO3        72.227191       -0.429376  0.109301  -3.928390  8.551647e-05   
PTTG1IP      54.543949        0.213317  0.135536   1.573880  1.155153e-01   
ITGB2        41.979324        1.341234  0.240238   5.582937  2.364909e-08   
PRMT2        70.413437        0.566703  0.149067   3.801672  1.437226e-04   

                  padj  
index                   
HES4      2.950769e-66  
ISG15     4.383302e-62  
SDF4      4.556601e-05  
UBE2J2    5.228294e-06  
AURKAIP1  1.300975e-08  
...                ...  
CSTB      1.133028e-05  
SUMO3     1.669743e-04  
... (5 more lines)
```

```python
res_df.head(10)
```

Let’s take a look at the columns in the [results table](https://hbctraining.github.io/DGE_workshop_salmon/lessons/05_DGE_DESeq2_analysis2.html#:~:text=Results%20exploration):

- `variable`. gene name
- `baseMean`: mean of normalized counts for all samples
- `log_fc`: log2 fold change
- `lfcSE`: standard error
- `stat`: Wald statistic
- `p_value`: Wald test p-value
- `adj_p_value`: Benjamini-Hochberg adjusted p-values

The rows are sorted by `adj_p_value`.
The `log_fc` always depends on the defined baseline. A positive `log_fc` means gene expression is higher in the group of interest compared to the baseline group, while negative values indicate lower expression.
In this case, *IFITM2* increased by around 4.7 in stimulated compared to control CD14+ monocytes.
In contrast, *VCAN* decreased by around 4.4 (see the plot below).

Next, we visualize the results.

```python
pds2.plot_volcano(res_df, log2fc_threshold=0)
```

The higher a point is on the y-axis, the smaller the `adj_p_value`.
The further a point is from 0 on the x-axis, the larger the change in expression.
Overall, this means that genes in the upper left and upper right regions of the plot show the strongest changes in gene expression and, at the same time, are also the least likely to have changes that occurred by chance.

The MA plot shows the log2 fold change of every gene against its mean expression, with significant genes highlighted.
It reveals whether the detected changes are biased towards lowly or highly expressed genes.

```python
pds2.plot_ma(res_df)
```

We can also visualize our results for different subgroups.
In this case, we plot the results for individual patients.

```python
pds2.plot_paired(
    adata_mono,
    results_df=res_df,
    n_top_vars=4,
    groupby="label",
    pairedby="replicate"
)
```

We can see that the CD14+ monocytes from patient 1015 appear to be highly responsive to the treatment.

```python
af = ln.Artifact.from_dataframe(res_df, key="conditions/differential_gene_expression/res_df_CD14_Monocytes.parquet").save()
```

Output:
```text
→ creating new artifact version for key 'conditions/differential_gene_expression/res_df_CD14_Monocytes.parquet' in storage 's3://lamin-eu-central-1/VPwcjx3CDAa2'

... uploading Mem61XmLNGot02R90001.parquet:  0.0%

... uploading Mem61XmLNGot02R90001.parquet: 100.0%
```

> **Downstream analysis**
> 
> We save the differential gene expression results for downstream [gene set enrichment analysis](../glossary.md#term-gene-set-enrichment-analysis-gsea).
> See the [corresponding chapter](../conditions/gsea-pathway.md#population-contrast-enrichment-scoring) for details.

## Multiple cell types or groups

If you’re unsure which cell type will be most affected by a treatment, a good starting point is to fit a model to the entire dataset.
Afterwards, you can return to the analysis steps from the first part of this chapter and focus on the cell type of interest.

In addition, the following steps demonstrate how to handle analyses involving multiple groups within the data.
You may already know which cell type you want to examine more closely, but your dataset might include multiple groups (e.g., sex, responder vs. non-responder status or age groups).
Then, this section provides an initial glimpse of the types of questions you can explore for a single cell type across multiple groups.

Since we do not have particularly interesting subgroups within our CD14+ monocyte subset (`adata_mono`), we will instead analyze multiple cell types together.
Because this analysis includes several cell types simultaneously, we will skip the feature selection step at this stage.
Feature selection is better performed at the level of individual cell types, as different cell types can express distinct gene sets.

We will begin by constructing a simple design matrix.

```python
pds2 = pt.tl.PyDESeq2(adata=adata_pb, design="~ label")
```

```python
pds2.fit()
```

Output:
```text
Using None as control genes, passed at DeseqDataSet initialization
```

```python
res_df = pds2.compare_groups(
    adata_pb,
    column="label",
    baseline="ctrl",
    groups_to_compare=["stim"]
)
```

Output:
```text
Using None as control genes, passed at DeseqDataSet initialization
Log2 fold change & Wald test p-value, contrast vector: [0. 1.]
                baseMean  log2FoldChange     lfcSE      stat    pvalue  \
index                                                                    
AL627309.1      0.010607        0.043299  2.311137  0.018735  0.985052   
RP11-206L10.2   0.030188       -0.014208  2.116110 -0.006714  0.994643   
RP11-206L10.9   0.047391        0.120756  1.838519  0.065681  0.947632   
FAM87B          0.053617       -0.028965  2.604180 -0.011123  0.991126   
LINC00115       0.389827       -0.221982  0.420892 -0.527408  0.597910   
...                  ...             ...       ...       ...       ...   
C21orf58        0.121437       -0.262830  0.920079 -0.285661  0.775138   
PCNT            0.676612       -0.112715  0.333587 -0.337888  0.735447   
DIP2A           1.532521       -0.289120  0.273593 -1.056751  0.290625   
S100B           0.638731       -0.509241  0.795415 -0.640221  0.522029   
PRMT2          24.013222        0.241892  0.132709  1.822718  0.068346   

                   padj  
index                    
AL627309.1          NaN  
RP11-206L10.2       NaN  
RP11-206L10.9       NaN  
FAM87B              NaN  
LINC00115           NaN  
...                 ...  
C21orf58            NaN  
... (6 more lines)
```

```python
pds2.plot_paired(
    adata_pb,
    results_df=res_df,
    n_top_vars=4,
    groupby="label",
    pairedby="cell_type"
)
```

Output:
```text
• Performing pseudobulk for paired samples
```

We can see that the top four differentially expressed genes show their strongest expression changes not only in CD14+ monocytes but also in CD4 T cells.

Now we could ask: Is the gene expression difference between `ctrl` and `stim` different between CD14+ Monocytes and CD4 T cells?
In other words, could the gene expression changes depend on the cell type?

To do so, we create a more complex design matrix and then use contrasts to specify the conditions of interest.

```python
pds2 = pt.tl.PyDESeq2(adata=adata_pb, design="~ cell_type * label")
```

```python
pds2.fit()
```

Output:
```text
Using None as control genes, passed at DeseqDataSet initialization
```

```python
interaction_contrast = (
    pds2.cond(cell_type="CD14+ Monocytes", label="stim") -
    pds2.cond(cell_type="CD14+ Monocytes", label="ctrl")
) - (
    pds2.cond(cell_type="CD4 T cells", label="stim") -
    pds2.cond(cell_type="CD4 T cells", label="ctrl")
)

res_df = pds2.test_contrasts(interaction_contrast)
```

Output:
```text
Log2 fold change & Wald test p-value, contrast vector: [ 0.  0.  0.  0.  0.  0.  0.  0.  1. -1.  0.  0.  0.  0.]
                baseMean  log2FoldChange      lfcSE      stat    pvalue  \
index                                                                     
AL627309.1      0.010607        1.740385  10.956334  0.158847  0.873789   
RP11-206L10.2   0.030188       -0.208432  10.939235 -0.019054  0.984798   
RP11-206L10.9   0.047391        0.917190  10.951037  0.083754  0.933252   
FAM87B          0.053617        0.882214  10.986500  0.080300  0.935999   
LINC00115       0.389827        0.455590   1.374591  0.331437  0.740315   
...                  ...             ...        ...       ...       ...   
C21orf58        0.121437        0.744934   4.380657  0.170051  0.864970   
PCNT            0.676612       -0.612979   1.088831 -0.562970  0.573455   
DIP2A           1.532521       -0.203085   0.684868 -0.296531  0.766825   
S100B           0.638731        0.746335   2.760212  0.270390  0.786860   
PRMT2          24.013222        0.705997   0.293171  2.408144  0.016034   

                   padj  
index                    
AL627309.1          NaN  
RP11-206L10.2       NaN  
RP11-206L10.9       NaN  
FAM87B              NaN  
LINC00115           NaN  
...                 ...  
C21orf58            NaN  
PCNT                NaN  
... (5 more lines)
```

```python
pds2.plot_volcano(res_df, log2fc_threshold=0)
```

Output:
```text
NaNs encountered, dropping rows with NaNs
```

As we can see, there are some genes that stand out in their differences in gene expression changes.
For example, the change in expression of *RABGAP1L* is higher in CD14+ monocytes compared to CD4 T cells, while *ENO1* shows a lower change.

We can also plot the fold changes of the top differentially expressed genes.
We only include genes that pass an adjusted p-value threshold, for example 0.01.

```python
pds2.plot_fold_change(res_df, n_top_vars=15, padj_threshold=0.01)
```

Finally, we can also plot multiple comparisons.
In this case, we are comparing the gene expression of CD14+ monocytes to all other cell types.
Comparing cell types with each other should roughly reflect the marker genes used during annotation.
This therefore mainly shows what is possible and should ideally be replaced by your groups of interest (e.g., sex, responder vs. non-responder status or age groups).

```python
res_df = pds2.compare_groups(adata_pb,
    column="cell_type",
    baseline="CD14+ Monocytes",
    groups_to_compare=list(set(adata_pb.obs["cell_type"].unique()) - {"CD14+ Monocytes"})
)
```

Output:
```text
Using None as control genes, passed at DeseqDataSet initialization
Log2 fold change & Wald test p-value, contrast vector: [ 0. -1.  0.  0.  0.  1.  0.]
                baseMean  log2FoldChange     lfcSE      stat    pvalue  \
index                                                                    
AL627309.1      0.010607        2.151508  5.502361  0.391015  0.695786   
RP11-206L10.2   0.030188        1.959356  5.404192  0.362562  0.716932   
RP11-206L10.9   0.047391        1.959338  4.457357  0.439574  0.660246   
FAM87B          0.053617        2.295035  5.477388  0.419002  0.675215   
LINC00115       0.389827        1.067276  0.762873  1.399021  0.161807   
...                  ...             ...       ...       ...       ...   
C21orf58        0.121437        1.637420  1.891510  0.865668  0.386672   
PCNT            0.676612        2.224299  0.612129  3.633712  0.000279   
DIP2A           1.532521       -0.492112  0.514273 -0.956909  0.338613   
S100B           0.638731        1.730423  1.456065  1.188425  0.234666   
PRMT2          24.013222        0.148905  0.172718  0.862124  0.388619   

                   padj  
index                    
AL627309.1          NaN  
RP11-206L10.2       NaN  
RP11-206L10.9       NaN  
FAM87B              NaN  
LINC00115      0.343605  
...                 ...  
C21orf58            NaN  
... (156 more lines)
```

```python
pds2.plot_multicomparison_fc(res_df, n_top_vars=5, figsize=(12, 1.5))
```

The plot shows genes that are differentially expressed in all other cell types compared to CD14+ monocytes.
For example, *CLL2* and *CCL7* are significantly less expressed in all other cell types compared to CD14+ monocytes.

## Questions

### Flipcards

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card("q1", "What is differential gene expression and in which cases are we interested in testing for it?", "DGE analysis identifies genes with significant expression differences between conditions, such as healthy versus diseased states, to elucidate underlying biological mechanisms.", back_font_size=13)
    flip_card("q2", "What is the 'pseudoreplication' problem and how can it be circumvented?", "In single-cell RNA sequencing, treating individual cells from the same subject as independent samples can inflate false discovery rates. This issue can be mitigated by aggregating data into 'pseudobulks' per subject or modeling subjects as random effects.", back_font_size=13)
    flip_card("q3", "What is the 'multiple testing' problem and how can it be eluded?", "Testing thousands of genes simultaneously increases the likelihood of false positives. To address this, corrections like the Benjamini-Hochberg procedure are applied to control the false discovery rate.", back_font_size=15)
```

### Multiple choice questions

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    multiple_choice_question(
        "q4",
        "What does a positive log2 fold change indicate in DESeq2 results?",
        [
            "The gene is expressed equally in both groups",
            "The gene is more expressed in the baseline group",
            "The gene is more expressed in the group of interest compared to baseline",
            "The gene was filtered out during preprocessing",
        ],
        "The gene is more expressed in the group of interest compared to baseline",
        {},
    )

    multiple_choice_question(
        "q6",
        "What is the purpose of PCA on pseudobulk samples before DGE testing?",
        [
            "To normalize gene expression counts",
            "To identify sources of variation that should be captured in the design matrix",
            "To cluster cells into subtypes",
            "To remove batch effects automatically",
        ],
        "To identify sources of variation that should be captured in the design matrix",
        {},
    )

    multiple_choice_question(
        "q8",
        "What does an interaction term like `cell_type:label` in a design matrix allow you to test?",
        [
            "Whether cell types differ in total read counts",
            "Whether the effect of treatment differs across cell types",
            "Whether replicates are correlated within patients",
            "Whether batch effects are present in the data",
        ],
        "Whether the effect of treatment differs across cell types",
        {},
    )
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Lukas Heumos
- Anastasia Litinetskaya
- Soroor Hediyeh-Zadeh
- Luis Heinzlmeier

### Reviewers

## References

1. Robinson, M. D., McCarthy, D. J., & Smyth, G. K. (2010). edgeR: a Bioconductor package for differential expression analysis of digital gene expression data. *Bioinformatics (Oxford, England)*, *26*(1), 139–140. https://doi.org/10.1093/bioinformatics/btp616
2. Love, M. I., Huber, W., & Anders, S. (2014). Moderated estimation of fold change and dispersion for RNA-seq data with DESeq2. *Genome Biology*, *15*(12), 550. https://doi.org/10.1186/s13059-014-0550-8
3. Finak, G., McDavid, A., Yajima, M., Deng, J., Gersuk, V., Shalek, A. K., Slichter, C. K., Miller, H. W., McElrath, M. J., Prlic, M., Linsley, P. S., & Gottardo, R. (2015). MAST: a flexible statistical framework for assessing transcriptional changes and characterizing heterogeneity in single-cell RNA sequencing data. *Genome Biology*, *16*(1), 278. https://doi.org/10.1186/s13059-015-0844-5
4. Brooks, M. E., Kristensen, K., van Benthem, K. J., Magnusson, A., Berg, C. W., Nielsen, A., Skaug, H. J., Mächler, M., & Bolker, B. M. (2017). glmmTMB Balances Speed and Flexibility Among Packages for Zero-inflated Generalized Linear Mixed Modeling. *The R Journal*, *9*(2), 378–400. https://doi.org/10.32614/RJ-2017-066
5. Wang, T., Li, B., Nelson, C. E., & Nabavi, S. (2019). Comparative analysis of differential gene expression analysis tools for single-cell RNA sequencing data. *BMC Bioinformatics*, *20*(1), 40. https://doi.org/10.1186/s12859-019-2599-6
6. Das, S., Rai, A., Merchant, M. L., Cave, M. C., & Rai, S. N. (2021). A comprehensive survey of statistical approaches for differential Expression analysis in single-cell RNA sequencing studies. *Genes (Basel)*, *12*(12), 1947.
7. Hicks, S. C., Townes, F. W., Teng, M., & Irizarry, R. A. (2017). Missing data and technical variability in single-cell RNA-sequencing experiments. *Biostatistics*, *19*(4), 562–578. https://doi.org/10.1093/biostatistics/kxx053
8. Vallejos, C. A., Risso, D., Scialdone, A., Dudoit, S., & Marioni, J. C. (2017). Normalizing single-cell RNA sequencing data: challenges and opportunities. *Nature Methods*, *14*(6), 565–571. https://doi.org/10.1038/nmeth.4292
9. Luecken, M. D., & Theis, F. J. (2019). Current best practices in single-cell RNA-seq analysis: a tutorial. *Molecular Systems Biology*, *15*(6), e8746. https://doi.org/10.15252/msb.20188746
10. Soneson, C., & Robinson, M. D. (2018). Bias, robustness and scalability in single-cell differential expression analysis. *Nature Methods*, *15*(4), 255–261. https://doi.org/10.1038/nmeth.4612
11. Jaakkola, M. K., SeyeDNAsrollah, F., Mehmood, A., & Elo, L. L. (2016). Comparison of methods to detect differentially expressed genes between single-cell populations. *Briefings in Bioinformatics*, *18*(5), 735–743. https://doi.org/10.1093/bib/bbw057
12. Squair, J. W., Gautier, M., Kathe, C., Anderson, M. A., James, N. D., Hutson, T. H., Hudelle, R., Qaiser, T., Matson, K. J. E., Barraud, Q., Levine, A. J., La Manno, G., Skinnider, M. A., & Courtine, G. (2021). Confronting false discoveries in single-cell differential expression. *Nature Communications*, *12*(1), 5692. https://doi.org/10.1038/s41467-021-25960-2
13. Zimmerman, K. D., Espeland, M. A., & Langefeld, C. D. (2021). A practical solution to pseudoreplication bias in single-cell studies. *Nature Communications*, *12*(1), 738. https://doi.org/10.1038/s41467-021-21038-1
14. Junttila, S., Smolander, J., & Elo, L. L. (2022). Benchmarking methods for detecting differential states between conditions from multi-subject single-cell RNA-seq data. *bioRxiv*. https://doi.org/10.1101/2022.02.16.480662
15. Ritchie, M. E., Phipson, B., Wu, D., Hu, Y., Law, C. W., Shi, W., & Smyth, G. K. (2015). limma powers differential expression analyses for RNA-sequencing and microarray studies. *Nucleic Acids Research*, *43*(7), e47–e47. https://doi.org/10.1093/nar/gkv007
16. Hao, Y., Hao, S., Andersen-Nissen, E., III, W. M. M., Zheng, S., Butler, A., Lee, M. J., Wilk, A. J., Darby, C., Zagar, M., Hoffman, P., Stoeckius, M., Papalexi, E., Mimitou, E. P., Jain, J., Srivastava, A., Stuart, T., Fleming, L. B., Yeung, B., … Satija, R. (2021). Integrated analysis of multimodal single-cell data. *Cell*. https://doi.org/10.1016/j.cell.2021.04.048
17. Murphy, A. E., & Skene, N. G. (2022). A balanced measure shows superior performance of pseudobulk methods in single-cell RNA-sequencing analysis. *Nat Commun*, *13*(1). https://doi.org/10.1038/s41467-022-35519-4
18. Kang, H. M., Subramaniam, M., Targ, S., Nguyen, M., Maliskova, L., McCarthy, E., Wan, E., Wong, S., Byrnes, L., Lanata, C. M., & others. (2018). Multiplexed droplet single-cell RNA-sequencing using natural genetic variation. *Nature Biotechnology*, *36*(1), 89–94.
19. Law, C. W., Zeglinski, K., Dong, X., Alhamdoosh, M., Smyth, G. K., & Ritchie, M. E. (2020). A guide to creating design matrices for gene expression experiments. *F1000Research*, *9*, 1444–1444. https://pubmed.ncbi.nlm.nih.gov/33604029
20. Thurman, A. L., Ratcliff, J. A., Chimenti, M. S., & Pezzulo, A. A. (2021). Differential gene expression analysis for multi-subject single cell RNA sequencing studies with aggregateBioVar. *Bioinformatics*, *37*(19), 3243–3251.
21. Lähnemann, D., Köster, J., Szczurek, E., McCarthy, D. J., Hicks, S. C., Robinson, M. D., Vallejos, C. A., Campbell, K. R., Beerenwinkel, N., Mahfouz, A., Pinello, L., Skums, P., Stamatakis, A., Attolini, C. S.-O., Aparicio, S., Baaijens, J., Balvert, M., Barbanson, B. de, Cappuccio, A., … Schönhuth, A. (2020). Eleven grand challenges in single-cell data science. *Genome Biology*, *21*(1), 31. https://doi.org/10.1186/s13059-020-1926-6
