# Doublet detection

Source: https://www.sc-best-practices.org/surface-protein/doublet-detection  
Authors: Javier Marchena-Hurtado, Daniel Strobl, Ciro Ramírez-Suástegui, Lukas Heumos, Anna Schaar

**🧠 Key takeaways**

- Heterotypic doublets in ADT data can be identified and removed using mutually exclusive cell type markers (e.g., CD3, CD19, CD14), with cells expressing both markers likely representing doublets.

**⚙️ Environment setup**

**yml:**

```yaml
name: surface-protein
channels:
  - conda-forge
dependencies:
  - python=3.13
  - scanpy=1.12
  - muon=0.1.9
  - python-igraph=1.0.0
  - ipykernel=7.2.0
  - pip==26.0.1
  - pip:
      - lamindb==2.3.1
      - harmonypy==0.0.9
      - ipywidgets==8.1.8
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

In the [Quality Control](../surface-protein/quality-control.md#surface-protein-quality-control) chapter, we removed cells that potentially reflect doublets based only on their high count content.
We also filtered cells based on sample-wise distribution.
Now, we will focus on heterotypic doublets, that is, doublets that contain cells from different cell types.
With ADT data, we can detect them using cell type specific surface markers(Sun *et al.*, 2021 [1]).

## Environment setup

```python
import warnings

import scanpy as sc

warnings.filterwarnings("ignore")
sc.settings.verbosity = 0
sc.set_figure_params(
    dpi=80,
    facecolor="white",
    frameon=False,
)

import lamindb as ln

ln.connect("theislab/sc-best-practices")

ln.track("xo1WtNUmrJCK")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ found notebook doublet_detection.ipynb, making new version -- anticipating changes
→ created Transform('xo1WtNUmrJCK0007', key='doublet_detection.ipynb'), re-started Run('33z2HhX1JxiWbGxS') at 2026-07-29 11:07:33 UTC
→ notebook imports: lamindb-core==2.3.1 muon==0.1.9 scanpy==1.12.3
• recommendation: to identify the notebook across renames, pass the uid: ln.track("xo1WtNUmrJCK")
```

## Loading the data

We load the MuData object we saved at the end of the previous chapter, [Normalization](../surface-protein/normalization.md):

```python
af = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="surface-protein/cite_normalization.h5mu", is_latest=True
)
mdata = af.load()
mdata
```

## Doublets detected with cell type markers

We are now going to look at cell type markers that are mutually exclusive.
An example is CD3 (T cell marker) vs CD19 (B cell marker) to identify T/B cells doublets.
As cells expressing both specific B and T cell markers do not exist under physiological conditions, those droplets contain T/B cell doublets.

The same is true for cells expressing both T cell (CD3) and monocyte (CD14) markers.

```python
sc.pl.scatter(mdata["prot"], x="CD3", y="CD19-1", color="log1p_total_counts")
```

In this plot, we can see a large number of cells not expressing T or B cell markers in the lower left, cells expressing only one marker in the upper left and lower right as well as some cells expressing both markers (upper right).

The cells expressing both markers are doublets and can be removed.

We can also use CD3 and CD14 to detect T/monocyte doublets.

```python
sc.pl.scatter(mdata["prot"], x="CD3", y="CD14-1", color="log1p_total_counts")
```

It looks like cells that have an expression level above 25 in both markers are doublets.
We use an expression level above 25 in both markers to flag doublets.

```python
genes2filter = ["CD3", "CD19-1", "CD14-1"]
temp = mdata["prot"][:, genes2filter].X.T.tolist()
```

```python
mdata["prot"].obs["doublets_markers"] = [
    (temp[0][i] > 25 and temp[1][i] > 25) or (temp[0][i] > 25 and temp[2][i] > 25)
    for i in range(mdata.shape[0])
]
mdata["prot"].obs["doublets_markers"] = (
    mdata["prot"].obs["doublets_markers"].astype(str)
)
```

Doublets usually have a higher count due to the presence of increased counts from more than one cell.
We can see this effect in the cells classified as doublets using our markers:

```python
sc.pl.violin(mdata["prot"], keys="log1p_total_counts", groupby="doublets_markers")
```

We leave out cells expressing both markers.

```python
mdata = mdata[mdata["prot"].obs["doublets_markers"] == "False"].copy()
mdata
```

We removed 608 doublets from the data.

In this chapter, we removed doublets using the ADT data by removing cells that highly expressed two mutually exclusive markers.
Another option to remove doublets would be utilizing methods that detect doublets based on the scRNA-seq data.
For those methods, we refer to the [Doublet Detection](../preprocessing-visualization/quality-control.md#rna-doublet-detection) chapter of scRNA-seq preprocessing and visualization.

```python
af_doublet_detection = ln.Artifact.from_mudata(
    mdata,
    key="surface-protein/cite_doublet_detection.h5mu",
    description="CITE-seq data after doublet detection",
)
af_doublet_detection.save()
```

Output:
```text
→ returning artifact with same hash: Artifact(uid='I1sQCEySclEA4f2N0005', key='surface-protein/cite_doublet_detection.h5mu', description='CITE-seq data after doublet detection', suffix='.h5mu', kind='dataset', otype='MuData', size=1452761836, hash='FhXN0hS1nI7WfLBybIFE9g', n_files=None, n_observations=105907, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=112, schema_id=None, created_by_id=7, created_at=2026-07-29 11:07:15 UTC, is_locked=False, version_tag=None, is_latest=True); to track this artifact as an input, use: ln.Artifact.get()
... uploading tu0VvP9QqQazgAiZ0000.h5mu: 100.0%
• replacing the existing cache path /var/cache/user/marchena/.cache/lamindb/lamin-eu-central-1/VPwcjx3CDAa2/surface-protein/cite_doublet_detection.h5mu
Artifact(uid='I1sQCEySclEA4f2N0005', key='surface-protein/cite_doublet_detection.h5mu', description='CITE-seq data after doublet detection', suffix='.h5mu', kind='dataset', otype='MuData', size=1452761836, hash='FhXN0hS1nI7WfLBybIFE9g', n_files=None, n_observations=105907, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=112, schema_id=None, created_by_id=7, created_at=2026-07-29 11:07:15 UTC, is_locked=False, version_tag=None, is_latest=True)
```

```python
ln.finish()
```

Output:
```text
• please hit CTRL + s to save the notebook in your editor ... ✓
→ finished Run('33z2HhX1JxiWbGxS') after 27s at 2026-07-29 11:08:00 UTC
→ go to: https://lamin.ai/theislab/sc-best-practices/transform/xo1WtNUmrJCK0007
→ to update your notebook from the CLI, run: lamin save /groups/nils/members/javier/single-cell-best-practices/jupyter-book/surface_protein/doublet_detection.ipynb
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Javier Marchena-Hurtado
- Daniel Strobl
- Ciro Ramírez-Suástegui

### Reviewers

- Lukas Heumos
- Anna Schaar

## References

1. Sun, B., Bugarin-Estrada, E., Overend, L. E., Walker, C. E., Tucci, F. A., & Bashford-Rogers, R. J. M. (2021). Double-jeopardy: scRNA-seq doublet/multiplet detection using multi-omic profiling. *Cell Reports Methods*, *1*(1), 100008. https://doi.org/10.1016/j.crmeth.2021.100008
