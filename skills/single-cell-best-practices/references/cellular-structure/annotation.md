# Annotation

Source: https://www.sc-best-practices.org/cellular-structure/annotation  
Authors: Lisa Sikkema, Maren Büttner, Seo H. Kim, Lukas Heumos

**🧠 Key takeaways**

- Cell annotation is the process of labeling groups of cells based on known or unknown cellular phenotypes, which is crucial for understanding the cellular composition of your data.
- Manual annotation relies on known marker genes and clustering, but it can be subjective and labor-intensive.
- Automated annotation methods, such as CellTypist and scArches-based reference mapping (using cellmapper for label transfer), offer faster and more scalable alternatives, but their accuracy depends on the quality of the reference data and the similarity between the reference and the query dataset.

**⚙️ Environment setup**

**yml:**

```yaml
name: annotation

channels:
  - conda-forge
  - bioconda
dependencies:
  - conda-forge::python=3.14.7
  - conda-forge::ipykernel=6.29.5
  - conda-forge::scanpy=1.12.3
  - conda-forge::leidenalg=0.12.0
  - conda-forge::pynndescent=0.5.13
  - conda-forge::scvi-tools=1.5.0.post1
  - pip
  - pip:
      - celltypist==1.6.3
      - lamindb==2.10.0
      - cellmapper==0.2.6
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

To understand your data better and make use of existing knowledge, it is important to figure out the “cellular identity” of each of the cells in your data.
The process of labeling groups of cells in your data based on known (or sometimes unknown) cellular phenotypes is called “cell annotation”.
Whereas there are many ways to annotate your cells (e.g. based on batch, disease, sex and more), in this notebook we will focus on the annotation of “cell types”.

A cell type is a cellular phenotype that is robust across datasets, identifiable by specific marker genes or proteins, and tied to a distinct biological function. A classic example is the plasma B cell — a white blood cell that secretes antibodies and can be identified by characteristic markers.

However, like with any categorization the size of categories and the borders drawn between them are partly subjective and can change over time, e.g. because new technologies allow for a higher resolution view of cells, or because specific “sub-phenotypes” that were not considered biologically meaningful are found to have important biological implications (see e.g. (Kadur Lakshminarasimha Murthy *et al.*, 2022 [1])).
Cell types are therefore often further classified into “subtypes” or “cell states” (e.g. activated versus resting) and some researchers use the term “cell identity” to avoid this sometimes arbitrary distinction.
For a more detailed discussion of this topic, we recommend the review by Wagner et al. (Wagner *et al.*, 2016 [2]) and the recently published review by Zeng (Zeng, 2022 [3]).

Similarly, multiple cell types can be part of a single continuum, where one cell type might transition or differentiate into another.
For example, in hematopoiesis cells differentiate from a stem cell into a specific immune cell type.
Although hard borders between early and late stages of this differentiation are often drawn, the state of these cells can more accurately be described by the differentiation coordinate between the less and more differentiated cellular phenotypes.

There are multiple ways to annotate cells.
We will give an overview of the most widely used approaches below.
As we are working with transcriptomic data, each of these methods is ultimately based on the expression of specific genes or gene sets, or general transcriptomic similarity between cells.

## Environment setup

```python
import shutil
import sys
from pathlib import Path

import celltypist
import lamindb as ln
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pandas.core.indexes.base as pandas_indexes_base
import scanpy as sc
import scvi
import seaborn as sns
from cellmapper import CellMapper
from celltypist import models
from scipy.sparse import csr_matrix

ln.connect("theislab/sc-best-practices")

ln.track("BnpvfJLWjHuE")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ loaded Transform('BnpvfJLWjHuE000B', key='annotation.ipynb'), started new Run('197nMX5slReRukck') at 2026-09-29 13:05:48 UTC
→ notebook imports: cellmapper==0.2.6 celltypist==1.6.3 lamindb-core==2.10.0 matplotlib==3.11.2 numba==0.67.0 numpy==2.5.3 pandas==3.0.6 scanpy==1.12.3 scipy==1.18.1 scvi-tools==1.5.0.post1 seaborn==0.13.2
```

```python
# filter out some deprecation and performance warnings that do not affect our code

import warnings

# celltypist switches off all warnings when it is imported, so we restore Python's defaults
warnings.resetwarnings()
for category in (
    DeprecationWarning,
    PendingDeprecationWarning,
    ImportWarning,
    ResourceWarning,
):
    warnings.simplefilter("ignore", category=category)

from numba.core.errors import NumbaDeprecationWarning

warnings.simplefilter("ignore", category=NumbaDeprecationWarning)
warnings.filterwarnings("ignore", category=pd.errors.PerformanceWarning)
```

We will continue working with the scRNA-seq dataset that we earlier preprocessed and will now annotate it.

Set figure parameters:

```python
sc.set_figure_params(figsize=(5, 5))
```

## Load data

Let’s read in the toy dataset we will use for this tutorial. It includes a single sample (“site4-donor8”) of the data also used in other parts of the book. Moreover, cells that didn’t pass QC and predicted doublets have already been removed.

```python
af = ln.Artifact.get(key="cellular_structure/s4d8_clustered.h5ad", is_latest=True)
adata = af.load(is_run_input=False)
```

## Manual annotation

The classical or oldest way to perform cell type annotation is based on a single or small set of [marker genes](../glossary.md#term-marker-gene) known to be associated with a particular cell type.
This approach dates back to “pre-scRNA-seq times”, when single-cell data was low-dimensional (e.g., FACS data with gene panels consisting of no more than 30-40 genes).
However, when no unique markers exist for a specific cell type, this approach can quickly become challenging and less objective, with combinations of markers or expression thresholds necessary for proper annotation.
A robust set of marker genes and prior knowledge or annotation experience can help here, but the approach comes with the risk of unclear and subjective decision-making.

For manual annotation, the data is usually clustered before annotation, so that we can annotate groups of cells instead of making a per-cell call.
This is not only less laborious but also more robust to noise: a single cell might not have a count for a specific marker even if it was expressed in that cell, simply due to the inherent sparsity of single-cell data.
Clustering enables the detection of cells highly similar in overall gene expression and can therefore account for drop-outs at the single-cell level.

Finally, there are two angles from which to approach the marker-gene-based annotation.
One option is to work from a table of marker genes for all the cell types you expect in your data and check in which clusters those genes are expressed.
The other option is to check which genes are highly expressed in the clusters you defined and then check if they are associated with known cell types or states.
If necessary, one can move back and forth between those approaches.
We will show examples of both below.

### From markers to cluster annotation

First, we list a set of markers for cell types in the bone marrow that is based on literature: previous papers that study specific cell types and subtypes and report marker genes for those cell types.
Note that markers at the protein level (e.g., used for FACS) sometimes do not work as well in transcriptomic data; hence, using markers from RNA-based papers is often more likely to work.
Moreover, sometimes markers in one dataset do not turn out to work as well in other datasets.
Ideally, a marker set is therefore validated across multiple datasets.
It is often useful to work together with experts: as a bioinformatician, try to team up with a biologist who has more extensive knowledge of the tissue, the biology, the expected cell types and markers, etc.

```python
# keys: cell types or populations, values: lists of marker genes
marker_genes = {
    "CD14+ Mono": ["FCN1", "CD14"],
    "CD16+ Mono": ["TCF7L2", "FCGR3A", "LYN"],
    "ID2-hi myeloid prog": [
        "CD14",
        "ID2",
        "VCAN",
        "S100A9",
        "CLEC12A",
        "KLF4",
        "PLAUR",
    ],
    "cDC1": ["CLEC9A", "CADM1"],
    "cDC2": [
        "CST3",
        "COTL1",
        "LYZ",
        "DMXL2",
        "CLEC10A",
        "FCER1A",
    ],  # Note: DMXL2 should be negative
    "Normoblast": ["SLC4A1", "SLC25A37", "HBB", "HBA2", "HBA1", "TFRC"],
    "Erythroblast": ["MKI67", "HBA1", "HBB"],
    "Proerythroblast": [
        "CDK6",
        "SYNGR1",
        "HBM",
        "GYPA",
    ],  # Note HBM and GYPA are negative markers
    "NK": ["GNLY", "NKG7", "CD247", "GRIK4", "FCER1G", "TYROBP", "KLRG1", "FCGR3A"],
    "ILC": ["ID2", "PLCG2", "GNLY", "SYNE1"],
    "Lymph prog": [
        "VPREB1",
        "MME",
        "EBF1",
        "SSBP2",
        "BACH2",
        "CD79B",
        "IGHM",
        "PAX5",
        "PRKCE",
        "DNTT",
        "IGLL1",
    ],
    "Naive CD20+ B": ["MS4A1", "IL4R", "IGHD", "FCRL1", "IGHM"],
    "B1 B": [
        "MS4A1",
        "SSPN",
        "ITGB1",
        "EPHA4",
        "COL4A4",
        "PRDM1",
        "IRF4",
        "CD38",
        "XBP1",
        "PAX5",
        "BCL11A",
        "BLK",
        "IGHD",
        "IGHM",
        "ZNF215",
    ],  # Note IGHD and IGHM are negative markers
    "Transitional B": ["MME", "CD38", "CD24", "ACSM3", "MSI2"],
    "Plasma cells": ["MZB1", "HSP90B1", "FNDC3B", "PRDM1", "IGKC", "JCHAIN"],
    "Plasmablast": ["XBP1", "RF4", "PRDM1", "PAX5"],  # Note PAX5 is a negative marker
    "CD4+ T activated": ["CD4", "IL7R", "TRBC2", "ITGB1"],
    "CD4+ T naive": ["CD4", "IL7R", "TRBC2", "CCR7"],
    "CD8+ T": ["CD8A", "CD8B", "GZMK", "GZMA", "CCL5", "GZMB", "GZMH", "GZMA"],
    "T activation": ["CD69", "CD38"],  # CD69 much better marker!
    "T naive": ["LEF1", "CCR7", "TCF7"],
    "pDC": ["GZMB", "IL3RA", "COBLL1", "TCF4"],
    "G/M prog": ["MPO", "BCL2", "KCNQ5", "CSF3R"],
    "HSC": ["NRIP1", "MECOM", "PROM1", "NKAIN2", "CD34"],
    "MK/E prog": [
        "ZNF385D",
        "ITGA2B",
        "RYR3",
        "PLCB1",
    ],  # Note PLCB1 is a negative marker
}
```

> **Negative markers**
> 
> A negative marker is a gene not expressed in a specific cell type, used to exclude or distinguish it, whereas a positive marker is actively expressed to identify the cell type.

Subset to only the markers that were detected in our data.
We will loop through all cell types and keep only the genes that we find in our adata object as markers for that cell type.
This will prevent errors once we start plotting.

```python
marker_genes_in_data = {}
for ct, markers in marker_genes.items():
    markers_found = []
    for marker in markers:
        if marker in adata.var.index:
            markers_found.append(marker)
    marker_genes_in_data[ct] = markers_found
```

To see where these markers are expressed, we can work with a 2-dimensional visualization of the data, such as a [UMAP](../glossary.md#term-uniform-manifold-approximation-and-projection-umap).
We calculate such an embedding here based on the scran-normalized count data, using only the highly deviant genes.
Note that we first perform a PCA on the normalized counts to reduce the dimensionality of the data before we generate the UMAP.

Our raw counts are stored in `.layers['counts']`, and we set `adata.X` to the scran-normalized, log-transformed counts.

```python
adata.X = adata.layers["scran_normalization"]
```

We furthermore set our `adata.var.highly_variable` to the highly deviant genes.
Scanpy uses this var column in downstream calculations, such as the PCA below.

```python
adata.var["highly_variable"] = adata.var["highly_deviant"]
```

Now perform PCA.
We use the highly deviant genes (set as “highly variable” above) to reduce noise and strengthen signal in our data and set number of components to the default n=50.
50 is on the high side for data of a single sample, but it will ensure that we don’t ignore important variation in our data.

```python
sc.tl.pca(adata, n_comps=50, mask_var="highly_variable")
```

Calculate the neighbor graph based on the PCs:

```python
sc.pp.neighbors(adata)
```

And use that neighbor graph to calculate a 2-dimensional UMAP embedding of the data:

```python
sc.tl.umap(adata)
```

Now show expression of the markers using the calculated UMAP.
We’ll limit ourselves to B/plasma cell subtypes for this example.
Note from the marker dictionary above that there are three negative markers in our list: IGHD and IGHM for B1 B, and PAX5 for plasmablasts, meaning that this cell type is expected not to or to lowly express those markers.

Let’s list the B cell subtypes we want to show the markers for:

```python
B_plasma_cts = [
    "Naive CD20+ B",
    "B1 B",
    "Transitional B",
    "Plasma cells",
    "Plasmablast",
]
```

And now plot one UMAP per marker for each of the B cell subtypes. Note that we can only plot the markers that are present in our data.

```python
for ct in B_plasma_cts:
    print(f"{ct.upper()}:")  # print cell subtype name
    sc.pl.umap(
        adata,
        color=marker_genes_in_data[ct],
        vmin=0,
        vmax="p99",  # set vmax to the 99th percentile of the gene count instead of the maximum, to prevent outliers from making expression in other cells invisible. Note that this can cause problems for extremely lowly expressed genes.
        sort_order=False,  # do not plot highest expression on top, to not get a biased view of the mean expression among cells
        frameon=False,
        cmap="Reds",  # or choose another color map e.g. from here: https://matplotlib.org/stable/tutorials/colors/colormaps.html
    )
    print("\n\n\n")  # print white space for legibility
```

Output:
```text
NAIVE CD20+ B:

B1 B:

TRANSITIONAL B:

PLASMA CELLS:

PLASMABLAST:
```

Even markers for a single cell type are often expressed in different subsets of the data, i.e. individual markers are often not uniquely expressed in a single cell type.
Rather, it is the intersection of those subsets that will tell you where your cell type of interest is.

Of note is that markers are often sparsely expressed, i.e., it is often only a subset of cells of a cell type in which a marker was detected.
This is due to the nature of scRNA-seq data: we only sequence a small subset of the total amount of RNA molecules in the cell, and due to this subsampling, we will sometimes not sample transcripts from specific genes in a cell even if they were expressed in that cell.
Therefore, we do not annotate single cells based on a minimum expression threshold of, e.g., a set of markers.
Instead, we first subdivide the data into groups of similar cells (i.e., “partition” the data) by clustering, thereby accounting for “missing transcripts” of single genes and rather grouping based on overall transcriptomic similarity.
We can then annotate those clusters based on their overall marker expression patterns.

Let us cluster our data now.
We will use the Leiden algorithm (Traag *et al.*, 2019 [4]) as discussed in the Clustering chapter to define a grouping of our data into similar subsets of cells:

```python
sc.tl.leiden(adata, resolution=1, key_added="leiden_1", flavor="igraph", n_iterations=2)
```

```python
sc.pl.umap(adata, color="leiden_1")
```

In case you want the partitioning to be finer, you can change the resolution to a higher level by changing the resolution parameter of the clustering:

```python
sc.tl.leiden(adata, resolution=2, key_added="leiden_2", flavor="igraph", n_iterations=2)
```

You can also add the cluster numbers to the UMAP.

```python
sc.pl.umap(adata, color="leiden_2", legend_loc="on data")
```

This clustering is much finer and, in some cases, will help you annotate the data with more detail.
You can play around with the resolution parameter to find the setting that best captures the marker expression patterns you observe.
In our case, we will stick to the original resolution:

```python
sc.pl.umap(adata, color="leiden_1", legend_loc="on data")
```

Scrolling back up, you will see that cluster 11 consistently expresses Naive CD20+ B cell markers, while cluster 12 consistently expresses Transitional B cell markers.

We can also visualize this using a dotplot:

```python
B_plasma_markers = {
    ct: [m for m in ct_markers if m in adata.var.index]
    for ct, ct_markers in marker_genes.items()
    if ct in B_plasma_cts
}
```

```python
sc.pl.dotplot(
    adata,
    groupby="leiden_1",
    var_names=B_plasma_markers,
    standard_scale="var",  # standard scale: normalize each gene to range from 0 to 1
)
```

Using a combination of visual inspection of the UMAPs and the dotplot above we can now start annotating the clusters:

```python
cl_annotation = {
    "11": "Naive CD20+ B",
    "12": "Transitional B",
}
```

You might notice that the annotation of B1 B cells is difficult, with none of the clusters expressing all the B1 B markers and several clusters expressing some of the markers.
We often see that markers that work for one dataset do not work as well for others.
This can be due to differences in [sequencing depth](../glossary.md#term-sequencing-depth), but also due to other sources of variation between datasets or samples.

Let’s visualize our annotations so far:

```python
adata.obs["manual_celltype_annotation"] = adata.obs.leiden_1.map(cl_annotation)
```

```python
sc.pl.umap(adata, color=["manual_celltype_annotation"])
```

### From cluster differentially expressed genes to cluster annotation

Conversely, we can calculate marker genes per cluster and then look up whether we can link those marker genes to any known biology, such as cell types and/or states.
For marker gene calculation of clusters, simple methods such as the Wilcoxon rank-sum test are thought to perform best (Pullin & McCarthy, 2022 [5]).
Importantly, as the definition of the clusters is based on the same data as used for these statistical tests, the p-values of these tests will be inflated as also described here (Zhang *et al.*, 2019 [6]).

Let’s calculate the [differentially expressed genes](../glossary.md#term-differential-gene-expression-dge) for every cluster, compared to the rest of the cells in our adata:

```python
sc.tl.rank_genes_groups(
    adata, groupby="leiden_1", method="wilcoxon", key_added="dea_leiden_1"
)
```

We can visualize expression of the top differentially expressed genes per cluster with a standard scanpy dotplot:

```python
sc.tl.dendrogram(
    adata,
    groupby="leiden_1",
)

sc.pl.rank_genes_groups_dotplot(
    adata, groupby="leiden_1", standard_scale="var", n_genes=5, key="dea_leiden_1"
)
```

As you can see above, a lot of the differentially expressed genes are highly expressed in multiple clusters.
We can filter the differentially expressed genes to select for more cluster-specific differentially expressed genes:

```python
sc.tl.filter_rank_genes_groups(
    adata,
    min_in_group_fraction=0.2,
    max_out_group_fraction=0.2,
    key="dea_leiden_1",
    key_added="dea_leiden_1_filtered",
)
```

Visualize the filtered genes :

```python
sc.pl.rank_genes_groups_dotplot(
    adata,
    groupby="leiden_1",
    standard_scale="var",
    n_genes=5,
    key="dea_leiden_1_filtered",
)
```

Let’s take a look at cluster 1, which seems to have a set of relatively unique markers including MYOM2, KLRD1 and KLRF1.
Some googling tells us that e.g. KLRD1 is a marker for NK cells (Isola *et al.*, 2021 [7]).
In the UMAP we can see that these genes are expressed throughout cluster 1:

```python
sc.pl.umap(
    adata,
    color=["MYOM2", "KLRD1", "KLRF1", "leiden_1"],
    vmax="p99",
    legend_loc="on data",
    frameon=False,
    cmap="Reds",
)
```

However, marker-based annotation can be sensitive to the cluster resolution you choose, the robustness and uniqueness of the marker sets you have, and your knowledge of the cell types to be expected in your data.
Therefore, cluster annotations are not guaranteed to be definitive and should be interpreted with caution.

For this reason, the field is partly trying to move away from manual cluster annotation and rather moving towards automated annotation algorithms instead.
The rest of this tutorial will focus on those options.

Before we move on, store the final bit of annotation information in our adata:

```python
cl_annotation["1"] = "NK cells (?)"
```

```python
adata.obs["manual_celltype_annotation"] = adata.obs.leiden_1.map(cl_annotation)
```

## Automated annotation

### General remarks

The remainder of the discussed methods will be methods for automated, rather than manual annotation of your data.
Automated approaches are based on different principles, sometimes requiring pre-defined sets of markers, other times trained on pre-existing full scRNA-seq datasets.
As discussed below, the resulting annotations can be of varying quality.
It is therefore important to regard these methods as a starting point rather than an end-point of the annotation process.
See also several reviews (Pasquini *et al.*, 2021 [8]), (Abdelaal *et al.*, 2019 [9]) for a more elaborate discussion of automated annotation methods.

The quality of automatically generated annotations can vary substantially.
More specifically, the quality of the annotations depends on:

1. The type of classifier chosen: Previous benchmark studies have shown that different types of classifiers often perform comparably, with neural network-based methods generally not outperforming general-purpose models such as support vector machines or linear regression models(Abdelaal *et al.*, 2019 [9]), (Pasquini *et al.*, 2021 [8]), (Huang & Zhang, 2021 [10]).  
   
2. The quality of the data that the classifier was trained on.
   If the training data was not well annotated or annotated at low resolution, the classifier will do the same.
   Similarly, if the training data and/or its annotation was noisy, the classifier might not perform well.  
   
3. The similarity of your own data to the data that the classifier was trained on.
   For example, if the classifier was trained on a drop-seq single cell dataset and your data is 10X single nucleus rather than single cell drop-seq, this might worsen the quality of the annotation.
   Classifiers trained on cross-dataset atlases including a diversity of datasets might give more robust and better quality annotations than classifiers trained on a single dataset.
   An example is the CellTypist (an automated annotation method that will be discussed more extensively below) classifier trained on the Human Lung Cell Atlas (Sikkema *et al.*, 2023 [11]) which includes 14 different lung datasets.
   This model is likely to perform better on new lung data than a model that was trained on a single lung dataset.

The aforementioned points highlight possible disadvantages of using classifiers, depending on the training data and model type.
Nonetheless, there are several important advantages of using pre-trained classifiers to annotate your data.
First, it is a fast and easy way to annotate your data.
The annotation does not require the downloading nor preprocessing of the training data and sometimes merely involves the upload of your data to an online webpage.
Second, these methods don’t rely on a partitioning of your data into clusters, as the manual annotation does.
Third, pre-trained classifiers enable you to directly leverage the knowledge and information from previous studies, such as a high quality annotation.
And finally, using such classifiers can help with harmonizing cell-type definitions across a field, thereby clearing the path towards a field-wide consensus on these definitions.

Finally, as these classifiers are often less transparent than e.g. manual marker-based annotation, a good uncertainty measure quantifying annotation uncertainty will improve the quality and usability of the method.
We will discuss this more extensively further down.

### Marker gene-based classifiers

One class of automated cell type annotation methods relies on a predefined set of marker genes.
Cells are classified into cell types based on their expression levels of these marker genes.
Examples of such methods are Garnett (Pliner *et al.*, 2019 [12]) and CellAssign (Zhang *et al.*, 2019 [13]).
The more robust and generalizable the set of marker genes these models are based on, the better the model will perform.
However, like with other models they are likely to be affected by batch effect-related differences between the data the model was trained on and the data that needs to be labeled.
One of the advantages of these methods compared to models based on larger gene sets (see below) is that they are more transparent: we know on the basis of which genes the classification is done.  

We will not show an example of marker-based classifiers in this notebook, but encourage you to explore these yourself if you are interested.

### Classifiers based on a wider set of genes

It is worth noting that the methods discussed so far use only a small subset of the genes detected in the data: often a set of only 1 to ~10 marker genes per cell type is used.
An alternative approach is to use a classifier that takes as input a larger set of genes (several thousands or more), thereby making more use of the breadth of scRNA-seq data.
Such classifiers are trained on previously annotated datasets or atlases.
Examples of these are CellTypist (Conde *et al.*, 2022 [14]) (see also [https://​www​.celltypist​.org](https://www.celltypist.org), where data can be uploaded to a portal to get automated cell annotations) and Clustifyr (Fu *et al.*, 2020 [15]).

Let’s try out CellTypist on our data.
Based on the CellTypist tutorial ([https://​www​.celltypist​.org​/tutorials](https://www.celltypist.org/tutorials)) we know we need to prepare our data so that counts are normalized to 10,000 counts per cell, then log1p-transformed:

```python
adata_celltypist = adata.copy()  # make a copy of our adata
adata_celltypist.X = adata.layers["counts"].copy()  # set adata.X to raw counts
sc.pp.normalize_total(
    adata_celltypist, target_sum=10**4
)  # normalize to 10,000 counts per cell
sc.pp.log1p(adata_celltypist)  # log-transform
# make .X dense instead of sparse, for compatibility with celltypist:
adata_celltypist.X = adata_celltypist.X.toarray()
```

We’ll now download the celltypist models for immune cells:

```python
models.download_models(
    force_update=True, model=["Immune_All_Low.pkl", "Immune_All_High.pkl"]
)
```

Let’s try out both the `Immune_All_Low` and `Immune_All_High` models (these annotate immune cell types finer annotation level (low) and coarser (high)):

```python
model_low = models.Model.load(model="Immune_All_Low.pkl")
model_high = models.Model.load(model="Immune_All_High.pkl")
```

For each of these, we can see which cell types it includes to see if bone marrow cell types are included:

```python
model_high.cell_types
```

Output:
```text
array(['B cells', 'B-cell lineage', 'Cycling cells', 'DC', 'DC precursor',
       'Double-negative thymocytes', 'Double-positive thymocytes', 'ETP',
       'Early MK', 'Endothelial cells', 'Epithelial cells',
       'Erythrocytes', 'Erythroid', 'Fibroblasts', 'Granulocytes',
       'HSC/MPP', 'ILC', 'ILC precursor', 'MNP', 'Macrophages',
       'Mast cells', 'Megakaryocyte precursor',
       'Megakaryocytes/platelets', 'Mono-mac', 'Monocyte precursor',
       'Monocytes', 'Myelocytes', 'Plasma cells', 'Promyelocytes',
       'T cells', 'pDC', 'pDC precursor'], dtype=object)
```

```python
model_low.cell_types
```

Output:
```text
array(['Age-associated B cells', 'Alveolar macrophages', 'B cells',
       'CD16+ NK cells', 'CD16- NK cells', 'CD8a/a', 'CD8a/b(entry)',
       'CMP', 'CRTAM+ gamma-delta T cells', 'Classical monocytes',
       'Cycling B cells', 'Cycling DCs', 'Cycling NK cells',
       'Cycling T cells', 'Cycling gamma-delta T cells',
       'Cycling monocytes', 'DC', 'DC precursor', 'DC1', 'DC2', 'DC3',
       'Double-negative thymocytes', 'Double-positive thymocytes', 'ELP',
       'ETP', 'Early MK', 'Early erythroid', 'Early lymphoid/T lymphoid',
       'Endothelial cells', 'Epithelial cells', 'Erythrocytes',
       'Erythrophagocytic macrophages', 'Fibroblasts',
       'Follicular B cells', 'Follicular helper T cells', 'GMP',
       'Germinal center B cells', 'Granulocytes', 'HSC/MPP',
       'Hofbauer cells', 'ILC', 'ILC precursor', 'ILC1', 'ILC2', 'ILC3',
       'Intermediate macrophages', 'Intestinal macrophages',
       'Kidney-resident macrophages', 'Kupffer cells',
       'Large pre-B cells', 'Late erythroid', 'MAIT cells', 'MEMP', 'MNP',
       'Macrophages', 'Mast cells', 'Megakaryocyte precursor',
       'Megakaryocyte-erythroid-mast cell progenitor',
       'Megakaryocytes/platelets', 'Memory B cells',
       'Memory CD4+ cytotoxic T cells', 'Mid erythroid', 'Migratory DCs',
       'Mono-mac', 'Monocyte precursor', 'Monocytes', 'Myelocytes',
       'NK cells', 'NKT cells', 'Naive B cells',
       'Neutrophil-myeloid progenitor', 'Neutrophils',
       'Non-classical monocytes', 'Plasma cells', 'Plasmablasts',
       'Pre-pro-B cells', 'Pro-B cells',
... (9 more lines)
```

Looks like the models include many different immune cell type progenitors!

Now let’s run the models. First the coarse one:

```python
predictions_high = celltypist.annotate(
    adata_celltypist, model=model_high, majority_voting=True
)
```

Transform the predictions to adata to get the full output...

```python
predictions_high_adata = predictions_high.to_adata()
```

...and copy the results to our original AnnData object:

```python
adata.obs["celltypist_cell_label_coarse"] = predictions_high_adata.obs.loc[
    adata.obs.index, "majority_voting"
]
adata.obs["celltypist_conf_score_coarse"] = predictions_high_adata.obs.loc[
    adata.obs.index, "conf_score"
]
```

Now the same for the finer annotations:

```python
predictions_low = celltypist.annotate(
    adata_celltypist, model=model_low, majority_voting=True
)
```

```python
predictions_low_adata = predictions_low.to_adata()
```

```python
adata.obs["celltypist_cell_label_fine"] = predictions_low_adata.obs.loc[
    adata.obs.index, "majority_voting"
]
adata.obs["celltypist_conf_score_fine"] = predictions_low_adata.obs.loc[
    adata.obs.index, "conf_score"
]
```

Now plot:

```python
sc.pl.umap(
    adata,
    color=["celltypist_cell_label_coarse", "celltypist_conf_score_coarse"],
    frameon=False,
    sort_order=False,
    wspace=1,
)
```

```python
sc.pl.umap(
    adata,
    color=["celltypist_cell_label_fine", "celltypist_conf_score_fine"],
    frameon=False,
    sort_order=False,
    wspace=1,
)
```

One way of getting a feeling for the quality of these annotations is by looking if the observed cell type similarities correspond to our expectations:

```python
sc.tl.dendrogram(
    adata,
    groupby="celltypist_cell_label_fine",
)

sc.pl.dendrogram(adata, groupby="celltypist_cell_label_fine")
```

Output:
```text
<Axes: >
```

This dendrogram shows us that the cells are well clustered with each other (e.g., B cells largely clustering together).
It is very important to check the automated annotation manually before simply taking them!

> **Cross-checking automated annotations with manual annotations**
> 
> Dendrograms often reveal unexpected patterns, such as a specific B cell subtype failing to cluster with other B cells.
> This discrepancy often suggests inaccurate automated labeling.
> 
> To diagnose these cases:
> 
> - Validate the clusters using alternative annotation sources or known marker genes.
> - Check confidence scores of the automated annotations. Low scores in “misplaced” clusters are a strong signal that manual intervention is required.
> 
> You can also take a look at the breakdown of a specific cluster to investigate:
> 
> ```
> pd.crosstab(adata.obs.leiden_1, adata.obs.celltypist_cell_label_fine).loc[
>     "8", :
> ].sort_values(ascending=False)
> ```
> 
> Automated annotations may only partially correspond to manual labels and can even be inconsistent between their own coarse and fine classifications.
> 
> This underlines that automated annotation algorithms should be used with caution and should be regarded as a starting point for annotating your data, rather than as a final annotation.
> Ultimately, expression of known marker genes is still the most accepted support for a cell type annotation.

### Large language models and foundation models

Large language models (LLMs) can propose cell type labels directly from the marker genes of each cluster without requiring a reference dataset (Hou & Ji, 2024 [16]).
Benchmarks found that large LLMs agree well with manual annotations of major cell types (Hou & Ji, 2024 [16]), (Crowley *et al.*, 2025 [17]), but agreement is lower for subtypes (Hou & Ji, 2024 [16]), differs substantially between models (Crowley *et al.*, 2025 [17]) and depends on how the input marker genes were selected (Xiao *et al.*, 2025 [18]).
As the training data of these models is undisclosed and they can hallucinate, LLM-based labels are best used as a quick first pass that must be checked against marker gene expression and reference annotations.
Since LLMs rely on previously described knowledge, labels for novel or context-specific cell states should be treated with particular caution.
Single-cell foundation models are also proposed for annotation, but independent evaluations found that their zero-shot embeddings separate cell types less consistently than highly variable genes, scVI or Harmony (Kedzierska *et al.*, 2025 [19]) and that a simple logistic regression performs comparably to a fine-tuned foundation model (Boiarsky *et al.*, 2024 [20]).
We therefore recommend the reference-based and marker-based approaches discussed in this chapter and regard LLMs and foundation models as, at most, an additional first pass.

### Annotation by mapping to a reference

A final way to annotate your data is based on mapping your data to an existing, annotated single-cell reference and then performing label transfer using the resulting joint embedding.
This reference can for example be a single sample that you annotated manually before, after which you would like to transfer those annotations to the rest of your dataset.
Alternatively, it can be a published and ideally well-curated existing reference. In this context we refer to the “new data”, i.e. the data to be mapped and annotated, as the “query”.

There are multiple existing methods that perform such “query-to-reference mapping”, including scArches (Lotfollahi *et al.*, 2022 [21]), Symphony (Kang *et al.*, 2021 [22]), and Azimuth (Seurat) (Hao *et al.*, 2021 [23]).
All of these methods enable you to map a new dataset to an existing reference without needing to reintegrate the data from the reference and without needing access to the full reference data.

As query-to-reference mapping involves embedding new data into an **existing** low-dimensional representation of the reference data, the dimensions and axes of that low-dimensional representation are largely pre-defined before learning from the query.
Therefore, learning and incorporating unseen variation that might be present in the query (both new biological variation, e.g. unseen cell types or states and new technical variation, i.e. unseen batch effects that need to be removed) can be a challenge for these models.
As a result, integration of the query data with the reference might not always be optimal and batch effects might not be fully removed from the joint query-reference embedding.
However, as cell type label transfer does not necessarily require perfect integration but merely close proximity of identical cell types in the embedding, even an imperfect mapping can still be extremely helpful in annotating your data.

We will be using cellmapper (Lange, 2025 [24]), specifically with scArches as the kernel method for reference-mapping-based label transfer to the new data ()“query”).
This takes as its basis an existing (variational autoencoder-based) model that embeds the reference data in a low-dimensional, batch-corrected space.
It then slightly extends that model to enable the mapping of an unseen dataset into the same “latent space” (i.e. the low-dimensional embedding).
This model extension also enables the learning and removal of batch effects present in the mapped dataset.

> **Warning**
> 
> Note that this reference-mapping step does not run, or runs very slowly if you do not have access to a GPU.
> You might therefore need to run this part of the notebook from a computing cluster/server.

Let’s start by preparing our data for the mapping to a reference.
scArches, the method that enables us to adapt an existing reference model to new data, requires raw, non-normalized counts.
We will therefore keep our counts layer and remove all other layers from our adata to map.
We will set our .X to those raw counts as well.

```python
adata_to_map = adata.copy()
for layer in list(adata_to_map.layers.keys()):
    if layer != "counts":
        del adata_to_map.layers[layer]
adata_to_map.X = adata_to_map.layers["counts"]
```

Moreover, it is important that we use the same input features (i.e. genes) as were used for training our reference model and that we put those features in the same order.
The reference model’s feature information is stored together with the model.
Let’s load the feature table.

```python
af = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="cellular_structure/annotation_reference_features.csv", is_latest=True
)
reference_model_features = af.load(index_col=0)
```

The table has both gene names and gene IDs.
As gene IDs are usually less subject to change over genome annotation versions, we will use those to subset our data.
We will therefore set our row names for both our adata and the reference model features to `gene_ids`.
Importantly, we have to make sure to also store the gene names for later use: these are much easier to understand than the gene IDs.

```python
adata_to_map.var["gene_names"] = adata_to_map.var.index
adata_to_map.var.set_index("gene_ids", inplace=True)
```

```python
reference_model_features["gene_names"] = reference_model_features.index
reference_model_features.set_index("gene_ids", inplace=True)
```

Now, let’s check if we have all the genes we need in our query data:

```python
print("Total number of genes needed for mapping:", reference_model_features.shape[0])
```

Output:
```text
Total number of genes needed for mapping: 4000
```

```python
print(
    "Number of genes found in query dataset:",
    adata_to_map.var.index.isin(reference_model_features.index).sum(),
)
```

Output:
```text
Number of genes found in query dataset: 3553
```

We are missing some genes.
These genes were detected in fewer than 20 cells and therefore removed during quality control, so we add them back with counts of 0.
Let’s create an AnnData object for those missing genes with only zero values (including our raw counts layer, which will be used for the mapping).
We will concatenate that to our own AnnData objects afterwards.

```python
missing_genes = [
    gene_id
    for gene_id in reference_model_features.index
    if gene_id not in adata_to_map.var.index
]
```

```python
missing_gene_adata = sc.AnnData(
    X=csr_matrix(np.zeros(shape=(adata.n_obs, len(missing_genes))), dtype="float32"),
    obs=adata.obs.iloc[:, :1],
    var=reference_model_features.loc[missing_genes, :],
)
missing_gene_adata.layers["counts"] = missing_gene_adata.X
```

Concatenate our original adata to the missing genes adata.
To make sure we can do this concatenation without errors, we’ll remove the PCA matrix from varm.

```python
if "PCs" in adata_to_map.varm.keys():
    del adata_to_map.varm["PCs"]
```

```python
adata_to_map_augmented = sc.concat(
    [adata_to_map, missing_gene_adata],
    axis=1,
    join="outer",
    index_unique=None,
    merge="unique",
)
```

Now subset to the genes used in the model and order correctly:

```python
adata_to_map_augmented = adata_to_map_augmented[
    :, reference_model_features.index
].copy()
```

Check if our adata gene names correspond exactly to the required gene order:

```python
bool((adata_to_map_augmented.var.index == reference_model_features.index).all())
```

Output:
```text
True
```

We can now set the gene indices back to gene names for easy interpretation:

```python
adata_to_map_augmented.var["gene_ids"] = adata_to_map_augmented.var.index
adata_to_map_augmented.var.set_index("gene_names", inplace=True)
```

Finally, this reference model used `adata.obs['batch']` as its batch variable, so we set it to the name of our sample:

```python
adata_to_map_augmented.obs["batch"] = "s4d8"
```

Now let’s talk about our reference model.
The better our reference model, the better our label transfer will perform.
Using well-annotated reference that integrates many different datasets and that matches your data well (same organ, same single-cell technology etc.) is ideal: such models are trained on a variety of datasets and batches and are therefore expected to be more robust to batch effects.
However, such references do not exist yet for all tissues.
For this tutorial we will use a reference model trained on the bone marrow samples that we have been using throughout the book, excluding the sample that we will be mapping.
The reference model is an scvi-model (used for data integration) that generates a low-dimensional, integrated embedding of the input data, see also the scvi-publication (Lopez *et al.*, 2018 [25]).
Note that this is a toy model generated for this tutorial and it should  not be used in other contexts.

We will start by patching things up for compatibility, because this model was built on previous version of pandas.

```python
sys.modules["pandas.core.indexes.numeric"] = pandas_indexes_base
pandas_indexes_base.Int64Index = pd.Index
pandas_indexes_base.Float64Index = pd.Index
```

Now, let’s load the model and pass it the adata which we want to map.

```python
af = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="cellular_structure/annotation_reference_model.pt", is_latest=True
)
annotation_ref_model_path = af.cache()

model_dir = Path("./reference_model")
model_dir.mkdir(parents=True, exist_ok=True)

shutil.copy(annotation_ref_model_path, model_dir / "model.pt")
```

Output:
```text
PosixPath('reference_model/model.pt')
```

```python
scvi.settings.seed = 0
query_model = scvi.model.SCVI.load_query_data(
    adata=adata_to_map_augmented,
    reference_model=str(model_dir),
    freeze_dropout=True,
)
```

Output:
```text
INFO     File reference_model/model.pt already downloaded                                                          
```

We will now update this reference model so that we can embed our own data (the “query”) in the same latent space as the reference. This requires training on our query data:

```python
query_model.train(max_epochs=500, plan_kwargs={"weight_decay": 0.0})
```

Output:
```text

Training:   0%|          | 0/500 [00:00<?, ?it/s]

Epoch 1/500:   0%|          | 0/500 [00:00<?, ?it/s]

Epoch 1/500:   0%|          | 1/500 [00:00<06:20,  1.31it/s]

Epoch 1/500:   0%|          | 1/500 [00:00<06:20,  1.31it/s, v_num=1, train_loss=913]

Epoch 2/500:   0%|          | 1/500 [00:00<06:20,  1.31it/s, v_num=1, train_loss=913]

Epoch 2/500:   0%|          | 2/500 [00:01<05:00,  1.66it/s, v_num=1, train_loss=913]

Epoch 2/500:   0%|          | 2/500 [00:01<05:00,  1.66it/s, v_num=1, train_loss=902]

Epoch 3/500:   0%|          | 2/500 [00:01<05:00,  1.66it/s, v_num=1, train_loss=902]

Epoch 3/500:   1%|          | 3/500 [00:01<04:27,  1.86it/s, v_num=1, train_loss=902]

Epoch 3/500:   1%|          | 3/500 [00:01<04:27,  1.86it/s, v_num=1, train_loss=896]

Epoch 4/500:   1%|          | 3/500 [00:01<04:27,  1.86it/s, v_num=1, train_loss=896]

Epoch 4/500:   1%|          | 4/500 [00:02<04:11,  1.97it/s, v_num=1, train_loss=896]

... (2979 more lines)
```

Now that we have updated the model, we can calculate the (ideally batch-corrected) latent representation of our query:

```python
adata.obsm["X_scVI"] = query_model.get_latent_representation()
```

We can now use this newly calculated low-dimensional embedding as a basis for visualization and clustering.
Let’s calculate the new UMAP using the scVI-based representation of the data.

```python
sc.pp.neighbors(adata, use_rep="X_scVI")
sc.tl.umap(adata)
```

To see if the mapping-based UMAP makes general sense, let’s look at a few markers and if their expression is localized to specific parts of the UMAP:

```python
sc.pl.umap(
    adata,
    color=["IGHD", "IGHM", "PRDM1"],
    vmin=0,
    vmax="p99",  # set vmax to the 99th percentile of the gene count instead of the maximum, to prevent outliers from making expression in other cells invisible. Note that this can cause problems for extremely lowly expressed genes.
    sort_order=False,  # do not plot highest expression on top, to not get a biased view of the mean expression among cells
    frameon=False,
    cmap="Reds",  # or choose another color map e.g. from here: https://matplotlib.org/stable/tutorials/colors/colormaps.html
)
```

Now the essential step is that we can combine the inferred latent space embedding of our query data with the existing reference embedding.
Using this joint embedding, we will not only be able to e.g., visualize and cluster the two together, but we can also do label transfer from the query to the reference.

Let’s load the reference embedding: this is often made publicly available with existing atlases.

```python
af = ln.Artifact.get(
    key="cellular_structure/annotation_reference_embedding.h5ad", is_latest=True
)
ref_emb = af.load(is_run_input=False)
```

We’ll store a variable specifying that these cells are from the reference.

```python
ref_emb.obs["reference_or_query"] = "reference"
```

Let’s see what’s in this reference object:

```python
ref_emb
```

Output:
```text
AnnData object with n_obs × n_vars = 86332 × 10
    obs: 'donor', 'batch', 'site', 'cell_type', 'reference_or_query'
    uns: 'neighbors', 'umap'
    obsm: 'X_umap'
    obsp: 'connectivities', 'distances'
    layers: None (.X)
```

As you can see it has only 10 dimensions (in `.X`) which together represent the latent space embedding of the reference cells.
Our query embedding that we calculated for our own data also has 10 dimensions.
The 10 dimensions of the reference and query are the same and can be combined!

Moreover, it has cell type labels in `.obs['cell_type']`.
We will use these labels to annotate our own data.

To perform the label transfer, we will first concatenate the reference and query data using the 10-dimensional embedding.
To get there, we will create the same type of AnnData object from our query data as we have from the reference (with the embedding under `.X`) and concatenate the two.
With that, we can jointly analyze reference and query including doing transfer from one to the other.

```python
adata_emb = sc.AnnData(X=adata.obsm["X_scVI"], obs=adata.obs)
```

```python
adata_emb.obs["reference_or_query"] = "query"
```

We will set the cell type labels in `.obs["cell_type"]` as `None`, so that we can see how we can annotate cell types based on the surroundings.

```python
adata_emb.obs["cell_type"] = None
```

```python
emb_ref_query = sc.concat(
    [ref_emb, adata_emb],
    axis=0,
    join="outer",
    index_unique=None,
    merge="unique",
)
```

Let’s visualize the joint embedding with a UMAP.

```python
sc.pp.neighbors(emb_ref_query)
sc.tl.umap(emb_ref_query)
```

We can visually get a first impression of whether the reference and query integrated well based on the UMAP:

```python
sc.pl.umap(
    emb_ref_query,
    color=["reference_or_query"],
    sort_order=False,
    frameon=False,
)
```

The (partial) mixing of query and reference in this UMAP is a good sign!
When mapping completely fails, you will often see a full separation of query and reference in the UMAP.

Now let’s look at the cell type annotations from the reference.
All cells from the query are set to NA here as they don’t have annotations yet and shown in black.

We’ll make this figure a bit bigger so that we can read the legend well:

```python
sc.set_figure_params(figsize=(8, 8))
```

```python
sc.pl.umap(
    emb_ref_query,
    color=["cell_type"],
    sort_order=False,
    frameon=False,
    legend_loc="on data",
    legend_fontsize=10,
    na_color="black",
)
```

As you can already tell from the UMAP, we can guess the cell type of each of our own cells (in black) by looking at which cell types from the reference surrounding it.
This is exactly what a nearest-neighbor-graph-based label transfer approach does: for each query cell it checks what is the most common cell type among its neighboring reference cells.
The higher the fraction of reference cells coming from a single cell type, the more confident the label transfer is.

Let’s perform the KNN-based label transfer.

First we set up the label transfer model:

```python
cmapper = CellMapper(query=adata_emb, reference=ref_emb)
cmapper.compute_neighbors(
    use_rep="X",  # location of our joint embedding
    n_neighbors=15,
)
```

Output:
```text
INFO     Initialized CellMapper with 13668 query cells and 86332 reference cells.                                  
WARNING  Using sklearn for neighbor search with large dataset (86332 cells). Consider using approximate k-NN search
         (e.g. pynndescent) or GPU acceleration (e.g. faiss or rapids)                                             
INFO     Using sklearn to compute 15 neighbors.                                                                    
```

Now we perform the label transfer:

```python
cmapper.compute_mapping_matrix(kernel_method="scarches")
cmapper.map_obs(
    key="cell_type",  # obs column name for which to transfer labels
    prediction_postfix="_pred",
    confidence_postfix="_conf",
)
```

Output:
```text
INFO     Computing mapping matrix using kernel method 'scarches'.                                                  
INFO     Mapping categorical data for key 'cell_type' using direct multiplication.                                 
INFO     Categorical data mapped and stored in query.obs['cell_type_pred'].                                        
```

And store the results in our adata:

```python
adata_emb.obs["transf_cell_type"] = adata_emb.obs["cell_type_pred"]
adata_emb.obs["transf_cell_type_unc"] = 1 - adata_emb.obs["cell_type_conf"]
```

Let’s transfer the results to our query adata object which also has our UMAP and gene counts, so that we can visualize all of those together.

```python
adata.obs.loc[adata_emb.obs.index, "transf_cell_type"] = adata_emb.obs[
    "transf_cell_type"
]
adata.obs.loc[adata_emb.obs.index, "transf_cell_type_unc"] = adata_emb.obs[
    "transf_cell_type_unc"
]
adata.obs["transf_cell_type_unc"] = adata.obs["transf_cell_type_unc"].astype(
    float
)  # ensure uncertainty is float, for compatibility with downstream plotting functions
```

We can now visualize the transferred labels in our previously calculated UMAP of our own data:

Let’s set the figure size smaller again:

```python
sc.set_figure_params(figsize=(5, 5))
```

```python
sc.pl.umap(adata, color="transf_cell_type", frameon=False)
```

Based on the neighbors of each of our query cells we can not only guess the cell type these cells belong to, but also generate a measure for certainty of that label: if a cell has neighbors from several different cell types, our guess will be highly uncertain.
This is relevant to assess to what extent we can “trust” the transferred labels!
Let’s visualize the uncertainty scores:

```python
sc.pl.umap(adata, color="transf_cell_type_unc", frameon=False)
```

Let’s check for each cell type label how high the label transfer uncertainty levels were.
This gives us a first impression of which annotations are more contentious/need more manual checks.

```python
fig, ax = plt.subplots(figsize=(8, 3))
ct_order = (
    adata.obs.groupby("transf_cell_type")
    .agg({"transf_cell_type_unc": "median"})
    .sort_values(by="transf_cell_type_unc", ascending=False)
)
sns.boxplot(
    adata.obs,
    x="transf_cell_type",
    y="transf_cell_type_unc",
    color="grey",
    ax=ax,
    order=ct_order.index,
)
ax.tick_params(rotation=90, axis="x")
```

You’ll notice that e.g. progenitor cells are often more difficult to distinguish than other cell types.
Same for the rather unspecific category “Other T” cells in our annotations.
Even for pDC, a cell type that is known to be quite transcriptionally distinct and therefore easier to recognize and label, the uncertainty of some cells is high.

To incorporate this uncertainty information in our transferred labels, we can set cells with an uncertainty score above e.g. 0.2 to “unknown”:

```python
adata.obs["transf_cell_type_certain"] = adata.obs.transf_cell_type.tolist()
adata.obs.loc[adata.obs.transf_cell_type_unc > 0.2, "transf_cell_type_certain"] = (
    "Unknown"
)
```

Let’s see what our annotations look like after this filtering.
Note the Unknown color in the legend and the UMAP.

```python
sc.pl.umap(adata, color="transf_cell_type_certain", frameon=False)
```

To ease legibility, we can color *only* the “unknown” cells.
This will make it easier for us to see how many of those there are.
You can do the same with any of the other cell type labels.

```python
sc.pl.umap(adata, color="transf_cell_type_certain", groups="Unknown")
```

There are quite many of them!
These cells will need particularly careful manual reviewing.
However, the low-uncertainty annotations surrounding the “unknown cells” will already give us a first idea of what cell type we can expect each cell to belong to.

Now let’s take a look at our more certain annotations.
We will check for a few cell types (chosen at random here) to what extent the reference-transferred annotation matches our known marker genes from above.
In reality, this should be done systematically for all annotations!

```python
cell_types_to_check = [
    "CD14+ Mono",
    "cDC2",
    "NK",
    "B1 B",
    "CD4+ T activated",
    "T naive",
    "MK/E prog",
]
```

Conveniently, for each of these cell types we have markers in our dictionary.
Let’s plot marker expression for all our newly annotated cell types.
You will notice that marker expression generally corresponds to the automated annotations, a good sign!

```python
sc.pl.dotplot(
    adata,
    var_names={
        ct: marker_genes_in_data[ct] for ct in cell_types_to_check
    },  # gene names grouped by cell type in a dictionary
    groupby="transf_cell_type_certain",
    standard_scale="var",  # normalize gene scores from 0 to 1
)
```

As you can see, the marker groups are generally most highly expressed in the cells annotated with the matching label.
This means these labels are likely (at least partially) correct!

Let’s go back one more time to our UMAP colored by uncertainty:

```python
sc.pl.umap(
    adata, color=["transf_cell_type_unc", "transf_cell_type_certain"], frameon=False
)
```

The uncertainty not only helps us identify regions where the algorithm is unsure which cell type a cell belongs to (e.g., because it falls between two annotated phenotypes), but can also highlight unseen cell types or new cell states.
For example, your reference might consist of healthy cells while your query could be from a diseased sample.
The uncertainty score can then highlight disease-specific cell states, as they might not have neighbors from the reference that consistently come from a single cell type.
Especially when your reference is based on a large dataset, the uncertainty score is useful for flagging parts of the query data that could be worth investigating.
Reference-based label transfer not only helps you annotate your data but can also speed up its exploration and interpretation.
However, as with any metric, these uncertainty scores are often imperfect and, in some cases, fail to highlight new cell types or states.
For a more extensive discussion of uncertainty metrics, see e.g. (Engelmann *et al.*, 2022 [26]).

Like with any of the methods discussed in this notebook, the quality of the transferred annotations depends on the quality of the “training data” (in this case the reference) and its annotations, the quality of the model, and the match of your own data with the training data!

The quality of the transferred annotations should therefore always be validated with manual inspection using marker gene expression and refinement of the initial annotations might be needed.

```python
# formatting the 'names' column as string, to prevent problems with saving to h5ad format
fields = adata.uns["dea_leiden_1_filtered"]["names"].dtype.names
for field in fields:
    adata.uns["dea_leiden_1_filtered"]["names"][field] = adata.uns[
        "dea_leiden_1_filtered"
    ]["names"][field].astype(str)

af = ln.Artifact.from_anndata(
    adata,
    key="cellular_structure/s4d8_annotated.h5ad",
    description="anndata after annotation",
).save()
af
```

Output:
```text
→ creating new artifact version for key 'cellular_structure/s4d8_annotated.h5ad' in storage 's3://lamin-eu-central-1/VPwcjx3CDAa2'

... uploading 7d6LdOoS4ZSxqQPw0009.h5ad:  0.0%

... uploading 7d6LdOoS4ZSxqQPw0009.h5ad:  6.5%

... uploading 7d6LdOoS4ZSxqQPw0009.h5ad: 25.9%

... uploading 7d6LdOoS4ZSxqQPw0009.h5ad: 64.8%

... uploading 7d6LdOoS4ZSxqQPw0009.h5ad: 67.6%

... uploading 7d6LdOoS4ZSxqQPw0009.h5ad: 74.1%

... uploading 7d6LdOoS4ZSxqQPw0009.h5ad: 87.0%
... uploading 7d6LdOoS4ZSxqQPw0009.h5ad: 100.0%
• replacing the existing cache path /home/lheumos/.cache/lamindb/lamin-eu-central-1/VPwcjx3CDAa2/cellular_structure/s4d8_annotated.h5ad
Artifact(uid='7d6LdOoS4ZSxqQPw0009', key='cellular_structure/s4d8_annotated.h5ad', description='anndata after annotation', suffix='.h5ad', kind='dataset', otype='AnnData', size=809408078, hash='VV_QyngqcJDzL5YJVCLElp', n_files=None, n_observations=13668, extra_data=None, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=158, schema_id=None, created_by_id=2, created_at=2026-09-29 13:11:56 UTC, is_locked=False, version_tag=None, is_latest=True)
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Lisa Sikkema
- Maren Büttner
- Seo H. Kim

### Reviewers

- Lukas Heumos

## References

1. Kadur Lakshminarasimha Murthy, P., Sontake, V., Tata, A., Kobayashi, Y., Macadlo, L., Okuda, K., Conchola, A. S., Nakano, S., Gregory, S., Miller, L. A., Spence, J. R., Engelhardt, J. F., Boucher, R. C., Rock, J. R., Randell, S. H., & Tata, P. R. (2022). Human distal lung maps and lineage hierarchies reveal a bipotent progenitor. *Nature*, *604*(7904), 111–119. https://doi.org/10.1038/s41586-022-04541-3
2. Wagner, A., Regev, A., & Yosef, N. (2016). Revealing the vectors of cellular identity with single-cell genomics. *Nature Biotechnology*, *34*(11), 1145–1160. https://doi.org/10.1038/nbt.3711
3. Zeng, H. (2022). What is a cell type and how to define it? *Cell*, *185*(15), 2739–2755. https://doi.org/10.1016/j.cell.2022.06.031
4. Traag, V. A., Waltman, L., & van Eck, N. J. (2019). From Louvain to Leiden: guaranteeing well-connected communities. *Scientific Reports*, *9*(1), 5233. https://doi.org/10.1038/s41598-019-41695-z
5. Pullin, J. M., & McCarthy, D. J. (2022). A comparison of marker gene selection methods for single-cell RNA sequencing data. *bioRxiv*. https://doi.org/10.1101/2022.05.09.490241
6. Zhang, J. M., Kamath, G. M., & Tse, D. N. (2019). Valid Post-clustering Differential Analysis for Single-Cell RNA-Seq. *Cell Systems*, *9*(4), 383-392.e6. https://doi.org/10.1016/j.cels.2019.07.012
7. Isola, I., Brasó-Maristany, F., Moreno, D. F., Mena, M.-P., Oliver-Calders, A., Paré, L., Rodríguez-Lobato, L. G., Martin-Antonio, B., Cibeira, M. T., Bladé, J., Rosiñol, L., Prat, A., Lozano, E., & Fernández De Larrea, C. (2021). Gene Expression Analysis of the Bone Marrow Microenvironment Reveals Distinct Immunotypes in Smoldering Multiple Myeloma Associated to Progression to Symptomatic Disease. *Frontiers in Immunology*, *12*, 792609. https://doi.org/10.3389/fimmu.2021.792609
8. Pasquini, G., Rojo Arias, J. E., Schäfer, P., & Busskamp, V. (2021). Automated methods for cell type annotation on scRNA-seq data. *Computational and Structural Biotechnology Journal*, *19*, 961–969. https://doi.org/10.1016/j.csbj.2021.01.015
9. Abdelaal, T., Michielsen, L., Cats, D., Hoogduin, D., Mei, H., Reinders, M. J. T., & Mahfouz, A. (2019). A comparison of automatic cell identification methods for single-cell RNA sequencing data. *Genome Biology*, *20*(1), 194. https://doi.org/10.1186/s13059-019-1795-z
10. Huang, Y., & Zhang, P. (2021). Evaluation of machine learning approaches for cell-type identification from single-cell transcriptomics data. *Briefings in Bioinformatics*. https://doi.org/10.1093/bib/bbab035
11. Sikkema, L., Ramírez-Suástegui, C., Strobl, D. C., Gillett, T. E., Zappia, L., Madissoon, E., Markov, N. S., Zaragosi, L.-E., Ji, Y., Ansari, M., Arguel, M.-J., Apperloo, L., Banchero, M., Bécavin, C., Berg, M., Chichelnitskiy, E., Chung, M.-I., Collin, A., Gay, A. C. A., … Theis, F. J. (2023). An integrated cell atlas of the lung in health and disease. *Nature Medicine*. https://doi.org/10.1038/s41591-023-02327-2
12. Pliner, H. A., Shendure, J., & Trapnell, C. (2019). Supervised classification enables rapid annotation of cell atlases. *Nature Methods*, *16*(10), 983–986. https://doi.org/10.1038/s41592-019-0535-3
13. Zhang, A. W., O’Flanagan, C., Chavez, E. A., Lim, J. L. P., Ceglia, N., McPherson, A., Wiens, M., Walters, P., Chan, T., Hewitson, B., Lai, D., Mottok, A., Sarkozy, C., Chong, L., Aoki, T., Wang, X., Weng, A. P., McAlpine, J. N., Aparicio, S., … Shah, S. P. (2019). Probabilistic cell-type assignment of single-cell RNA-seq for tumor microenvironment profiling. *Nature Methods*, *16*(10), 1007–1015. https://doi.org/10.1038/s41592-019-0529-1
14. Conde, C. D., Xu, C., Jarvis, L. B., Rainbow, D. B., Wells, S. B., Gomes, T., Howlett, S. K., Suchanek, O., Polanski, K., King, H. W., Mamanova, L., Huang, N., Szabo, P. A., Richardson, L., Bolt, L., Fasouli, E. S., Mahbubani, K. T., Prete, M., Tuck, L., … S. A. Teichmann. (2022). Cross-tissue immune cell analysis reveals tissue-specific features in humans. *Science*, *376*(6594), eabl5197. https://doi.org/10.1126/science.abl5197
15. Fu, R., Gillen, A. E., Sheridan, R. M., Tian, C., Daya, M., Hao, Y., Hesselberth, J. R., & Riemondy, K. A. (2020). clustifyr: an R package for automated single-cell RNA sequencing cluster classification. *F1000Research*, *9*, 223. https://doi.org/10.12688/f1000research.22969.2
16. Hou, W., & Ji, Z. (2024). Assessing GPT-4 for cell type annotation in single-cell RNA-seq analysis. *Nature Methods*, *21*(8), 1462–1465. https://doi.org/10.1038/s41592-024-02235-4
17. Crowley, G., Tabula Sapiens Consortium, & Quake, S. R. (2025). Benchmarking cell type and gene set annotation by large language models with AnnDictionary. *Nature Communications*, *16*(1), 9511. https://doi.org/10.1038/s41467-025-64511-x
18. Xiao, T., Hua, D., Wang, Y., Lu, X., & Zhang, C. (2025). Benchmarking large language models for cell typing in single-cell RNA-Seq. *Briefings in Bioinformatics*, *26*(6), bbaf677. https://doi.org/10.1093/bib/bbaf677
19. Kedzierska, K. Z., Crawford, L., Amini, A. P., & Lu, A. X. (2025). Zero-shot evaluation reveals limitations of single-cell foundation models. *Genome Biology*, *26*(1), 101. https://doi.org/10.1186/s13059-025-03574-x
20. Boiarsky, R., Singh, N. M., Buendia, A., Amini, A. P., Getz, G., & Sontag, D. (2024). Deeper evaluation of a single-cell foundation model. *Nature Machine Intelligence*, *6*(12), 1443–1446. https://doi.org/10.1038/s42256-024-00949-w
21. Lotfollahi, M., Naghipourfar, M., Luecken, M. D., Khajavi, M., Büttner, M., Wagenstetter, M., Avsec, Ž., Gayoso, A., Yosef, N., Interlandi, M., Rybakov, S., Misharin, A. V., & Theis, F. J. (2022). Mapping single-cell data to reference atlases by transfer learning. *Nature Biotechnology*, *40*(1), 121–130. https://doi.org/10.1038/s41587-021-01001-7
22. Kang, J. B., Nathan, A., Weinand, K., Zhang, F., Millard, N., Rumker, L., Moody, D. B., Korsunsky, I., & Raychaudhuri, S. (2021). Efficient and precise single-cell reference atlas mapping with Symphony. *Nature Communications*, *12*(1), 5890. https://doi.org/10.1038/s41467-021-25957-x
23. Hao, Y., Hao, S., Andersen-Nissen, E., Mauck, W. M., Zheng, S., Butler, A., Lee, M. J., Wilk, A. J., Darby, C., Zager, M., Hoffman, P., Stoeckius, M., Papalexi, E., Mimitou, E. P., Jain, J., Srivastava, A., Stuart, T., Fleming, L. M., Yeung, B., … Satija, R. (2021). Integrated analysis of multimodal single-cell data. *Cell*, *184*(13), 3573-3587.e29. https://doi.org/10.1016/j.cell.2021.04.048
24. Lange, M. (2025). *quadbio/cellmapper*. Zenodo. https://doi.org/10.5281/zenodo.15683594
25. Lopez, R., Regier, J., Cole, M. B., Jordan, M. I., & Yosef, N. (2018). Deep generative modeling for single-cell transcriptomics. *Nat. Methods*, *15*(12), 1053–1058.
26. Engelmann, J., Hetzel, L., Palla, G., Sikkema, L., Luecken, M., & Theis, F. (2022). *Uncertainty Quantification for Atlas-Level Cell Type Transfer*. arXiv. https://doi.org/10.48550/ARXIV.2211.03793
