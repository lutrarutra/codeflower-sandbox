# Multimodal data structures

Source: https://www.sc-best-practices.org/introduction/advanced-data-structures-and-frameworks  
Authors: Lukas Heumos, Luis Heinzlmeier, Isaac Virshup

**🧠 Key takeaways**

- Modern single-cell experiments often measure multiple modalities (e.g., RNA, ATAC, proteins) at the same time.
While AnnData is designed for unimodal data, multimodal experiments require containers such as MuData that organize multiple datasets together.
- A MuData object stores several AnnData objects (one per modality) while sharing global annotations for cells and features.
This structure allows both modality-specific analyses and joint multimodal computations within the same dataset.
- The framework muon extends the analysis ecosystem by providing preprocessing and analysis tools for modalities beyond RNA, such as ATAC or protein data.
It also includes methods that integrate information across multiple modalities.

**⚙️ Environment setup**

**yml:**

```yaml
name: advanced_data_structures_and_frameworks
channels:
  - conda-forge
  - bioconda
dependencies:
  - conda-forge::anndata=0.12.11
  - conda-forge::mudata=0.4.1
  - conda-forge::muon=0.1.9
  - conda-forge::python=3.14.7
  - conda-forge::scanpy=1.12
  - conda-forge::python-igraph=1.0.0
  - pip
  - pip:
      - lamindb
      - pysam==0.24.1
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

![Scverse ecosystem overview](https://www.sc-best-practices.org/build/advanced_data_struct-53294ead93256fe6b771991b76e789a2.png)

*Figure 1: Scverse ecosystem overview highlighting MuData and muon, covered in this chapter, and SpatialData and Squidpy, covered in the [spatial data structures chapter](../spatial/data-structures.md). The publication date by a scientific journal is shown in brackets. We have obtained the symbols of the libraries from the corresponding Github pages (Virshup *et al.*, 2021 [1]; Wolf *et al.*, 2018 [2]; Bredikhin *et al.*, 2022 [3]; Palla *et al.*, 2022 [4]; Marconato *et al.*, 2025 [5]).*

This chapter assumes familiarity with AnnData and scanpy from the [previous chapter](../introduction/fundamental-data-structures-and-frameworks.md).
It introduces MuData for multimodal assays and muon, the analysis framework built on top of it.

## Using MuData to store multimodal data

AnnData is primarily designed for storing and manipulating unimodal data.
However, multimodal assays such as CITE-Seq generate multimodal data by simultaneously measuring RNA and surface proteins.
This data requires more advanced ways of storing, which is where MuData comes into play.
MuData builds on top of AnnData to store and manipulate multimodal data. Muon (Bredikhin *et al.*, 2022 [3]), a “Scanpy equivalent” and core package of scverse, can then be used to analyze the multimodal omics data.
The following section is based on the [MuData Quickstart](https://mudata.readthedocs.io/stable/notebooks/quickstart_mudata.html) and the [Multimodal data objects](https://mudata.readthedocs.io/stable/io/mudata.html#) tutorial.

![MuData Overview](https://www.sc-best-practices.org/build/mudata-af003aa052051287d5673b31f7f7fcca.png)

*Figure 2: MuData overview. Image obtained from (Bredikhin *et al.*, 2022 [3]).*

### Installation

MuData is available on [PyPI](../glossary.md#term-python-package-index-pypi) and Conda. It can be installed using either of the following commands.

```bash
pip install mudata
conda install -c conda-forge mudata
```

The main idea behind MuData is that the MuData object contains references to single AnnData objects of the unimodal data, but the MuData object itself also stores multimodal annotations.
It is therefore possible to directly access the AnnData objects to perform unimodal data transformations which store their results in the corresponding AnnData annotations, but also to aggregate the modalities for joint calculations whose results can be stored in the global MuData object.
Technically, this is realized by MuData objects comprising a dictionary with AnnData objects, one per modality, in their `.mod` (=modality) attribute.
Just as AnnData objects themselves, MuData objects also contain attributes like `.obs` with annotation of observations (samples or cells), `.obsm` with their multidimensional annotations such as embeddings.

```python
import os
import warnings

warnings.filterwarnings("ignore")
os.environ["PYTHONWARNINGS"] = "ignore"
```

### Initializing a MuData object

Let’s import MuData from the mudata package.

```python
import lamindb as ln
import mudata as md
import numpy as np

ln.connect("theislab/sc-best-practices")

ln.track("em2cp9S0T9WE")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
! It looks like you are running jupyter lab but don't have jupyter-server module installed. Please install it via pip install jupyter-server
→ loaded Transform('em2cp9S0T9WE0001', key='advanced_data_structures_and_frameworks.ipynb'), started new Run('FOKypfLp58AYV3XG') at 2026-10-19 13:23:04 UTC
```

To create an example MuData object we require simulated data.
Therefore, we created two AnnData objects with *data for the same observations*, but for *different variables*.

```python
adata = ln.Artifact.get(
    key="introduction/advanced_data_structures_and_frameworks_mudata_1.h5ad",
).load()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 1000 × 100
```

```python
adata2 = ln.Artifact.get(
    key="introduction/advanced_data_structures_and_frameworks_mudata_2.h5ad",
).load()
adata2
```

Output:
```text
AnnData object with n_obs × n_vars = 1000 × 50
```

These two AnnData objects (two “modalities”) can then be wrapped into a single MuData object.
Here, we name modality one `A` and modality two `B`.

```python
mdata = md.MuData({"A": adata, "B": adata2})
mdata
```

Output:
```text
MuData object with n_obs × n_vars = 1000 × 150
  2 modalities
    A:	1000 × 100
    B:	1000 × 50
```

Observations and variables of the `MuData` object are global, which means that observations with the identical name (`.obs_names`) in different modalities are considered to be the same observation (e.g. `obs_1` in `adata` and `obs_1` in `adata2`).
This also means variable names (`.var_names`) should be unique (e.g. `var_1` in `adata` and `var2_1` in `adata2`).
This is reflected in the object description above: `mdata` has 1000 observations and 150 = 100+50 variables.

### MuData attributes

#### `.mod`

MuData objects consist of annotations as earlier described for AnnData objects like `.obs` or `.var`, but extend this behavior with `.mod` which serves as an accessor to the individual modalities.
Modalities are stored in a collection accessible via the `.mod` attribute of the MuData object with names of modalities as keys and AnnData objects as values.

```python
list(mdata.mod.keys())
```

Output:
```text
['A', 'B']
```

Individual modalities can be accessed with their names via the `.mod` attribute or via the MuData object itself as a shorthand.

```python
print(mdata.mod["A"])
print(mdata["A"])
```

Output:
```text
AnnData object with n_obs × n_vars = 1000 × 100
AnnData object with n_obs × n_vars = 1000 × 100
```

#### `.obs` and `.var`

Samples (cells) annotation is accessible via the `.obs` attribute and by default includes copies of columns from `.obs` data frames of individual modalities.
The same goes for `.var`, which contains annotation of variables (features).
Observations columns copied from individual modalities contain modality name as their prefix, e.g. rna:n_genes.
This is also true for variables columns.
However if there are columns with identical names in `.var` of multiple modalities (e.g., n_cells), these columns are merged across modalities and no prefix is added.
When those slots are changed in AnnData objects of modalities, e.g. new columns are added or samples (cells) are filtered out, the changes have to be fetched with the `.update()` method (see below).

```python
mdata.var_names
```

Output:
```text
Index(['var_1', 'var_2', 'var_3', 'var_4', 'var_5', 'var_6', 'var_7', 'var_8',
       'var_9', 'var_10',
       ...
       'var2_41', 'var2_42', 'var2_43', 'var2_44', 'var2_45', 'var2_46',
       'var2_47', 'var2_48', 'var2_49', 'var2_50'],
      dtype='object', length=150)
```

Multidimensional annotations of samples (cells) are accessible in the `.obsm` attribute.
For instance, that can be [UMAP](../glossary.md#term-uniform-manifold-approximation-and-projection-umap) coordinates that were learnt jointly on all modalities.

If the shape of a modality is changed (e.g. change `var_names`), `MuData.update()` has to be run to bring the respective updates to the MuData object.

```python
adata2.var_names = ["var_ad2_" + e.split("_")[1] for e in adata2.var_names]
print("Outdated variables names: ...,", ", ".join(mdata.var_names[-3:]))
mdata.update()
print("Updated variables names: ...,", ", ".join(mdata.var_names[-3:]))
```

Output:
```text
Outdated variables names: ..., var2_48, var2_49, var2_50
Updated variables names: ..., var_ad2_48, var_ad2_49, var_ad2_50
```

Importantly, individual modalities are stored as references to the original objects.
Hence, if the original AnnData is changed the change will also be reflected in the MuData object.

```python
# Add some unstructured data to the original object
adata.uns["misc"] = {"adata": True}
```

```python
# Access modality A via the .mod attribute
mdata.mod["A"].uns["misc"]
```

Output:
```text
{'adata': True}
```

### Variable mappings

Upon construction of a MuData object, a global binary mapping between observations and individual modalities is created as well as between variables and modalities.
Since all the observations are the same across modalities in `mdata`, all the values in the observations mappings are set to `True`.

```python
mdata.obsm["A"]
```

Output:
```text
array([[ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
... (975 more lines)
```

```python
np.sum(mdata.obsm["A"]) == np.sum(mdata.obsm["B"]) == 1000
```

Output:
```text
np.True_
```

For variables however, those are 150-long vectors.
The `A` modality has 100 `True` values followed by 50 `False` values.

```python
mdata.varm["A"]
```

Output:
```text
array([[ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
       [ True],
... (125 more lines)
```

### MuData views

Analogous to the behavior of AnnData objects, slicing MuData objects returns views of the original data.

```python
view = mdata[:100, :1000]
print(view.is_view)
print(view["A"].is_view)
```

Output:
```text
True
True
```

Subsetting MuData objects is special since it slices them across modalities.
For example, the slicing operation for a set of `obs_names` and/or `var_names` will be performed for each modality and not only for the global multimodal annotation.
This behavior makes workflows memory-efficient, which is especially important when working with large datasets.
If the object is to be modified however, a copy of it should be created, which is not a view anymore and has no dependence on the original object.

```python
mdata_sub = view.copy()
mdata_sub.is_view
```

Output:
```text
False
```

### Common observations

While a MuData object is comprised of the same observations for both modalities, it is not always the case in the real world where some data might be missing.
By design, MuData accounts for these scenarios since there’s no guarantee observations are the same (or even intersecting) for a MuData instance.
It’s worth noting that other tools might provide convenience functions for some common scenarios of dealing with missing data, such as `intersect_obs()` implemented in muon.

### Reading and Writing of MuData objects

Similarly to AnnData objects, MuData objects were designed to be serialized into HDF5 based `.h5mu` files.
All modalities are stored under their respective names in the `/mod` HDF5 group of the `.h5mu` file. Each individual modality, e.g. `/mod/A`, is stored in the same way as it would be stored in the `.h5ad` file.
MuData objects can be read and written as follows:

```python
mdata.write("my_mudata.h5mu")
mdata_r = md.read("my_mudata.h5mu", backed=True)
mdata_r
```

Output:
```text
MuData object with n_obs × n_vars = 1000 × 150 backed at 'my_mudata.h5mu'
  2 modalities
    A:	1000 × 100
      uns:	'misc'
    B:	1000 × 50
```

Individual modalities are backed as well inside the `.h5mu` file.

```python
mdata_r["A"].isbacked
```

Output:
```text
True
```

If the original object is backed, provide a new filename to the `.copy()` call, and the resulting object will be backed at a new location.

```python
mdata_sub = mdata_r.copy("mdata_sub.h5mu")
print(mdata_sub.is_view)
print(mdata_sub.isbacked)
```

Output:
```text
False
True
```

### Multimodal methods

When the MuData object is prepared, it is up to multimodal methods to be used to make sense of the data.
The most simple and naive approach is to concatenate matrices from multiple modalities to perform for example dimensionality reduction.

```python
x = np.hstack([mdata.mod["A"].X, mdata.mod["B"].X])
x.shape
```

Output:
```text
(1000, 150)
```

We can write a simple function to run a [principal component analysis (PCA)](../glossary.md#term-principal-component-analysis-pca) on such a concatenated matrix.
MuData object provides a place to store multimodal [embeddings](../glossary.md#term-embedding): MuData `.obsm`.
It is similar to how the embeddings generated on individual modalities are stored, only this time it is saved inside the MuData object rather than in AnnData `.obsm`.

To calculate for example a PCA for the joint values of the modalities, we horizontally stack the values stored in the individual modalities and then perform the PCA on the stacked matrix.
This is possible because the number of observations matches across modalities (remember, the number of features per modality does not have to match).

```python
def simple_pca(mdata):
    from sklearn import decomposition

    x = np.hstack([m.X for m in mdata.mod.values()])

    pca = decomposition.PCA(n_components=2)
    components = pca.fit_transform(x)

    # By default, methods operate in-place and embeddings are stored in the .obsm slot
    mdata.obsm["X_pca"] = components
```

```python
simple_pca(mdata)
print(mdata)
```

Output:
```text
MuData object with n_obs × n_vars = 1000 × 150
  obsm:	'X_pca'
  2 modalities
    A:	1000 × 100
      uns:	'misc'
    B:	1000 × 50
```

Our calculated principal components are now stored in the MuData object itself and accessible for further multimodal transformations.

In reality, however, having different modalities often means that the features between them come from different generative processes and are not comparable.
This is where special multimodal integration methods come into play.
For omics technologies, these methods are frequently addressed as multi-omics integration methods.
In the following section we will introduce muon which provides many tools to preprocess unimodal data beyond RNA-Seq and multi-omics integration methods.

## Multimodal data analysis with muon

Although Scanpy provides generally applicable tools such as PCA, UMAP, and various visualizations, it is primarily designed to analyze RNA-Seq data.
Muon fills this gap by providing preprocessing functions for other omics, such as chromatin accessibility (ATAC) or protein (CITE) data.
As mentioned above, muon further provides algorithms to run multi-omics algorithms that infer knowledge from the joint modalities.
For example, users may run a PCA on a single modality, but muon further provides multi-omics factor analysis algorithms that take several modalities as input.
The following sections was adopted from the muon tutorial [“Processing chromatin accessibility of 10k PBMCs”](https://muon-tutorials.readthedocs.io/en/latest/single-cell-rna-atac/pbmc10k/2-Chromatin-Accessibility-Processing.html#Processing-chromatin-accessibility-of-10k-PBMCs).

![muon Overview](https://www.sc-best-practices.org/build/muon-d94de455421be04b3373a525c5eabc56.png)

*Figure 3: muon overview. Image obtained from (Bredikhin *et al.*, 2022 [3]).*

### Installation

Muon is available on PyPI and can be installed using:

```bash
pip install muon
```

### API overview

To introduce muon, we will examine the ATAC data from a multimodal dataset.
Analogously to the Scanpy chapter, this chapter solely serves as a quick demo and overview of muon and does not analyze a dataset thoroughly, let alone provide best-practice multi-omics analysis.
Please read the corresponding chapters to learn how to properly conduct such analyses.

Muon separates its modules in two ways. First, analogously to Scanpy, general and multimodal functions are grouped in preprocessing (`muon.pp`), tools (`muon.tl`) and plots (`muon.pl`).
Second, unimodal tools are available from the corresponding muon, which are again separated into preprocessing, tools and plots.
For example, all ATAC preprocessing functions are grouped into `muon.atac.pp`.
This also applies to CITE-Seq preprocessing functions (`muon.prot.pp`).

![muon API Overview](https://www.sc-best-practices.org/build/muon_api-2d998e23a59a05fef794f4ca687cb4a0.png)

*Figure 4: Muon API overview. Modality specific functions are provided in correspondingly named modules. Functions for the joint analysis of modalities are available via the muon module directly.*

### Muon API demo

The dataset for our demo is a publicly available 10x Genomics Multiome dataset for human peripheral blood mononuclear cells (PBMCs).

```python
import muon as mu

mdata = ln.Artifact.get(
    key="introduction/advanced_data_structures_and_frameworks_muon.h5mu", is_latest=True
).load()

fragments = ln.Artifact.get(
    key="introduction/advanced_data_structures_and_frameworks_atac_fragments.tsv.gz",
    is_latest=True,
).cache()

fragments_tbi = ln.Artifact.get(
    key="introduction/advanced_data_structures_and_frameworks_atac_fragments.tsv.gz.tbi",
    is_latest=True,
).cache()

mdata
```

Output:
```text
MuData object with n_obs × n_vars = 11909 × 144978
  var:	'gene_ids', 'feature_types', 'genome', 'interval'
  2 modalities
    rna:	11909 × 36601
      var:	'gene_ids', 'feature_types', 'genome', 'interval'
    atac:	11909 × 108377
      var:	'gene_ids', 'feature_types', 'genome', 'interval'
      uns:	'atac', 'files'
```

As a first step we subset to the ATAC modality.

```python
atac = mdata.mod["atac"]
```

Although, we are now not working with RNA-Seq, it is possible to use some of Scanpy’s preprocessing functions which can also be used on ATAC data.
This is possible due to similar distribution and quality issues of both modalities.
The only thing to bear in mind here that a gene would mean a peak in the context of the AnnData object with ATAC-seq data.
Afterwards, ATAC specific preprocessing can be conducted with the ATAC module of muon.

Let us start with some quality control by filtering out cells with too few peaks and peaks detected in too few cells.
For now, we will filter out cells that do not pass QC.

```python
import scanpy as sc

sc.pp.calculate_qc_metrics(atac, percent_top=None, log1p=False, inplace=True)
```

```python
sc.pl.violin(atac, ["total_counts", "n_genes_by_counts"], jitter=0.4, multi_panel=True)
```

Filter peaks whose expression is not detected.

```python
mu.pp.filter_var(atac, "n_cells_by_counts", lambda x: x >= 10)
# This is analogous to
#   sc.pp.filter_genes(rna, min_cells=10)
# but does in-place filtering and avoids copying the object
```

We also filter the cells.

```python
mu.pp.filter_obs(atac, "n_genes_by_counts", lambda x: (x >= 2000) & (x <= 15000))
# This is analogous to
#   sc.pp.filter_cells(atac, max_genes=15000)
#   sc.pp.filter_cells(atac, min_genes=2000)
# but does in-place filtering avoiding copying the object

mu.pp.filter_obs(atac, "total_counts", lambda x: (x >= 4000) & (x <= 40000))
```

```python
sc.pl.violin(atac, ["n_genes_by_counts", "total_counts"], jitter=0.4, multi_panel=True)
```

Muon also provides histograms which allows for a different view on the metrics.

```python
mu.pl.histogram(atac, ["n_genes_by_counts", "total_counts"])
```

Now that we rudimentary filtered out cells with too few peaks and peaks detected in too few cells, we can start with ATAC specific quality control with muon.
Muon has modality specific preprocessing functions in corresponding modules.
We import the ATAC module to access the ATAC specific preprocessing functions.

```python
from muon import atac as ac
```

```python
# Perform rudimentary quality control with muon's ATAC module
atac.obs["NS"] = 1
ac.tl.locate_fragments(mdata, fragments=str(fragments))
ac.tl.locate_fragments(atac, fragments=str(fragments))
ac.tl.nucleosome_signal(atac, n=1e6)
ac.tl.get_gene_annotation_from_rna(mdata["rna"]).head(3)
tss = ac.tl.tss_enrichment(mdata, n_tss=1000)
ac.pl.tss_enrichment(tss)
```

```python
# Save original counts, normalize data and select highly variable genes with scanpy
atac.layers["counts"] = atac.X
sc.pp.normalize_per_cell(atac, counts_per_cell_after=1e4)
sc.pp.log1p(atac)
sc.pp.highly_variable_genes(atac, min_mean=0.05, max_mean=1.5, min_disp=0.5)
atac.raw = atac
```

Although PCA is also commonly used for ATAC data, latent semantic indexing (LSI) is another popular option. It is implemented in muon’s ATAC module.

```python
ac.tl.lsi(atac)
sc.pp.neighbors(atac, use_rep="X_lsi", n_neighbors=10, n_pcs=30)
sc.tl.leiden(atac, resolution=0.5, flavor="igraph", n_iterations=2)
sc.tl.umap(atac, spread=1.5, min_dist=0.5, random_state=20)
sc.pl.umap(atac, color=["leiden", "n_genes_by_counts"], legend_loc="on data")
```

We can use the functionality of the ATAC module in muon to color plots by cut values in peaks corresponding to a certain gene.

```python
ac.pl.umap(atac, color=["KLF4"], average="peak_type")
```

For more details on all available functions of muon, please read the [muon API reference](https://muon.scverse.org/stable/api.html) and the [muon tutorials](https://muon-tutorials.readthedocs.io/en/latest/).

## Questions

### Flipcards

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q1",
        "What problem does MuData solve?",
        "MuData stores and organizes multimodal single-cell data in a single container, enabling joint analysis of multiple modalities (e.g., RNA + ATAC) while keeping them linked.",
    )

    flip_card(
        "q2",
        "How does Muon relate to MuData?",
        "Muon is the analysis framework built on top of MuData, providing methods for multimodal integration, processing, and visualization.",
    )
```

### Multiple-choice questions

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    multiple_choice_question(
        question_id="q4",
        question="How would you access RNA data in a MuData object `mdata`?",
        options=[
            "mdata.rna",
            "mdata.obs['rna']",
            "mdata.mod['rna']",
            "mdata.uns['rna']",
        ],
        correct_answer="mdata.mod['rna']",
        explanations={
            "mdata.rna": "MuData does not provide direct attributes for modalities. They are stored in `mod`.",
            "mdata.obs['rna']": "`obs` stores cell-level metadata, not modality data.",
            "mdata.uns['rna']": "`uns` stores unstructured metadata, not the modality matrix.",
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

1. Virshup, I., Rybakov, S., Theis, F. J., Angerer, P., & Wolf, F. A. (2021). anndata: Annotated data. *bioRxiv*. https://doi.org/10.1101/2021.12.16.473007
2. Wolf, F. A., Angerer, P., & Theis, F. J. (2018). SCANPY: large-scale single-cell gene expression data analysis. *Genome Biology*, *19*(1), 15. https://doi.org/10.1186/s13059-017-1382-0
3. Bredikhin, D., Kats, I., & Stegle, O. (2022). MUON: multimodal omics analysis framework. *Genome Biology*, *23*(1), 42. https://doi.org/10.1186/s13059-021-02577-8
4. Palla, G., Spitzer, H., Klein, M., Fischer, D., Schaar, A. C., Kuemmerle, L. B., Rybakov, S., Ibarra, I. L., Holmberg, O., Virshup, I., Lotfollahi, M., Richter, S., & Theis, F. J. (2022). Squidpy: a scalable framework for spatial omics analysis. *Nature Methods*, *19*(2), 171–178. https://doi.org/10.1038/s41592-021-01358-2
5. Marconato, L., Palla, G., Yamauchi, K. A., Virshup, I., Heidari, E., Treis, T., Vierdag, W.-M., Toth, M., Stockhaus, S., Shrestha, R. B., Rombaut, B., Pollaris, L., Lehner, L., Vöhringer, H., Kats, I., Saeys, Y., Saka, S. K., Huber, W., Gerstung, M., … Stegle, O. (2025). SpatialData: an open and universal data framework for spatial omics. *Nature Methods*, *22*(1), 58–62. https://doi.org/10.1038/s41592-024-02212-x
