# Fundamental data structures and frameworks

Source: https://www.sc-best-practices.org/introduction/fundamental-data-structures-and-frameworks  
Authors: Lukas Heumos, Luis Heinzlmeier, Isaac Virshup

**🧠 Key takeaways**

- Three major ecosystems exist for single-cell analysis: R-based Bioconductor and Seurat, and Python-based scverse.
- While all ecosystems are widely used, scverse is preferred for scalability (handling 500k+ cells) and strong interoperability with Python’s data and machine learning tools.
- AnnData is the core data structure of scverse.
It stores the count matrix in `.X` (cells × genes), with cell and gene annotations in `.obs` and `.var`.
- AnnData is designed for memory efficiency.
It supports sparse matrices, backed reading of large files, and view-based subsetting that avoids allocating new memory unless explicitly copied with `.copy()`.
- Scanpy is the primary analysis framework built on AnnData.
It provides a modular API (`sc.pp` for preprocessing, `sc.tl` for tools, `sc.pl` for plotting) covering the full workflow from basic quality control to dimensionality reduction and the many advanced analyses explored in later chapters.

**⚙️ Environment setup**

**yml:**

```yaml
name: fundamental_data_structures_and_frameworks
channels:
  - conda-forge
  - bioconda
dependencies:
  - conda-forge::anndata=0.12.7
  - conda-forge::python=3.13.12
  - conda-forge::scanpy=1.12
  - conda-forge::ipywidgets=8.1.8
  - pip
  - pip:
      - lamindb
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Single-cell analysis frameworks and consortia

After obtaining the count matrices, as described earlier, the exploratory data analysis phase begins.
While in the early days, people used to analyze their data with custom scripts, frameworks for precisely this purpose now exist.
The three most popular options are the R-based Bioconductor (Huber *et al.*, 2015 [1]) and Seurat (Hao *et al.*, 2021 [2]) ecosystems and the Python-based scverse (scverse, 2022 [3]) ecosystem.
These differ not only in the used programming languages but also in the underlying data structures and available specialized analysis tools.

Bioconductor is an open-source project for rigorous and reproducible biological data analysis, including single-cell.
Its greatest strengths are a homogeneous developer and user experience and extensive, user-friendly documentation.
Seurat is a well-regarded R package for single-cell analysis, covering all analysis steps including multimodal and spatial data.
It is known for its well-written vignettes and large user base.
Both R options can struggle with very large datasets (500k+ cells), which motivated the Python community to develop the scverse ecosystem.
Scverse is an organization dedicated to foundational life science tools, with an initial focus on single-cell.
Key advantages include scalability, extendability, and strong interoperability with Python’s data and machine learning ecosystem.

All three ecosystems are involved in many efforts to allow for interoperability of the involved frameworks.
This will be discussed in the [“Interoperability” chapter](../introduction/interoperability.md).
This book always focuses on the best tools for the corresponding question and will, therefore, use a mix of the above-mentioned ecosystems.
However, the basis of all analyses will be the scverse ecosystem for two reasons:

1. While we will regularly switch ecosystems and even programming languages throughout this book, consistent use of data structures and tooling helps readers focus on the concepts rather than implementation details.
2. [A great book on exclusively the Bioconductor ecosystem](https://bioconductor.org/books/release/OSCA/) already exists.
   We encourage users who only want to learn about single-cell analysis with Bioconductor to read it.

In the following sections, the scverse ecosystem will be introduced in more detail, and the key concepts will be explained with a focus on the most important data structures.
This chapter introduces the fundamental data structure AnnData and the scanpy framework (see the Scverse ecosystem overview figure).
The [following chapter](../introduction/advanced-data-structures-and-frameworks.md) introduces MuData and muon for multimodal data, and the [spatial data structures chapter](../spatial/data-structures.md) introduces SpatialData and Squidpy.
This introduction cannot cover all aspects of the data structures and frameworks.
We refer to the respective frameworks’ tutorials and documentation where required.

![Scverse ecosystem overview](https://www.sc-best-practices.org/build/fundamental_data_str-b6b76a16b154874b3d45597154280471.png)

*Figure 1: Scverse ecosystem overview highlighting the libraries of this chapter.
The publication date by a scientific journal is shown in brackets. We have obtained the symbols of the libraries from the corresponding Github pages (Virshup *et al.*, 2021 [4]; Wolf *et al.*, 2018 [5]; Bredikhin *et al.*, 2022 [6]; Palla *et al.*, 2022 [7]; Marconato *et al.*, 2025 [8]).*

## Storing unimodal data with AnnData

As previously discussed, genomics data is typically summarized into a feature matrix after alignment and gene [annotation](../glossary.md#term-annotation).
This matrix will be of the shape `number_observations x number_variables`.
In scRNA-seq, observations are cellular barcodes, and the variables are annotated genes.
Throughout the analysis, the observations and variables of this matrix are annotated with computationally derived measurements (e.g., quality control metrics or latent space embeddings) and prior knowledge (e.g., source donor or alternative gene identifier).
In the scverse ecosystem, [AnnData](../glossary.md#term-anndata) (Virshup *et al.*, 2021 [4]) is used to associate the data matrix with these annotations.
To allow for fast and memory-efficient transformations, AnnData also supports [sparse matrices](../glossary.md#term-sparse-matrix) and partial reading.

While AnnData is broadly similar to data structures from the R ecosystems (e.g., [Bioconductor’s SummarizedExperiment](https://bioconductor.org/packages/release/bioc/html/SummarizedExperiment.html) or [Seurat’s object](https://satijalab.github.io/seurat-object/)), R packages use a transposed feature matrix.

At its core, an AnnData object stores a sparse or dense matrix (the count matrix in the case of scRNA-Seq) in `X`.
This matrix has the dimensions of `obs_names x var_names` where the obs (=observations) correspond to the cells’ barcodes and the var (=variables) correspond to the gene identifiers.
This matrix `X` is surrounded by Pandas DataFrames `obs` and `var`, which save annotations of cells and genes, respectively.
Further, AnnData saves whole matrices of calculations for the observations (`obsm`) or variables (`varm`) with the corresponding dimensions.
Graph-like structures that associate cells with cells or genes with genes are usually saved in `obsp` and `varp`.
Any other unstructured data which does not fit any other slot is saved as unstructured data in `uns`.
It is further possible to store more values of `X` in `layers`.
Use cases for this are, for example, the storage of raw, unnormalized count data in a `counts` layer and the normalized data in the unnamed default layer.
AnnData is primarily designed for unimodal (for example, just scRNA-Seq) data.
However, extensions of AnnData, such as [MuData](../glossary.md#term-mudata), which is covered in the [next chapter](../introduction/advanced-data-structures-and-frameworks.md), allow for the efficient storage and access of multimodal data.

![AnnData Overview](https://www.sc-best-practices.org/build/anndata-49e760f9efbc6aa4e065f30ce9c33793.jpg)

*Figure 2: AnnData overview. Image obtained from (Virshup *et al.*, 2021 [4]).*

### Installation

AnnData is available on [PyPI](../glossary.md#term-python-package-index-pypi) and Conda.
It can be installed using either of the following commands.

```bash
pip install anndata
conda install -c conda-forge anndata
```

### Initializing an AnnData object

This section is inspired by [AnnData’s “getting started” tutorial](https://anndata.readthedocs.io/en/latest/tutorials/notebooks/getting-started.html).
Let us create a simple AnnData object with [sparse](../glossary.md#term-sparse-data) count information, which may, for example, represent gene expression counts.
First, we import the required packages.

```python
import warnings

warnings.filterwarnings("ignore")
```

```python
import anndata as ad
import lamindb as ln
import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix

ln.connect("theislab/sc-best-practices")

ln.track("zmuES9DakbmX")
```

Output:
```text
→ loaded Transform('zmuES9DakbmX0000', key='fundamental_data_structures_and_frameworks.ipynb'), re-started Run('pVMXOM3UaklSn6tp') at 2026-02-27 12:11:51 UTC
→ notebook imports: anndata==0.12.7 lamindb==2.0.1 numpy==2.3.5 pandas==2.3.3 scanpy==1.11.5 scipy==1.16.3
• recommendation: to identify the notebook across renames, pass the uid: ln.track("zmuES9DakbmX")
```

As a next step, we initialize an AnnData object with random [Poisson distributed](../glossary.md#term-poisson-distribution) data.
It is an unwritten rule to name the primary AnnData object of the analysis `adata`.

```python
counts = csr_matrix(
    np.random.default_rng().poisson(1, size=(100, 2000)), dtype=np.float32
)
adata = ad.AnnData(counts)
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 100 × 2000
```

The obtained AnnData object has 100 observations and 2000 variables.
This would correspond to 100 cells with 2000 genes.
The initial data we passed are accessible as a sparse matrix using `adata.X`.

```python
adata.X
```

Output:
```text
<Compressed Sparse Row sparse matrix of dtype 'float32'
	with 126197 stored elements and shape (100, 2000)>
```

Now, we provide the index to both the `obs` and `var` axes using `.obs_names` and `.var_names`, respectively.

```python
adata.obs_names = [f"Cell_{i:d}" for i in range(adata.n_obs)]
adata.var_names = [f"Gene_{i:d}" for i in range(adata.n_vars)]
print(adata.obs_names[:10])
```

Output:
```text
Index(['Cell_0', 'Cell_1', 'Cell_2', 'Cell_3', 'Cell_4', 'Cell_5', 'Cell_6',
       'Cell_7', 'Cell_8', 'Cell_9'],
      dtype='object')
```

### Adding aligned metadata

#### Observational or variable level

The core of our AnnData object is now in place.
As a next step, we add metadata at both the observational and variable levels.
Remember, we store such annotations in the `.obs` and `.var` slots of the AnnData object for cell and gene annotations, respectively.

```python
ct = np.random.default_rng().choice(["B", "T", "Monocyte"], size=(adata.n_obs,))
adata.obs["cell_type"] = pd.Categorical(ct)  # Categoricals are preferred for efficiency
adata.obs
```

If we examine the representation of the AnnData object again now, we will notice that it was updated with the `cell_type` information in `obs` as well.

```python
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'cell_type'
```

#### Subsetting using metadata

We can also subset the AnnData object with the randomly generated cell types.
The slicing and masking of the AnnData object behaves similarly to the data access in Pandas DataFrames or R matrices.
More details on this can be found below.

```python
bdata = adata[adata.obs.cell_type == "B"]
bdata
```

Output:
```text
View of AnnData object with n_obs × n_vars = 40 × 2000
    obs: 'cell_type'
```

### Observation/variable-level matrices

We might also have metadata at either level with many dimensions, such as a [UMAP](../glossary.md#term-uniform-manifold-approximation-and-projection-umap) embedding of the data.
AnnData has the `.obsm/.varm` attributes for this type of metadata.
We use keys to identify the different matrices we insert.
The restriction of `.obsm/.varm` is that `.obsm` matrices must have a length equal to the number of observations as `.n_obs` and `.varm` matrices must have a length equal to `.n_vars`.
They can each independently have a different number of dimensions.

Let us start with a randomly generated matrix that we can interpret as a UMAP embedding of the data we would like to store, as well as some random gene-level metadata.

```python
adata.obsm["X_umap"] = np.random.default_rng().normal(0, 1, size=(adata.n_obs, 2))
adata.varm["gene_stuff"] = np.random.default_rng().normal(0, 1, size=(adata.n_vars, 5))
adata.obsm
```

Output:
```text
AxisArrays with keys: X_umap
```

Again, the AnnData representation is updated.

```python
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'cell_type'
    obsm: 'X_umap'
    varm: 'gene_stuff'
```

A few more notes about `.obsm/.varm`:

1. The “array-like” metadata can originate from a Pandas DataFrame, scipy sparse matrix, or numpy dense array.
2. When using scanpy, their values (columns) are not easily plotted, whereas items from `.obs` are easily plotted on, e.g., UMAP plots.

### Unstructured metadata

As mentioned above, AnnData has `.uns`, which allows for any unstructured metadata.
This can be anything, like a list or a dictionary, with some general information that was useful in the analysis of our data.
Try only using this slot for data that cannot be efficiently stored in the other slots.

```python
adata.uns["random"] = [1, 2, 3]
adata.uns
```

Output:
```text
OrderedDict([('random', [1, 2, 3])])
```

### Layers

Finally, we may have different forms of our original core data, perhaps one that is normalized and one that is not.
These can be stored in different layers in AnnData.
For example, let us log transform the original data and store it in a layer.

```python
adata.layers["log_transformed"] = np.log1p(adata.X)
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'cell_type'
    uns: 'random'
    obsm: 'X_umap'
    varm: 'gene_stuff'
    layers: 'log_transformed'
```

Our original matrix `X` was not modified and is still accessible.
We can verify this by comparing the original `X` to the new layer (`.nnz` returns number of non-zero elements in the boolean matrix).

```python
(adata.X != adata.layers["log_transformed"]).nnz == 0
```

Output:
```text
False
```

### Conversion to DataFrames

It is possible to obtain a Pandas DataFrame from one of the layers.

```python
with pd.option_context("display.max_columns", 10):
    display(adata.to_df(layer="log_transformed"))
```

### Reading and writing of AnnData objects

AnnData objects can be saved on disk to hierarchical array stores like [HDF5](https://en.wikipedia.org/wiki/Hierarchical_Data_Format) or [Zarr](https://zarr.readthedocs.io/en/stable/index.html) to enable similar structures in disk and on memory.
AnnData comes with its own persistent HDF5-based file format: `h5ad`.
If string columns with a few categories are not yet categorical, AnnData will auto-transform them to categorical. We will now save our AnnData object in `h5ad` format.

```python
adata.write("my_results.h5ad", compression="gzip")
```

... and read it back in.

```python
adata_new = ad.read_h5ad("my_results.h5ad")
adata_new
```

Output:
```text
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'cell_type'
    uns: 'random'
    obsm: 'X_umap'
    varm: 'gene_stuff'
    layers: 'log_transformed'
```

### Efficient data access

#### View and copies

For the fun of it, let us look at another metadata use case.
Imagine that the observations come from instruments characterizing 10 readouts in a multi-year study with samples taken from different subjects at different sites.
We would typically get that information in some format and then store it in a DataFrame:

```python
obs_meta = pd.DataFrame(
    {
        "time_yr": np.random.default_rng().choice([0, 2, 4, 8], adata.n_obs),
        "subject_id": np.random.default_rng().choice(
            ["subject 1", "subject 2", "subject 4", "subject 8"], adata.n_obs
        ),
        "instrument_type": np.random.default_rng().choice(
            ["type a", "type b"], adata.n_obs
        ),
        "site": np.random.default_rng().choice(["site x", "site y"], adata.n_obs),
    },
    index=adata.obs.index,  # these are the same IDs of observations as above!
)
```

This is how we join the readout data with the metadata.
Of course, the first argument of the following call for `X` could also just be a DataFrame.
This will result in a single data container that tracks everything.

```python
adata = ad.AnnData(adata.X, obs=obs_meta, var=adata.var)
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'time_yr', 'subject_id', 'instrument_type', 'site'
```

Subsetting the joint data matrix can be important to focus on subsets of variables or observations, or to define train-test splits for a machine learning model.

Similar to numpy arrays, AnnData objects can either hold actual data or reference another `AnnData` object.
In the latter case, they are referred to as “view”.
Subsetting AnnData objects always returns views, which has two advantages:

- No new memory is allocated.
- It is possible to modify the underlying AnnData object.

You can get an actual AnnData object from a view by calling `.copy()` on the view.
Usually, this is not necessary, as any modification of elements of a view (calling `.[]` on an attribute of the view) internally calls `.copy()` and makes the view an AnnData object that holds actual data.
See the example below.

```python
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'time_yr', 'subject_id', 'instrument_type', 'site'
```

Indexing into AnnData will assume that integer arguments to `[]` behave like `.iloc` in pandas, whereas string arguments behave like `.loc`.
`AnnData` always assumes string indices.

```python
adata_view = adata[:5, ["Gene_1", "Gene_3"]]
adata_view
```

Output:
```text
View of AnnData object with n_obs × n_vars = 5 × 2
    obs: 'time_yr', 'subject_id', 'instrument_type', 'site'
```

This is a view! This can be verified by examining the AnnData object again.

```python
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'time_yr', 'subject_id', 'instrument_type', 'site'
```

The dimensions of the AnnData object have not changed. It still contains the same data.
If we want an AnnData that holds the data in memory, we must call it `.copy()`.

```python
adata_subset = adata[:5, ["Gene_1", "Gene_3"]].copy()
adata_subset
```

Output:
```text
AnnData object with n_obs × n_vars = 5 × 2
    obs: 'time_yr', 'subject_id', 'instrument_type', 'site'
```

For a view, we can also set the first three elements of a column.

```python
print(adata[:3, "Gene_1"].X.toarray().tolist())
adata[:3, "Gene_1"].X = [0, 0, 0]
print(adata[:3, "Gene_1"].X.toarray().tolist())
```

Output:
```text
[[1.0], [1.0], [2.0]]
[[0.0], [0.0], [0.0]]
```

If you try to access parts of a view of an AnnData, the content will be auto-copied and a data-storing object will be generated.

```python
adata_subset = adata[:3, ["Gene_1", "Gene_2"]]
adata_subset
```

Output:
```text
View of AnnData object with n_obs × n_vars = 3 × 2
    obs: 'time_yr', 'subject_id', 'instrument_type', 'site'
```

```python
adata_subset.obs["foo"] = range(3)
```

Now `adata_subset` stores the actual data and is no longer just a reference to adata.

```python
adata_subset
```

Output:
```text
AnnData object with n_obs × n_vars = 3 × 2
    obs: 'time_yr', 'subject_id', 'instrument_type', 'site', 'foo'
```

Evidently, you can use all of pandas to slice with sequences or boolean indices.

```python
adata[adata.obs.time_yr.isin([2, 4])].obs.head()
```

#### Partial reading of large data

If a single `h5ad` file is very large, you can partially read it into memory by using backed mode.

```python
adata = ad.read_h5ad("my_results.h5ad", backed="r")
```

```python
adata.isbacked
```

Output:
```text
True
```

If you do this, you will need to remember that the AnnData object has an open connection to the file used for reading.

```python
adata.filename
```

Output:
```text
PosixPath('my_results.h5ad')
```

As we are using it in read-only mode, we cannot damage anything.
To proceed with this tutorial, we still need to explicitly close it.

```python
adata.file.close()
```

## Unimodal data analysis with scanpy

Now that we understand the fundamental data structure of unimodal single-cell analysis, the question remains: How can we actually analyze the stored data?
In the scverse ecosystem, several tools exist for analyzing specific omics data.
For example, scanpy (Wolf *et al.*, 2018 [5]) provides tooling for general RNA-Seq-focused analysis, squidpy (Palla *et al.*, 2022 [7]) focuses on spatial transcriptomics, and scirpy (Sturm *et al.*, 2020 [9]) provides tooling for the analysis of T-cell receptor (TCR) and B-cell receptor (BCR) data.
Even though many scverse extensions for various data modalities exist, they usually use some of scanpy’s preprocessing and visualization capabilities to some extent.

More specifically, scanpy is a Python package that builds on top of AnnData to facilitate the analysis of single-cell gene expression data.
Several methods for preprocessing, embedding, visualization, clustering, [differential gene expression](../glossary.md#term-differential-gene-expression-dge) testing, pseudotime and trajectory inference, and simulation of gene regulatory networks are accessible through scanpy.
The efficient implementation based on the Python data science and machine learning libraries allows scanpy to scale to millions of cells.
Generally, best-practice single-cell data analysis is an interactive process.
Many of the decisions and analysis steps depend on the results of previous steps and the potential input of experimental partners.
Pipelines such as scflow (Khozoie *et al.*, 2021 [10]) entirely automate some downstream analysis steps.
These pipelines have to make assumptions and simplifications, which may not result in the most robust analysis.
Scanpy is therefore designed for interactive analyses with, for example, Jupyter Notebooks (Jupyter, 2022 [11]).

![scanpy Overview](https://www.sc-best-practices.org/build/scanpy-cde2e42cfca2a3afee498c87a0592074.jpg)

*Figure 3: Scanpy overview. Image obtained from (Wolf *et al.*, 2018 [5]).*

### Installation

Scanpy is available on PyPI and Conda.
It can be installed using either of the following commands.

```bash
pip install scanpy
conda install -c conda-forge scanpy
```

### Scanpy API design

The scanpy framework is designed in a way that functions belonging to the same step are grouped into corresponding modules.
For example, all preprocessing functions are available in the `scanpy.preprocessing` module, all transformations of a data matrix that are not preprocessing are available in `scanpy.tools`, and all visualizations are available in `scanpy.plot`.
These modules are commonly accessed after having imported scanpy like `import scanpy as sc` with the corresponding abbreviations `scanpy.pp` for preprocessing, `scanpy.tl` for tools, and `scanpy.pl` for plots.
All modules which read or write data are directly accessed.
Further, a module for various datasets is available as `scanpy.datasets`.
All functions with corresponding parameters and potential example plots are documented in the scanpy API documentation (scverse, 2022 [12]).

Note that this tutorial only covers a tiny subset of scanpy’s features and options.
Readers are strongly encouraged to examine [scanpy’s documentation](https://scanpy.readthedocs.io/) for more details.

![scanpy API](https://www.sc-best-practices.org/build/scanpy_api-475a8a1535bd0e97eef52a2b8d5f2eda.png)

*Figure 4: Scanpy API overview. The API is divided into datasets, preprocessing (pp), tools (tl) and corresponding plotting (pl) functions.*

### Scanpy example

In the following cells we will shortly demonstrate the workflow of an analysis with scanpy.
We explicitly do not conduct a full analysis because the specific analysis steps are covered in the corresponding chapters.

As a first step we import scanpy and define defaults for our following quick scanpy demo.
We use scanpy’s setting object to  set the Matplotlib plotting defaults for all of scanpy’s plots and finally print scanpy’s header.
This header contains the versions of all relevant Python packages in the current environment including scanpy and AnnData.
This output is especially useful when reporting bugs to the scverse team and for reproducibility reasons.

```python
import scanpy as sc

sc.settings.set_figure_params(dpi=80, facecolor="white")
sc.logging.print_header()
```

The dataset of choice is a dataset of 2700 peripheral blood mononuclear cells of a healthy donor which were sequenced on the Illumina NextSeq 500.
We can load the dataset from `lamindb`, although it is also available via `scanpy.datasets.pbmc3k()`.

```python
adata = ln.Artifact.get(
    key="introduction/fundamental_data_structures_and_frameworks.h5ad", is_latest=True
).load()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 2700 × 32738
    var: 'gene_ids'
```

The returned AnnData object has 2700 cells with 32738 genes.
The `var` slot further contains the gene IDs.

```python
adata.var
```

As mentioned above, all of scanpy’s analysis functions are accessible via `sc.[pp, tl, pl]`.
As a first step to get an overview over our data, we use scanpy to show those genes that yield the highest fraction of counts in each single cell, across all cells.
We simply call the `scanpy.pl.highest_expr_genes` function, pass the AnnData object which is in pretty much all cases the first parameter of any scanpy function, and specify that we want the top 20 expressed genes to be shown.

```python
sc.pl.highest_expr_genes(adata, n_top=20)
```

Apparently, *MALAT1* is the most expressed gene which is frequently detected in poly-A captured scRNA-Seq data, independent of protocol.
This gene has been shown to have an inverse correlation with cell health.
Especially dead/dying cells have a higher expression of *MALAT1*.

We now filter cells with less than 200 detected genes and genes which were found in less than 3 cells for a rough quality threshold with scanpy’s preprocessing module.

```python
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)
```

A common step in single-cell RNA-Seq analysis is dimensionality reduction with for example PCA to unveil the main axes of variation.
This also denoises the data.
Scanpy offers PCA as a `preprocessing` or `tools` function.
These are equivalent.
Here, we use the version in `tools` for no particular reason.

```python
sc.tl.pca(adata, svd_solver="arpack")
```

The corresponding plotting function allows us to pass genes to the color argument.
The corresponding values are automatically extracted from the AnnData object.

```python
sc.pl.pca(adata, color="CST3")
```

A fundamental step for any advanced embedding and downstream calculations is the calculating of the neighborhood graph using the PCA representation of the data matrix.
It is automatically used for other tools that require it such as the calculation of a UMAP.

```python
sc.pp.neighbors(adata, n_neighbors=10, n_pcs=40)
```

We now use the calculating neighborhood graph to embed the cells with a UMAP, one of many advanced dimension reduction [algorithms](../glossary.md#term-algorithm) implemented in scanpy.

```python
sc.tl.umap(adata)
```

```python
sc.pl.umap(adata, color=["CST3", "NKG7", "PPBP"])
```

Scanpy’s documentation also provides [tutorials](https://scanpy.readthedocs.io/en/stable/tutorials.html) which we recommend to all readers who need a refresher of scanpy or are new to scanpy.
Video tutorials are available on the [scverse youtube channel](https://www.youtube.com/channel/UCpsvsIAW3R5OdftJKKuLNMA).

## Questions

### Flipcards

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q1",
        "What is the fundamental data structure for single-cell analysis in the scverse?",
        "AnnData",
    )

    flip_card(
        "q2",
        "What is the fundamental framework for single-cell analysis in the scverse?",
        "Scanpy",
    )

    flip_card(
        "q3",
        "In single-cell RNA-seq data, which dimensions correspond to genes and cells?",
        "Genes are stored in `.var` (columns), and cells are stored in `.obs` (rows) of the matrix.",
    )
```

### Multiple-choice questions

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    multiple_choice_question(
        question_id="q4",
        question="What is a common limitation of the R-based frameworks Bioconductor and Seurat?",
        options=[
            "Inability to store gene annotations",
            "Lack of preprocessing functions",
            "Scalability issues with more than ~500,000 cells",
            "Lack of comprehensive documentation",
        ],
        correct_answer="Scalability issues with more than ~500,000 cells",
        explanations={},
    )

    multiple_choice_question(
        question_id="q3a",
        question="In an AnnData object, which slot stores the main count matrix for scRNA-seq data?",
        options=["X", "obs", "var", "uns"],
        correct_answer="X",
        explanations={
            "obs": "`.obs` stores cell-level metadata (observations), not the main count matrix.",
            "var": "`.var` stores gene-level metadata (variables), not the expression matrix itself.",
            "uns": "`.uns` stores unstructured metadata.",
        },
    )

    multiple_choice_question(
        question_id="q3b",
        question="Where would you store additional matrices derived from the main data, such as normalized counts or log-transformed values, in an AnnData object?",
        options=["layers", "obsm", "varp", "uns"],
        correct_answer="layers",
        explanations={
            "obsm": "`.obsm` stores matrices of calculations for the observations, such as PCA or UMAP embeddings.",
            "varp": "`.varp` stores graph-like structures that associate genes with genes.",
            "uns": "`.uns` stores unstructured metadata.",
        },
    )
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Lukas Heumos
- Luis Heinzlmeier

### Reviewers

- Isaac Virshup

## References

1. Huber, W., Carey, V. J., Gentleman, R., Anders, S., Carlson, M., Carvalho, B. S., Bravo, H. C., Davis, S., Gatto, L., Girke, T., Gottardo, R., Hahne, F., Hansen, K. D., Irizarry, R. A., Lawrence, M., Love, M. I., MacDonald, J., Obenchain, V., Oleś, A. K., … Morgan, M. (2015). Orchestrating high-throughput genomic analysis with Bioconductor. *Nature Methods*, *12*(2), 115–121. https://doi.org/10.1038/nmeth.3252
2. Hao, Y., Hao, S., Andersen-Nissen, E., III, W. M. M., Zheng, S., Butler, A., Lee, M. J., Wilk, A. J., Darby, C., Zagar, M., Hoffman, P., Stoeckius, M., Papalexi, E., Mimitou, E. P., Jain, J., Srivastava, A., Stuart, T., Fleming, L. B., Yeung, B., … Satija, R. (2021). Integrated analysis of multimodal single-cell data. *Cell*. https://doi.org/10.1016/j.cell.2021.04.048
3. scverse. (2022). *scverse*. https://scverse.org
4. Virshup, I., Rybakov, S., Theis, F. J., Angerer, P., & Wolf, F. A. (2021). anndata: Annotated data. *bioRxiv*. https://doi.org/10.1101/2021.12.16.473007
5. Wolf, F. A., Angerer, P., & Theis, F. J. (2018). SCANPY: large-scale single-cell gene expression data analysis. *Genome Biology*, *19*(1), 15. https://doi.org/10.1186/s13059-017-1382-0
6. Bredikhin, D., Kats, I., & Stegle, O. (2022). MUON: multimodal omics analysis framework. *Genome Biology*, *23*(1), 42. https://doi.org/10.1186/s13059-021-02577-8
7. Palla, G., Spitzer, H., Klein, M., Fischer, D., Schaar, A. C., Kuemmerle, L. B., Rybakov, S., Ibarra, I. L., Holmberg, O., Virshup, I., Lotfollahi, M., Richter, S., & Theis, F. J. (2022). Squidpy: a scalable framework for spatial omics analysis. *Nature Methods*, *19*(2), 171–178. https://doi.org/10.1038/s41592-021-01358-2
8. Marconato, L., Palla, G., Yamauchi, K. A., Virshup, I., Heidari, E., Treis, T., Vierdag, W.-M., Toth, M., Stockhaus, S., Shrestha, R. B., Rombaut, B., Pollaris, L., Lehner, L., Vöhringer, H., Kats, I., Saeys, Y., Saka, S. K., Huber, W., Gerstung, M., … Stegle, O. (2025). SpatialData: an open and universal data framework for spatial omics. *Nature Methods*, *22*(1), 58–62. https://doi.org/10.1038/s41592-024-02212-x
9. Sturm, G., Szabo, T., Fotakis, G., Haider, M., Rieder, D., Trajanoski, Z., & Finotello, F. (2020). Scirpy: a Scanpy extension for analyzing single-cell T-cell receptor-sequencing data. *Bioinformatics*, *36*(18), 4817–4818. https://doi.org/10.1093/bioinformatics/btaa611
10. Khozoie, C., Fancy, N., Marjaneh, M. M., Murphy, A. E., Matthews, P. M., & Skene, N. (2021). scFlow: A Scalable and Reproducible Analysis Pipeline for Single-Cell RNA Sequencing Data. *bioRxiv*. https://doi.org/10.1101/2021.08.16.456499
11. Jupyter, P. (2022). *Jupyter*. https://jupyter.org/
12. scverse. (2022). *Scanpy API*. https://scanpy.readthedocs.io/en/stable/api/index.html
