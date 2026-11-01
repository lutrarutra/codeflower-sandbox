# Interoperability

Source: https://www.sc-best-practices.org/introduction/interoperability  
Authors: Luke Zappia, Seo H. Kim, Lukas Heumos, Isaac Virshup, Anastasia Litinetskaya, Ludwig Geistlinger, Peter Hickey

**🧠 Key takeaways**

- Interoperabilty between languages allows analysts to take advantage of the strengths of different ecosystems.
- On-disk interoperability uses standard file formats to transfer data and is typically more reliable.
- In-memory interoperabilty transfers data directly between parallel sessions and is convenient for interactive analysis.
- While interoperability is currently possible developers continue to improve the experience.

**⚙️ Environment setup**

**yml:**

```yaml
name: interoperability
channels:
  - conda-forge
  - bioconda
  - defaults
dependencies:
  - conda-forge::python=3.12.9
  - conda-forge::scanpy=1.11.0
  - anndata2ri=1.3.2
  - bioconductor-basilisk=1.14.1
  - bioconductor-mudata=1.6.0
  - bioconductor-scuttle=1.12.0
  - bioconductor-singlecellexperiment=1.24.0
  - bioconductor-zellkonverter=1.12.1
  - mudata=0.3.1
  - r-base=4.3.3
  - r-hdf5r=1.3.12
  - r-remotes=2.5.0
  - r-reticulate=1.40.0
  - r-sessioninfo=1.2.3
  - r-seurat=5.2.1
  - r-seuratobject=5.0.2
  - rpy2=3.5.11
  - session-info=1.0.0
  - pip
  - pip:
      - lamindb[bionty,jupyter]
  # Additional R packages installed manually using {remotes}
  # remotes::install_github("mojaveazure/seurat-disk@9b89970eac2a3bd770e744f63c7763419486b14c")
  # remotes::install_github("cellgeni/sceasy@v0.0.7")
  # remotes::install_github("PMBio/MuDataSeurat@e34e908")
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

As discussed in the [analysis frameworks and tools chapter](../introduction/fundamental-data-structures-and-frameworks.md), there are three main ecosystems for single-cell analysis: [Bioconductor](https://bioconductor.org/), [Seurat](https://satijalab.org/seurat/index.html), and the Python-based [scverse](https://scverse.org/).
A common question from new analysts is which ecosystem to focus on.
While it makes sense to start with one, and a successful analysis can be performed in any ecosystem, competent analysts should be familiar with all three and comfortable moving between them.
This allows analysts to always use the best-performing tools, regardless of their implementation.
Analysts who are not comfortable switching ecosystems often default to familiar packages, even when better alternatives exist elsewhere.
Flexibility across ecosystems also lets developers exploit the strengths of different languages.
R has strong built-in support for statistical modeling, while most deep-learning libraries target Python.
By supporting common on-disk formats and in-memory data structures, developers can ensure analysts access their packages on the most appropriate platform.
A further motivation for multi-ecosystem fluency is the accessibility of data, results, and documentation.
Data and results are often only available in one format, requiring familiarity with that ecosystem to access them.
A basic understanding of other ecosystems is also necessary to read documentation and tutorials when evaluating which methods to use.

While we encourage analysts to be comfortable with all the major ecosystems, moving between them is only possible when they are interoperable.
Thankfully, much work has been done in this area, and using standard packages is now relatively simple in most cases.
In this chapter, we discuss the various ways data can be moved between ecosystems via disk or memory, their differences, and their advantages.
We focus on single-modality data and moving between R and Python, as these are the most common cases, but we also touch on multimodal data and other languages.

We first import all required Python packages before going through the chapter.

```python
import tempfile
from pathlib import Path

import anndata2ri
import lamindb as ln
import rpy2.robjects

%load_ext rpy2.ipython

ln.connect("theislab/sc-best-practices")

ln.track("QaILJZMpZyJ4")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ created Transform('QaILJZMpZyJ40000'), started new Run('1YEGroVZ...') at 2025-03-26 12:58:46 UTC
```

## Nomenclature

Because talking about different languages can get confusing we try to use the following conventions:

- **{package}** - An R package
- `package::function()` - A function in an R package
- **package** - A Python package
- `package.function()` - A function in a Python package
- **Emphasised** - Some other important concept
- `code` - Other parts of code including objects, variables etc. This is also used for files or directories.

## Disk-based interoperability

The first approach to moving between languages is via disk-based interoperability.
This involves writing a file to disk in one language and then reading that file into a second language.
In many cases, this approach is simpler, more reliable and scalable than in-memory interoperability (which we discuss below).
Still, it comes at the cost of greater storage requirements and reduced interactivity.
Disk-based interoperability tends to work particularly well when there are established processes for each stage of analysis and you want to pass objects from one to the next (especially as part of a pipeline developed using a workflow manager such as [Nextflow](https://www.nextflow.io/index.html) or [snakemake](https://snakemake.readthedocs.io/en/stable/)).
However, disk-based interoperability is less convenient for interactive steps such as data exploration or experimenting with methods, as you need to write a new file whenever you want to move between languages.

### Simple formats

Before discussing file formats specifically developed for single-cell data we want to briefly mention that common simple text file formats (such as CSV, TSV, JSON etc.) can often be the answer to transferring data between languages.
They work well in cases where some analysis has been performed, and what you want to transfer is a subset of the information about an experiment.
For example, you may want to transfer only the cell metadata but do not require the feature metadata, expression matrices etc.
The advantage of using simple text formats is that they are well supported by almost any language and do not require single-cell specific packages.
However, they can quickly become impractical as what you want to transfer becomes more complex.

### HDF5-based formats

[Hierarchical Data Format version 5](https://www.hdfgroup.org/solutions/hdf5/) (HDF5) is the most common open-source file format for storing single-cell data.
It is designed for large, complex, and heterogeneous datasets, using a directory-like structure similar to a computer’s file system.
This allows multiple types of data to be stored within a single file in an organized hierarchy. While HDF5 is highly flexible, interacting with it requires knowledge of how data is structured within the file.
To standardize this process, specific guidelines have been developed for storing single-cell data in HDF5 files.

#### H5AD

The H5AD format is the HDF5 disk representation of the `AnnData` object used by scverse packages and is commonly used to share single-cell datasets.
As it is part of the scverse ecosystem, reading and writing these files from Python is well-supported and is part of the core functionality of the [**anndata** package](https://anndata.readthedocs.io/en/latest/index.html) (read more about the format [here](https://anndata.readthedocs.io/en/latest/fileformat-prose.html)).

To demonstrate interoperability, we will load a small, randomly generated dataset that has gone through some of the steps of a standard analysis workflow to populate the various slots.

```python
af = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="introduction/interoperability_adata.h5ad", is_latest=True
)
adata = af.load()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'n_genes_by_counts', 'log1p_n_genes_by_counts', 'total_counts', 'log1p_total_counts', 'pct_counts_in_top_50_genes', 'pct_counts_in_top_100_genes', 'pct_counts_in_top_200_genes', 'pct_counts_in_top_500_genes'
    var: 'n_cells_by_counts', 'mean_counts', 'log1p_mean_counts', 'pct_dropout_by_counts', 'total_counts', 'log1p_total_counts', 'highly_variable', 'means', 'dispersions', 'dispersions_norm'
    uns: 'hvg', 'log1p', 'neighbors', 'pca', 'umap'
    obsm: 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts'
    obsp: 'connectivities', 'distances'
```

We will write this mock object to disk as a H5AD file to demonstrate how those files can be read from R.

```python
temp_dir = tempfile.TemporaryDirectory()
h5ad_file = str(Path(temp_dir.name) / "example.h5ad")

adata.write_h5ad(h5ad_file)
```

Several R packages support reading and writing H5AD files.
However, they typically wrap the Python **anndata** package for file handling, using an in-memory conversion step to bridge data between R and Python.

##### Reading/writing H5AD with Bioconductor

The [Bioconductor **{zellkonverter}** package](https://bioconductor.org/packages/zellkonverter/) simplifies H5AD file handling by using the [**{basilisk}** package](https://bioconductor.org/packages/basilisk/) to manage a compatible Python environment.
In other words, it enables Bioconductor users to read and write H5AD files seamlessly, without needing any Python knowledge.

Unfortunately, because of the way this book is made, we are unable to run the code directly here. Instead, we will show the code and what the output looks like when run in an R session:

```r
sce <- zellkonverter::readH5AD(h5ad_file, verbose = TRUE)
```

```
ℹ Using the Python reader
ℹ Using anndata version 0.8.0
✔ Read /.../luke.zappia/Downloads/example.h5ad [113ms]
✔ uns$hvg$flavor converted [17ms]
✔ uns$hvg converted [50ms]
✔ uns$log1p converted [25ms]
✔ uns$neighbors converted [18ms]
✔ uns$pca$params$use_highly_variable converted [16ms]
✔ uns$pca$params$zero_center converted [16ms]
✔ uns$pca$params converted [80ms]
✔ uns$pca$variance converted [17ms]
✔ uns$pca$variance_ratio converted [16ms]
✔ uns$pca converted [184ms]
✔ uns$umap$params$a converted [16ms]
✔ uns$umap$params$b converted [16ms]
✔ uns$umap$params converted [80ms]
✔ uns$umap converted [112ms]
✔ uns converted [490ms]
✔ Converting uns to metadata ... done
✔ X matrix converted to assay [29ms]
✔ layers$counts converted [27ms]
✔ Converting layers to assays ... done
✔ var converted to rowData [25ms]
✔ obs converted to colData [24ms]
✔ varm$PCs converted [18ms]
✔ varm converted [47ms]
✔ Converting varm to rowData$varm ... done
✔ obsm$X_pca converted [15ms]
✔ obsm$X_umap converted [16ms]
✔ obsm converted [80ms]
✔ Converting obsm to reducedDims ... done
ℹ varp is empty and was skipped
✔ obsp$connectivities converted [22ms]
✔ obsp$distances converted [23ms]
✔ obsp converted [92ms]
✔ Converting obsp to colPairs ... done
✔ SingleCellExperiment constructed [164ms]
ℹ Skipping conversion of raw
✔ Converting AnnData to SingleCellExperiment ... done
```

Because we have turned on the verbose output you can see how **{zellkonverter}** reads the file using Python and converts each part of the `AnnData` object to a Bioconductor `SingleCellExperiment` object. We can see what the result looks like:

```r
sce
```

```
class: SingleCellExperiment
dim: 2000 100
metadata(5): hvg log1p neighbors pca umap
assays(2): X counts
rownames(2000): Gene_0 Gene_1 ... Gene_1998 Gene_1999
rowData names(11): n_cells_by_counts mean_counts ... dispersions_norm
  varm
colnames(100): Cell_0 Cell_1 ... Cell_98 Cell_99
colData names(8): n_genes_by_counts log1p_n_genes_by_counts ...
  pct_counts_in_top_200_genes pct_counts_in_top_500_genes
reducedDimNames(2): X_pca X_umap
mainExpName: NULL
altExpNames(0):
```

This object can then be used as normal by any Bioconductor package. If we want to write a new H5AD file we can use the `writeH5AD()` function:

```r
zellkonverter_h5ad_file <- tempfile(fileext = ".h5ad")
zellkonverter::writeH5AD(sce, zellkonverter_h5ad_file, verbose = TRUE)
```

```
ℹ Using anndata version 0.8.0
ℹ Using the 'X' assay as the X matrix
✔ Selected X matrix [29ms]
✔ assays$X converted to X matrix [50ms]
✔ additional assays converted to layers [30ms]
✔ rowData$varm converted to varm [28ms]
✔ reducedDims converted to obsm [68ms]
✔ metadata converted to uns [24ms]
ℹ rowPairs is empty and was skipped
✔ Converting AnnData to SingleCellExperiment ... done
✔ Wrote '/.../.../rj/.../T/.../file102cfa97cc51.h5ad ' [133ms]
```

We can then read this file in Python:

```python
scanpy.read_h5ad(zellkonverter_h5ad_file)
```

```
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'n_genes_by_counts', 'log1p_n_genes_by_counts', 'total_counts', 'log1p_total_counts', 'pct_counts_in_top_50_genes', 'pct_counts_in_top_100_genes', 'pct_counts_in_top_200_genes', 'pct_counts_in_top_500_genes'
    var: 'n_cells_by_counts', 'mean_counts', 'log1p_mean_counts', 'pct_dropout_by_counts', 'total_counts', 'log1p_total_counts', 'highly_variable', 'means', 'dispersions', 'dispersions_norm'
    uns: 'X_name', 'hvg', 'log1p', 'neighbors', 'pca', 'umap'
    obsm: 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts'
    obsp: 'connectivities', 'distances'
```

If you’re running a **{zellkonverter}** function for the first time, it will create a special Conda environment, which may take some time.
Once created, this environment is reused for subsequent function calls.
**{zellkonverter}** also offers options such as selectively reading or writing parts of an object.
For more details, refer to the package documentation.

Similar functionality for writing a`SingleCellExperiment` object to an H5AD file is available in the [**{sceasy}** package](https://github.com/cellgeni/sceasy).
While these packages are effective, wrapping Python introduces some overhead, which future native R H5AD writers/readers may help optimize.

##### Reading/writing H5AD with **{Seurat}**

While `h5ad_file` is a `Path` object, the way we use R in this notebook expects a string, so we convert it into a `string` object.

```python
h5ad_file = str(h5ad_file)
```

Converting between a `Seurat` object and an H5AD file is a two-step process [as suggested by this tutorial](https://mojaveazure.github.io/seurat-disk/articles/convert-anndata.html).
First, the H5AD file is converted to an H5Seurat file—a custom HDF5 format for `Seurat` objects—using the [**{SeuratDisk}** package](https://mojaveazure.github.io/seurat-disk/).
The H5Seurat file is then read as a `Seurat` object.

```python
%%R -i h5ad_file

message("Converting H5AD to H5Seurat...")
SeuratDisk::Convert(h5ad_file, dest = "h5seurat", overwrite = TRUE)
message("Reading H5Seurat...")
h5seurat_file <- gsub(".h5ad", ".h5seurat", h5ad_file)
seurat <- SeuratDisk::LoadH5Seurat(h5seurat_file, assays = "RNA")
message("Read Seurat object:")
seurat
```

Output:
```text
    WARNING: The R package "reticulate" only fixed recently
    an issue that caused a segfault when used with rpy2:
    https://github.com/rstudio/reticulate/pull/1188
    Make sure that you use a version of that package that includes
    the fix.
    
An object of class Seurat 
2000 features across 100 samples within 1 assay 
Active assay: RNA (2000 features, 0 variable features)
 2 layers present: counts, data
 2 dimensional reductions calculated: pca, umap
```

Note that converting a `Seurat` object is more complex compared to `AnnData` or `SingleCellExperiment` due to structural differences.
For more details, refer to the [conversion function documentation](https://mojaveazure.github.io/seurat-disk/reference/Convert.html).

The **{sceasy}** package allows direct reading of H5AD files into `Seurat` or `SingleCellExperiment` objects.
Unlike **{zellkonverter}**, which relies on a dedicated Python environment, **{sceasy}** wraps Python functions without requiring a special setup.
However, this means you must manually configure the environment, ensure R can locate it, and install the necessary packages.

```r
sceasy_seurat <- sceasy::convertFormat(h5ad_file, from="anndata", to="seurat")
sceasy_seurat
```

```
Warning: Feature names cannot have underscores ('_'), replacing with dashes ('-')
X -> counts
An object of class Seurat
2000 features across 100 samples within 1 assay
Active assay: RNA (2000 features, 0 variable features)
 2 dimensional reductions calculated: pca, umap
```

##### Reading/writing H5AD with **{anndata}**

The R [**{anndata}** package](https://anndata.dynverse.org/index.html) can also be used to read H5AD files.
However, unlike the packages above, it does not convert to a native R object.
Instead it provides an R interface to the Python object.
This is useful for accessing the data but few analysis packages will accept this as input, so further in-memory conversion is usually required.

#### Loom

The [Loom file format](http://loompy.org/) is an older HDF5-based specification for omics data.
While similar in structure to `AnnData and SingleCellExperiment`, it is not tied to a specific analysis ecosystem like H5AD.
Loom format support is available in both [R](https://github.com/mojaveazure/loomR) and [Python](https://pypi.org/project/loompy/), as well as through the [Bioconductor package](https://bioconductor.org/packages/LoomExperiment/) for writing Loom files.
However, it is often more convenient to use the higher-level interfaces provided by core ecosystem packages.
Beyond dataset sharing, Loom files are commonly encountered when analyzing spliced and unspliced reads using [velocyto](http://velocyto.org/) for [RNA velocity analysis](../trajectories/rna-velocity.md).

### RDS files

Another file format you may see used to share single-cell datasets is the RDS format.
This is a binary format used to serialize arbitrary `R` objects (similar to Python Pickle files).
As `SingleCellExperiment` and `Seurat` objects did not always have matching on-disk representations, RDS files are sometimes used to share the results from R analyses.
While this is ok within an analysis project, we discourage its use for sharing data publicly or with collaborators due to the lack of interoperability with other ecosystems.
Instead, we recommend using one of the HDF5 formats mentioned above that can be read from multiple languages.

### New on-disk formats

While HDF5-based formats are currently the standard for on-disk representations of single-cell data, other newer technologies such as [Zarr](https://zarr.dev/) and [TileDB](https://tiledb.com/) have some advantages, particularly for very large datasets and other modalities.
We expect specifications to be developed for these formats in the future, which may be adopted by the community (**anndata** already provides support for Zarr files).

> **Key point**
> 
> - `SingleCellExperiment`: Bioconductor standard for single-cell data in R. Conversion between `Anndata` and `SingleCellExperiment` can be done by `zellkonverter`
> - `Seurat`: Single-cell analysis framework in R. It can read/write `AnnData` via `SeuratDisk` or convert via `sceasy`
> - `AnnData`: Standard format for single-cell data in Python

## In-memory interoperability

The second approach to interoperability is to work on in-memory representations of an object.
This approach involves active sessions from two programming languages running at the same time and either accessing the same object from both or converting between them as needed.
Usually, one language acts as the main environment, and there is an interface to the other language.
This can be very useful for interactive analysis as it allows an analyst to work in two languages simultaneously.
It is also often used when creating documents that use multiple languages (such as this book).
However, in-memory interoperability has some drawbacks.
Analysts must be familiar with setting up and using both environments, complex objects may not be fully supported across languages, and data duplication increases memory overhead, making it less suitable for large datasets.

### Interoperability between R ecosystems

Before we look at in-memory interoperability between R and Python, let’s consider the simpler case of converting between the two R ecosystems.
The **{Seurat}** package provides functions for performing this conversion [as described in this vignette](https://satijalab.org/seurat/archive/v4.3/conversion_vignette).

```python
%%R
sce_from_seurat <- Seurat::as.SingleCellExperiment(seurat)
sce_from_seurat
```

Output:
```text
class: SingleCellExperiment 
dim: 2000 100 
metadata(0):
assays(2): counts logcounts
rownames(2000): Gene-0 Gene-1 ... Gene-1998 Gene-1999
rowData names(0):
colnames(100): Cell_0 Cell_1 ... Cell_98 Cell_99
colData names(9): n_genes_by_counts log1p_n_genes_by_counts ...
  pct_counts_in_top_500_genes ident
reducedDimNames(2): PCA UMAP
mainExpName: RNA
altExpNames(0):
```

```python
%%R
seurat_from_sce <- Seurat::as.Seurat(sce_from_seurat)
seurat_from_sce
```

Output:
```text
An object of class Seurat 
2000 features across 100 samples within 1 assay 
Active assay: RNA (2000 features, 0 variable features)
 2 layers present: counts, data
 2 dimensional reductions calculated: PCA, UMAP
```

The difficult part here is due to the differences between the structures of the two objects.
It is important to make sure the arguments are set correctly so that the conversion functions know which information to convert and where to place it.

In many cases it may not be necessary to convert a `Seurat` object to a `SingleCellExperiment`.
This is because many of the core Bioconductor packages for single-cell analysis have been designed to accept a matrix as input as well.

```python
%%R
# Calculate Counts Per Million using the Bioconductor scuttle package
# with a matrix in a Seurat object
cpm <- scuttle::calculateCPM(Seurat::GetAssayData(seurat, slot = "counts"))
cpm[1:10, 1:10]
```

Output:
```text
10 x 10 sparse Matrix of class "dgCMatrix"
                                                                      
Gene-0 594.0456    .     984.0238  610.329 964.4394 616.4169    .     
Gene-1 594.0456 1168.519 622.6029    .     608.7911   .         .     
Gene-2   .         .     984.0238    .     608.7911 973.2674 1205.5970
Gene-3 594.0456    .     622.6029  610.329 964.4394 616.4169    .     
Gene-4 594.0456    .     622.6029  966.820 964.4394   .         .     
Gene-5 594.0456  580.157 622.6029  610.329 608.7911   .       601.7422
Gene-6   .         .     622.6029  610.329   .      616.4169  601.7422
Gene-7 594.0456  580.157 622.6029  966.820 608.7911 616.4169    .     
Gene-8 594.0456  580.157   .      1219.608 608.7911 973.2674    .     
Gene-9 942.9097    .       .         .     964.4394   .       954.8014
                                    
Gene-0  576.0808  619.7236  604.3937
Gene-1  918.4111 1234.7593  958.4625
Gene-2    .       619.7236 1209.8233
Gene-3    .       619.7236  958.4625
Gene-4  576.0808  979.8761  604.3937
Gene-5    .       619.7236  958.4625
Gene-6    .      1234.7593    .     
Gene-7    .       619.7236  604.3937
Gene-8 1162.8180  979.8761  958.4625
Gene-9    .      1234.7593    .     
```

However, it is important to be sure you are accessing the right information and storing any results in the correct place if needed.

### Accessing R from Python

The Python interface to R is provided by the [**rpy2** package](https://rpy2.github.io/doc/latest/html/index.html).
This allows you to access R functions and objects from Python.
For example:

```python
counts_mat = adata.layers["counts"].T.toarray()

with rpy2.robjects.conversion.localconverter(rpy2.robjects.numpy2ri.converter):
    rpy2.robjects.globalenv["counts_mat"] = counts_mat

cpm = rpy2.robjects.r("scuttle::calculateCPM(counts_mat)")
cpm
```

Common Python objects (lists, matrices, `DataFrame`s etc.) can also be passed to R.

If you are using a Jupyter notebook (as we are for this book) you can use the IPython magic interface to create cells with native R code (passing objects as required).
For example, starting a cell with `%%R -i input -o output` says to take `input` as input, run R code and then return `output` as output.

```python
%%R -i counts_mat -o magic_cpm
# R code running using IPython magic
magic_cpm <- scuttle::calculateCPM(counts_mat)
```

```python
# Python code accessing the results
magic_cpm
```

Output:
```text
array([[ 494.8045522 ,    0.        , 1027.2213662 , ...,    0.        ,
           0.        ,  519.75051975],
       [ 494.8045522 , 1445.78313253,  513.6106831 , ...,    0.        ,
         499.5004995 ,  519.75051975],
       [   0.        ,    0.        , 1027.2213662 , ...,  485.90864917,
         499.5004995 ,    0.        ],
       ...,
       [ 494.8045522 ,    0.        ,  513.6106831 , ...,    0.        ,
           0.        ,  519.75051975],
       [ 989.6091044 ,  481.92771084,    0.        , ...,    0.        ,
         499.5004995 ,  519.75051975],
       [2474.02276101,  963.85542169,  513.6106831 , ...,  485.90864917,
         999.000999  ,    0.        ]])
```

This is the approach you will most commonly see in later chapters.
For more information about using **rpy2** please refer to [the documentation](https://rpy2.github.io/doc/latest/html/index.html).

To work with single-cell data in this way, the [**anndata2ri** package](https://icb-anndata2ri.readthedocs-hosted.com/en/latest/) is particularly useful.
As an extension of **rpy2**, it allows R to recognize `AnnData` objects as `SingleCellExperiment` objects, eliminating unnecessary conversion and enabling seamless execution of R code on Python objects.
Additionally, it facilitates the conversion of sparse **scipy** matrices.

In this example, in order to pass an `AnnData` object in the Python session to R, we have to first convert it to `SingleCellExperiment`.

```python
with rpy2.robjects.conversion.localconverter(anndata2ri.converter):
    r_adata = rpy2.robjects.conversion.py2rpy(adata)
```

Now, we can pass it to R.

```python
%%R -i r_adata
qc <- scuttle::perCellQCMetrics(r_adata)
head(qc)
```

Output:
```text
DataFrame with 6 rows and 3 columns
             sum  detected     total
       <numeric> <integer> <numeric>
Cell_0      2021      1297      2021
Cell_1      2075      1314      2075
Cell_2      1947      1233      1947
Cell_3      1986      1250      1986
Cell_4      1987      1255      1987
Cell_5      1930      1266      1930
```

Note that you will still run into issues if an object (or part of it) cannot be interfaced correctly (for example if there is an unsupported data type).
In that case, you may need to modify your object before it can be accessed.

### Accessing Python from R

Accessing Python from an R session is similar to accessing R from Python but here the interface is provided by the [**{reticulate}** package](https://rstudio.github.io/reticulate/).
Once it is loaded we can access Python functions and objects from R.

```python
%%R
reticulate_list <- reticulate::r_to_py(LETTERS)
print(reticulate_list)
py_builtins <- reticulate::import_builtins()
py_builtins$zip(letters, LETTERS)
```

Output:
```text
List (26 items)
<zip object at 0x15d0dc6c0>
```

If you are working in an [RMarkdown](https://rmarkdown.rstudio.com/) or [Quarto](https://quarto.org/) document you can also write native Python chunks using the **{reticulate}** Python engine.
When we do this we can use the magic `r` and `py` variables to access objects in the other language (the following code is an example that is not run).

```
```{r}
# An R chunk that accesses a Python object
print(py$py_object)
```

```{python}
# A Python chunk that accesses an R object
print(r$r_object)
```
```

Unlike **anndata2ri**, there are no R packages that provide a direct interface for Python to view `SingleCellExperiment` or `Seurat` objects as `AnnData` objects.
However, we can still access most parts of an `AnnData` using **{reticulate}** (this code is not run).

```r
# Print an AnnData object in a Python environment
py$adata
```

```
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'n_genes_by_counts', 'log1p_n_genes_by_counts', 'total_counts', 'log1p_total_counts', 'pct_counts_in_top_50_genes', 'pct_counts_in_top_100_genes', 'pct_counts_in_top_200_genes', 'pct_counts_in_top_500_genes'
    var: 'n_cells_by_counts', 'mean_counts', 'log1p_mean_counts', 'pct_dropout_by_counts', 'total_counts', 'log1p_total_counts', 'highly_variable', 'means', 'dispersions', 'dispersions_norm'
    uns: 'hvg', 'log1p', 'neighbors', 'pca', 'umap'
    obsm: 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts'
    obsp: 'connectivities', 'distances'
```

```r
# Alternatively use the Python anndata package to read a H5AD file
anndata <- reticulate::import("anndata")
anndata$read_h5ad(h5ad_file)
```

```
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'n_genes_by_counts', 'log1p_n_genes_by_counts', 'total_counts', 'log1p_total_counts', 'pct_counts_in_top_50_genes', 'pct_counts_in_top_100_genes', 'pct_counts_in_top_200_genes', 'pct_counts_in_top_500_genes'
    var: 'n_cells_by_counts', 'mean_counts', 'log1p_mean_counts', 'pct_dropout_by_counts', 'total_counts', 'log1p_total_counts', 'highly_variable', 'means', 'dispersions', 'dispersions_norm'
    uns: 'hvg', 'log1p', 'neighbors', 'pca', 'umap'
    obsm: 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts'
    obsp: 'connectivities', 'distances'
```

```r
# Access the obs slot, pandas DataFrames are automatically converted to R data.frames
head(adata$obs)
```

```
       n_genes_by_counts log1p_n_genes_by_counts total_counts
Cell_0              1246                7.128496         1965
Cell_1              1262                7.141245         2006
Cell_2              1262                7.141245         1958
Cell_3              1240                7.123673         1960
Cell_4              1296                7.167809         2027
Cell_5              1231                7.116394         1898
       log1p_total_counts pct_counts_in_top_50_genes
Cell_0           7.583756                  10.025445
Cell_1           7.604396                   9.521436
Cell_2           7.580189                   9.959142
Cell_3           7.581210                   9.183673
Cell_4           7.614805                   9.718796
Cell_5           7.549083                  10.168599
       pct_counts_in_top_100_genes pct_counts_in_top_200_genes
Cell_0                    17.65903                    30.89059
Cell_1                    16.99900                    29.71087
Cell_2                    17.62002                    30.28601
Cell_3                    16.83673                    30.45918
Cell_4                    17.11889                    30.04440
Cell_5                    18.07165                    30.29505
       pct_counts_in_top_500_genes
Cell_0                    61.42494
Cell_1                    59.62114
Cell_2                    60.92952
Cell_3                    61.07143
Cell_4                    59.64480
Cell_5                    61.48577
```

As mentioned above the R **{anndata}** package provides an R interface for `AnnData` objects but it is not currently used by many analysis packages.

For more complex analyses that require working with an entire object, it may be necessary to fully convert an object between R and Python
While this approach is not memory-efficient due to data duplication, it grants access to a broader range of packages.

The **{zellkonverter}** package provides a function for this conversion.
Unlike its function for reading H5AD files, this process uses the standard Python environment rather than a specially created one (code not run).

```r
# Convert an AnnData to a SingleCellExperiment
sce <- zellkonverter::AnnData2SCE(adata, verbose = TRUE)
sce
```

```
✔ uns$hvg$flavor converted [21ms]
✔ uns$hvg converted [62ms]
✔ uns$log1p converted [22ms]
✔ uns$neighbors converted [21ms]
✔ uns$pca$params$use_highly_variable converted [22ms]
✔ uns$pca$params$zero_center converted [31ms]
✔ uns$pca$params converted [118ms]
✔ uns$pca$variance converted [17ms]
✔ uns$pca$variance_ratio converted [17ms]
✔ uns$pca converted [224ms]
✔ uns$umap$params$a converted [15ms]
✔ uns$umap$params$b converted [17ms]
✔ uns$umap$params converted [80ms]
✔ uns$umap converted [115ms]
✔ uns converted [582ms]
✔ Converting uns to metadata ... done
✔ X matrix converted to assay [44ms]
✔ layers$counts converted [29ms]
✔ Converting layers to assays ... done
✔ var converted to rowData [37ms]
✔ obs converted to colData [23ms]
✔ varm$PCs converted [18ms]
✔ varm converted [49ms]
✔ Converting varm to rowData$varm ... done
✔ obsm$X_pca converted [17ms]
✔ obsm$X_umap converted [17ms]
✔ obsm converted [80ms]
✔ Converting obsm to reducedDims ... done
ℹ varp is empty and was skipped
✔ obsp$connectivities converted [21ms]
✔ obsp$distances converted [22ms]
✔ obsp converted [89ms]
✔ Converting obsp to colPairs ... done
✔ SingleCellExperiment constructed [241ms]
ℹ Skipping conversion of raw
✔ Converting AnnData to SingleCellExperiment ... done
class: SingleCellExperiment
dim: 2000 100
metadata(5): hvg log1p neighbors pca umap
assays(2): X counts
rownames(2000): Gene_0 Gene_1 ... Gene_1998 Gene_1999
rowData names(11): n_cells_by_counts mean_counts ... dispersions_norm
  varm
colnames(100): Cell_0 Cell_1 ... Cell_98 Cell_99
colData names(8): n_genes_by_counts log1p_n_genes_by_counts ...
  pct_counts_in_top_200_genes pct_counts_in_top_500_genes
reducedDimNames(2): X_pca X_umap
mainExpName: NULL
altExpNames(0):
```

The same can also be done in reverse:

```r
adata2 <- zellkonverter::SCE2AnnData(sce, verbose = TRUE)
adata2
```

```
ℹ Using the 'X' assay as the X matrix
✔ Selected X matrix [27ms]
✔ assays$X converted to X matrix [38ms]
✔ additional assays converted to layers [31ms]
✔ rowData$varm converted to varm [15ms]
✔ reducedDims converted to obsm [63ms]
✔ metadata converted to uns [23ms]
ℹ rowPairs is empty and was skipped
✔ Converting AnnData to SingleCellExperiment ... done
AnnData object with n_obs × n_vars = 100 × 2000
    obs: 'n_genes_by_counts', 'log1p_n_genes_by_counts', 'total_counts', 'log1p_total_counts', 'pct_counts_in_top_50_genes', 'pct_counts_in_top_100_genes', 'pct_counts_in_top_200_genes', 'pct_counts_in_top_500_genes'
    var: 'n_cells_by_counts', 'mean_counts', 'log1p_mean_counts', 'pct_dropout_by_counts', 'total_counts', 'log1p_total_counts', 'highly_variable', 'means', 'dispersions', 'dispersions_norm'
    uns: 'X_name', 'hvg', 'log1p', 'neighbors', 'pca', 'umap'
    obsm: 'X_pca', 'X_umap'
    varm: 'PCs'
    layers: 'counts'
    obsp: 'connectivities', 'distances'
```

## Interoperability for multimodal data

The complexity of multimodal data presents additional challenges for interoperability.
Both `SingleCellExperiment` (via “alternative experiments,” which must share the same column dimension for cells) and `Seurat` (using “assays”) support multiple modalities.
However, `AnnData` is limited to unimodal data.

To address this limitation, the `MuData` object (introduced in the [analysis frameworks and tools chapter](../introduction/fundamental-data-structures-and-frameworks.md)) was developed as an extension of `AnnData` for multimodal datasets.
The developers have considered interoperability in their design.
While the main platform for MuData is Python, the authors have provided the [MuDataSeurat R package](https://pmbio.github.io/MuDataSeurat/) for reading the on-disk H5MU format as `Seurat` objects and the [MuData R package](https://bioconductor.org/packages/MuData/) for doing the same with Bioconductor `MultiAssayExperiment` objects. This official support is very useful but there are still some inconsistencies due to differences between the objects. The MuData authors also provide a [Julia implementation](https://docs.juliahub.com/Muon/QfqCh/0.1.1/objects/) of `AnnData` and `MuData`.

Below is an example of reading and writing a small example `MuData` dataset using the Python and R packages.

### Python

```python
# Read file
af_mudata = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="introduction/interoperability_mdata.h5mu", is_latest=True
)
mdata = af_mudata.load()
mdata
```

Output:
```text
MuData object with n_obs × n_vars = 1000 × 150
  var:	'dummy_var'
  2 modalities
    A:	1000 x 100
      obs:	'dummy_obs'
      var:	'dummy_var'
    B:	1000 x 50
      obs:	'dummy_obs'
      var:	'dummy_var'
```

### R

#### Bioconductor

Read/write from/to a `MultiAssayExperiment` object

```python
import shutil
from pathlib import Path

# Save MuData file locally for R
Path("data").mkdir(parents=True, exist_ok=True)

local_path = af_mudata.cache().path

target_path = Path("data") / "interoperability_mdata.h5mu"
shutil.copy(local_path, target_path)
print(f"File copied to: {target_path}")
```

Output:
```text
File copied to: data/interoperability_mdata.h5mu
```

```python
%%R
mae <- MuData::readH5MU("data/interoperability_mdata.h5mu")
print(mae)

bioc_h5mu_file <- tempfile(fileext = ".h5mu")
MuData::writeH5MU(mae, bioc_h5mu_file)
```

Output:
```text
A MultiAssayExperiment object of 2 listed
 experiments with user-defined names and respective classes.
 Containing an ExperimentList class object of length 2:
 [1] A: SingleCellExperiment with 100 rows and 1000 columns
 [2] B: SingleCellExperiment with 50 rows and 1000 columns
Functionality:
 experiments() - obtain the ExperimentList instance
 colData() - the primary/phenotype DataFrame
 sampleMap() - the sample coordination DataFrame
 `$`, `[`, `[[` - extract colData columns, subset, or experiment
 *Format() - convert into a long or wide DataFrame
 assays() - convert ExperimentList to a SimpleList of matrices
 exportClass() - save data to flat files
```

#### Seurat

Read/write from/to a `Seurat` object

```python
%%R
seurat <- MuDataSeurat::ReadH5MU("data/interoperability_mdata.h5mu")
print(seurat)

seurat_h5mu_file <- tempfile(fileext = ".h5mu")
MuDataSeurat::WriteH5MU(seurat, seurat_h5mu_file)
```

Output:
```text
An object of class Seurat 
150 features across 1000 samples within 2 assays 
Active assay: A (100 features, 0 variable features)
 2 layers present: counts, data
 1 other assay present: B
```

## Interoperability with other languages

Here we briefly list some resources and tools for the interoperability of single-cell data with languages other than R and Python.

### Julia

- [Muon.jl](https://docs.juliahub.com/Muon/QfqCh/0.1.1/objects/) provides Julia implementations of `AnnData` and `MuData` objects, as well as IO for the H5AD and H5MU formats
- [scVI.jl](https://github.com/maren-ha/scVI.jl) provides a Julia implementation of `AnnData` as well as IO for the H5AD format

### JavaScript

- [Vitessce](http://vitessce.io/) contains loaders from `AnnData` objects stored using the Zarr format
- The [kana family](https://github.com/jkanche/kana) supports reading H5AD files and `SingleCellExperiment` objects saved as RDS files

### Rust

- [anndata-rs](https://github.com/kaizhang/anndata-rs) provides a Rust implementation of AnnData as well as advanced IO support for the H5AD format

## Session information

## Python

```python
import session_info

session_info.show()
```

## R

```python
%%R
sessioninfo::session_info()
```

Output:
```text
─ Session info ───────────────────────────────────────────────────────────────
 setting  value
 version  R version 4.3.3 (2024-02-29)
 os       macOS 15.3.2
 system   x86_64, darwin13.4.0
 ui       unknown
 language (EN)
 collate  C
 ctype    UTF-8
 tz       Europe/Berlin
 date     2025-03-26
 pandoc   3.6.3 @ /Users/seohyon/miniconda3/envs/interoperability/bin/pandoc
 quarto   NA

─ Packages ───────────────────────────────────────────────────────────────────
 package              * version    date (UTC) lib source
 abind                  1.4-8      2024-09-12 [1] CRAN (R 4.3.3)
 beachmat               2.18.0     2023-10-24 [1] Bioconductor
 Biobase              * 2.62.0     2023-10-24 [1] Bioconductor
 BiocGenerics         * 0.48.1     2023-11-01 [1] Bioconductor
 BiocParallel           1.36.0     2023-10-24 [1] Bioconductor
 bit                    4.6.0      2025-03-06 [1] CRAN (R 4.3.3)
 bit64                  4.6.0-1    2025-01-16 [1] CRAN (R 4.3.3)
 bitops                 1.0-9      2024-10-03 [1] CRAN (R 4.3.3)
 cli                    3.6.4      2025-02-13 [1] CRAN (R 4.3.3)
... (141 more lines)
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Luke Zappia
- Seo H. Kim

### Reviewers

- Lukas Heumos
- Isaac Virshup
- Anastasia Litinetskaya
- Ludwig Geistlinger
- Peter Hickey
