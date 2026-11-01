# Batch correction

Source: https://www.sc-best-practices.org/surface-protein/batch-correction  
Authors: Javier Marchena-Hurtado, Daniel Strobl, Ciro Ramírez-Suástegui, Lukas Heumos, Anna Schaar

**🧠 Key takeaways**

- Due to pronounced batch effects in ADT data, methods like Harmony, originally designed for transcriptomics data, are recommended for batch correction, as they effectively integrate samples and maintain cell type separation.

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

As could be seen for our earlier visualized ADT data, batch effects between donors are very pronounced (see [Dimensionality Reduction](../surface-protein/dimensionality-reduction.md)).
Hence, batch correction to mitigate this effect is required.

We use Harmony here.
There is no benchmarking of different batch correction methods for ADT data.
We therefore use Harmony, a method that has been benchmarked for scRNA-seq data with good results.

Recently two batch correction methods for ADT data have been published in reputable journals and/or by reputable authors: ADTnorm (Zheng *et al.*, 2025 [1]) and CytoVI (Ingelfinger *et al.*, 2025 [2]).
These two methods might be appropriate for ADT data.
However, as mentioned, here we stick to Harmony, which is more proven and independently benchmarked (although for transcriptomics and not for ADT data).

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

ln.track("4LJehi0GPRuj")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ found notebook batch_correction.ipynb, making new version -- anticipating changes
→ created Transform('4LJehi0GPRuj0006', key='batch_correction.ipynb'), started new Run('nxVysIoDJ9QSryHS') at 2026-07-29 11:11:33 UTC
→ notebook imports: lamindb-core==2.3.1 muon==0.1.9 scanpy==1.12.3
• recommendation: to identify the notebook across renames, pass the uid: ln.track("4LJehi0GPRuj")
```

## Loading the data

We load the MuData object we saved at the end of the previous chapter, [Dimensionality Reduction](../surface-protein/dimensionality-reduction.md):

```python
af = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="surface-protein/cite_dimensionality_reduction.h5mu", is_latest=True
)
mdata = af.load()
mdata
```

## Harmony

It is not yet clear which batch effect correction works best for ADT data.
For general purposes we recommend Harmony (Korsunsky *et al.*, 2019 [3]) to perform batch correction of the data due to its robust performance on scRNA-seq data.

```python
sc.external.pp.harmony_integrate(adata=mdata["prot"], key="donor", random_state=0)
```

We now compute a neighborhood graph from the Harmony-corrected PCA and a [UMAP](../glossary.md#term-uniform-manifold-approximation-and-projection-umap) embedding to visualize the study’s variables.

```python
sc.pp.neighbors(mdata["prot"], n_pcs=20, use_rep="X_pca_harmony", random_state=0)
sc.tl.umap(mdata["prot"], random_state=0)
```

```python
sc.pl.umap(mdata["prot"], color=["donor", "batch"])
```

As we can see here, the cells of different donors are much more intermixed in the embedding than before (see plots from the [Dimensionality Reduction](../surface-protein/dimensionality-reduction.md) chapter).

```python
sc.pl.umap(mdata["prot"], color=["CD4-1", "CD8", "CD3"])
sc.pl.umap(mdata["prot"], color=["CD14-1", "CD16"])
```

We check the expression of a few marker genes to confirm that separate cell types are still separate from each other.
We can see that T cells still form a separate population that is further split into CD4 and CD8 T cells.
Additionally, unlike before batch correction, now CD4 T cells form a discrete cluster where the donors are intermingled.
Batch correction was therefore successful.

```python
af_batch_correction = ln.Artifact.from_mudata(
    mdata,
    key="surface-protein/cite_batch_correction.h5mu",
    description="CITE-seq data after batch correction",
)
af_batch_correction.save()
```

Output:
```text
→ creating new artifact version for key 'surface-protein/cite_batch_correction.h5mu' in storage 's3://lamin-eu-central-1/VPwcjx3CDAa2'
... uploading uu6lLafald9WnYWL0006.h5mu: 100.0%
• replacing the existing cache path /var/cache/user/marchena/.cache/lamindb/lamin-eu-central-1/VPwcjx3CDAa2/surface-protein/cite_batch_correction.h5mu
Artifact(uid='uu6lLafald9WnYWL0006', key='surface-protein/cite_batch_correction.h5mu', description='CITE-seq data after batch correction', suffix='.h5mu', kind='dataset', otype='MuData', size=1449791144, hash='aYPsyP7ViUyvXh9Ss2YpzB', n_files=None, n_observations=105907, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=114, schema_id=None, created_by_id=7, created_at=2026-07-29 11:15:27 UTC, is_locked=False, version_tag=None, is_latest=True)
```

```python
ln.finish()
```

Output:
```text
• please hit CTRL + s to save the notebook in your editor .... still waiting .....
....................! please hit CTRL + s to save the notebook in your editor and re-run finish()
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

1. Zheng, Y., Caron, D. P., Kim, J. Y., Jun, S.-H., Tian, Y., Mair, F., Stuart, K. D., Sims, P. A., & Gottardo, R. (2025). ADTnorm: robust integration of single-cell protein measurement across CITE-seq datasets. *Nature Communications*, *16*(1), 5852.
2. Ingelfinger, F., Levy, N., Ergen, C., Bakulin, A., Becker, A., Boyeau, P., Kim, M., Ditz, D., Dirks, J., Maaskola, J., & others. (2025). CytoVI: Deep generative modeling of antibody-based single cell technologies. *bioRxiv*, 2025–09.
3. Korsunsky, I., Millard, N., Fan, J., Slowikowski, K., Zhang, F., Wei, K., Baglaenko, Y., Brenner, M., Loh, P., & Raychaudhuri, S. (2019). Fast, sensitive and accurate integration of single-cell data with Harmony. *Nature Methods*, *16*(12), 1289–1296. https://doi.org/10.1038/s41592-019-0619-0
