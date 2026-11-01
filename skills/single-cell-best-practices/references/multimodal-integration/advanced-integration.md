# Advanced integration

Source: https://www.sc-best-practices.org/multimodal-integration/advanced-integration  
Authors: Anastasia Litinetskaya, Lukas Heumos

**🧠 Key takeaways**

- Unpaired, reference and mosaic integration combine modalities that were not measured in the same cells, and GLUE is the most accurate method for unpaired RNA and ATAC data.
- Multimodal references let unimodal queries borrow the missing modality, but imputed values are only reliable for well-measured features.
- MultiVI integrates datasets that share only some modalities, and results should be checked against held-out measurements.

**⚙️ Environment setup**

**yml:**

```yaml
name: multimodal-integration
channels:
  - conda-forge
  - bioconda
dependencies:
  - bioconda::bedtools=2.31.1
  - conda-forge::ipykernel=7.3.0
  - conda-forge::ipywidgets=8.1.9
  - conda-forge::python=3.13.15
  - conda-forge::scanpy=1.12.4
  - pip
  - pip:
      - lamindb==2.10.0
      - mofapy2==0.7.5
      - muon==0.1.9
      - scglue==0.4.1
      - scib-metrics==0.6.1
      - scvi-tools==1.5.1
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

Modalities are often not measured in the same cells.
An RNA atlas may need to be combined with chromatin accessibility from other cells, new data may need to be mapped onto an existing multimodal reference, or datasets may share only some of their modalities.
These tasks are called unpaired (diagonal) integration, reference mapping and mosaic integration.

In independent benchmarks, GLUE was the most accurate method for unpaired RNA and ATAC data, MultiVI performed well for mosaic integration of RNA and ATAC, and totalVI predicted proteins from RNA best (Hu *et al.*, 2024 [1]; Fu *et al.*, 2025 [2]; Liu *et al.*, 2025 [3]).
We use the bone marrow data of the [previous chapter](../multimodal-integration/paired-integration.md) and hold out one modality or part of the data, so that each result can be checked against the measurements.

```python
import itertools
import logging
import warnings
from functools import partialmethod
from unittest.mock import patch

warnings.filterwarnings("ignore")
logging.getLogger("jax").setLevel(logging.ERROR)

import anndata as ad
import lamindb as ln
import mudata as md
import numpy as np
import pandas as pd
import scanpy as sc
import scglue
import scipy.sparse as sp
import scvi
from scib_metrics.benchmark import Benchmarker
from scipy.stats import spearmanr
from sklearn.neighbors import KNeighborsClassifier

scvi.settings.seed = 0

ln.connect("theislab/sc-best-practices")

ln.track("MyndPufarKGV")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
! It looks like you are running jupyter lab but don't have jupyter-server module installed. Please install it via pip install jupyter-server
→ loaded Transform('MyndPufarKGV0000', key='advanced_integration.ipynb'), started new Run('dbS3SoeXLcEuALSi') at 2026-09-30 13:18:55 UTC
→ notebook imports: anndata==0.13.2 lamindb-core==2.10.0 mudata==0.4.1 numpy==2.5.3 pandas==3.0.6 scanpy==1.12.4 scglue==0.4.1 scib-metrics==0.6.1 scikit-learn==1.9.1 scipy==1.18.1 scvi-tools==1.5.1
```

## Unpaired integration with GLUE

Without paired cells, RNA and ATAC share no features, so a method needs prior knowledge to connect them.
GLUE links each gene to the peaks near its promoter and gene body in a guidance graph and learns embeddings of the cells of both modalities that respect these links (Cao & Gao, 2022 [4]).
We take the RNA of two Multiome donors and the ATAC of the third donor, so that no cell is measured in both, and use the measured labels only to check the result.

```python
multiome = ln.Artifact.get(
    key="multimodal_integration/neurips2021_multiome.h5mu"
).load()
rna = multiome["rna"][multiome["rna"].obs["batch"].isin(["s1d1", "s1d2"])].copy()
atac = multiome["atac"][multiome["atac"].obs["batch"] == "s1d3"].copy()
rna.n_obs, atac.n_obs
```

Output:
```text
(12964, 4279)
```

GLUE reduces RNA with PCA and ATAC with LSI, reconstructs the raw counts, and needs genomic coordinates for genes and peaks to build the guidance graph.

```python
rna.layers["counts"] = rna.X.copy()
sc.pp.highly_variable_genes(rna, n_top_genes=2000, flavor="seurat_v3")
sc.pp.normalize_total(rna)
sc.pp.log1p(rna)
sc.pp.scale(rna)
sc.pp.pca(rna, n_comps=100)
scglue.data.lsi(atac, n_components=100, n_iter=15)

gtf = ln.Artifact.get(
    key="multimodal_integration/gencode.v41.basic.annotation.gtf.gz"
).cache()
scglue.data.get_gene_annotation(rna, gtf=gtf, gtf_by="gene_name")
rna = rna[:, rna.var["chrom"].notna()].copy()
coordinates = atac.var_names.str.split("-", expand=True)
atac.var["chrom"] = coordinates.get_level_values(0)
atac.var["chromStart"] = coordinates.get_level_values(1).astype(int)
atac.var["chromEnd"] = coordinates.get_level_values(2).astype(int)
guidance = scglue.genomics.rna_anchored_guidance_graph(rna, atac)
```

Output:
```text
window_graph:   0%|          | 0/12143 [00:00<?, ?it/s]
```

```python
scglue.models.configure_dataset(
    rna, "NB", use_highly_variable=True, use_layer="counts", use_rep="X_pca"
)
scglue.models.configure_dataset(atac, "NB", use_highly_variable=True, use_rep="X_lsi")
guidance_hvf = guidance.subgraph(
    itertools.chain(
        rna.var.query("highly_variable").index, atac.var.query("highly_variable").index
    )
).copy()
# scglue writes into read-only pandas 3 arrays (gao-lab/GLUE#140)
with patch.object(pd.Series, "to_numpy", partialmethod(pd.Series.to_numpy, copy=True)):
    glue = scglue.models.fit_SCGLUE({"rna": rna, "atac": atac}, guidance_hvf)
rna.obsm["X_glue"] = glue.encode_data("rna", rna)
atac.obsm["X_glue"] = glue.encode_data("atac", atac)
```

Output:
```text
[INFO] fit_SCGLUE: Pretraining SCGLUE model...
[INFO] autodevice: Using GPU 0 as computation device.
[INFO] check_graph: Checking variable coverage...
[INFO] check_graph: Checking edge attributes...
[INFO] check_graph: Checking self-loops...
[INFO] check_graph: Checking graph symmetry...
[INFO] SCGLUEModel: Setting `graph_batch_size` = 15293
[INFO] SCGLUEModel: Setting `max_epochs` = 198
[INFO] SCGLUEModel: Setting `patience` = 17
[INFO] SCGLUEModel: Setting `reduce_lr_patience` = 9
[INFO] SCGLUETrainer: Using training directory: "/tmp/GLUETMPy0dycagq"
[INFO] SCGLUETrainer: [Epoch 10] train={'g_nll': 0.463, 'g_kl': 0.011, 'g_elbo': 0.475, 'x_rna_nll': 0.3, 'x_rna_kl': 0.01, 'x_rna_elbo': 0.31, 'x_atac_nll': 0.128, 'x_atac_kl': 0.001, 'x_atac_elbo': 0.129, 'dsc_loss': 0.686, 'vae_loss': 0.458, 'gen_loss': 0.424}, val={'g_nll': 0.461, 'g_kl': 0.012, 'g_elbo': 0.473, 'x_rna_nll': 0.301, 'x_rna_kl': 0.01, 'x_rna_elbo': 0.311, 'x_atac_nll': 0.125, 'x_atac_kl': 0.001, 'x_atac_elbo': 0.127, 'dsc_loss': 0.692, 'vae_loss': 0.456, 'gen_loss': 0.421}, 1.6s elapsed
[INFO] SCGLUETrainer: [Epoch 20] train={'g_nll': 0.446, 'g_kl': 0.011, 'g_elbo': 0.457, 'x_rna_nll': 0.294, 'x_rna_kl': 0.01, 'x_rna_elbo': 0.305, 'x_atac_nll': 0.123, 'x_atac_kl': 0.001, 'x_atac_elbo': 0.124, 'dsc_loss': 0.688, 'vae_loss': 0.447, 'gen_loss': 0.412}, val={'g_nll': 0.445, 'g_kl': 0.011, 'g_elbo': 0.457, 'x_rna_nll': 0.296, 'x_rna_kl': 0.01, 'x_rna_elbo': 0.306, 'x_atac_nll': 0.12, 'x_atac_kl': 0.001, 'x_atac_elbo': 0.122, 'dsc_loss': 0.694, 'vae_loss': 0.446, 'gen_loss': 0.411}, 1.7s elapsed
[INFO] SCGLUETrainer: [Epoch 30] train={'g_nll': 0.44, 'g_kl': 0.011, 'g_elbo': 0.451, 'x_rna_nll': 0.293, 'x_rna_kl': 0.01, 'x_rna_elbo': 0.303, 'x_atac_nll': 0.122, 'x_atac_kl': 0.001, 'x_atac_elbo': 0.123, 'dsc_loss': 0.69, 'vae_loss': 0.444, 'gen_loss': 0.41}, val={'g_nll': 0.44, 'g_kl': 0.011, 'g_elbo': 0.451, 'x_rna_nll': 0.297, 'x_rna_kl': 0.01, 'x_rna_elbo': 0.307, 'x_atac_nll': 0.123, 'x_atac_kl': 0.001, 'x_atac_elbo': 0.124, 'dsc_loss': 0.688, 'vae_loss': 0.449, 'gen_loss': 0.414}, 1.5s elapsed
[INFO] LRScheduler: Learning rate reduction: step 1
[INFO] SCGLUETrainer: [Epoch 40] train={'g_nll': 0.439, 'g_kl': 0.011, 'g_elbo': 0.45, 'x_rna_nll': 0.292, 'x_rna_kl': 0.01, 'x_rna_elbo': 0.302, 'x_atac_nll': 0.122, 'x_atac_kl': 0.001, 'x_atac_elbo': 0.123, 'dsc_loss': 0.69, 'vae_loss': 0.443, 'gen_loss': 0.409}, val={'g_nll': 0.439, 'g_kl': 0.011, 'g_elbo': 0.45, 'x_rna_nll': 0.298, 'x_rna_kl': 0.01, 'x_rna_elbo': 0.308, 'x_atac_nll': 0.123, 'x_atac_kl': 0.001, 'x_atac_elbo': 0.124, 'dsc_loss': 0.688, 'vae_loss': 0.45, 'gen_loss': 0.415}, 1.8s elapsed
[INFO] LRScheduler: Learning rate reduction: step 2
[INFO] SCGLUETrainer: [Epoch 50] train={'g_nll': 0.439, 'g_kl': 0.011, 'g_elbo': 0.45, 'x_rna_nll': 0.291, 'x_rna_kl': 0.01, 'x_rna_elbo': 0.301, 'x_atac_nll': 0.122, 'x_atac_kl': 0.001, 'x_atac_elbo': 0.123, 'dsc_loss': 0.689, 'vae_loss': 0.442, 'gen_loss': 0.407}, val={'g_nll': 0.439, 'g_kl': 0.011, 'g_elbo': 0.45, 'x_rna_nll': 0.295, 'x_rna_kl': 0.01, 'x_rna_elbo': 0.305, 'x_atac_nll': 0.121, 'x_atac_kl': 0.001, 'x_atac_elbo': 0.123, 'dsc_loss': 0.687, 'vae_loss': 0.445, 'gen_loss': 0.411}, 1.9s elapsed
[INFO] EarlyStopping: Restoring checkpoint "46"...
[INFO] EarlyStopping: Restoring checkpoint "46"...
[INFO] fit_SCGLUE: Estimating balancing weight...
[INFO] estimate_balancing_weight: Clustering cells...
[INFO] estimate_balancing_weight: Matching clusters...
[INFO] estimate_balancing_weight: Matching array shape = (21, 17)...
[INFO] estimate_balancing_weight: Estimating balancing weight...
... (25 more lines)
```

```python
combined = ad.concat([rna, atac], label="modality", keys=["RNA", "ATAC"])
sc.pp.neighbors(combined, use_rep="X_glue")
sc.tl.umap(combined)
sc.pl.umap(combined, color=["modality", "cell_type_l1"], wspace=0.4)
```

RNA and ATAC cells mix within the lineages, although no cell was measured in both modalities.

A common use of unpaired integration is to annotate ATAC data with an annotated RNA reference.
We transfer the labels of the RNA cells to their nearest neighbors among the ATAC cells and compare them with the labels of the ATAC cells.

```python
labels = {}
for level in ("cell_type", "cell_type_l1"):
    knn = KNeighborsClassifier(n_neighbors=15).fit(rna.obsm["X_glue"], rna.obs[level])
    labels[level] = knn.predict(atac.obsm["X_glue"]) == atac.obs[level].to_numpy()
pd.Series({level: correct.mean() for level, correct in labels.items()}, name="accuracy")
```

Output:
```text
cell_type       0.644309
cell_type_l1    0.824959
Name: accuracy, dtype: float64
```

82% of the ATAC cells receive the correct lineage and 64% the correct fine cell type.
Most errors occur between closely related T cell states and in rare progenitors, whose differences are small in chromatin accessibility.

## Reference mapping with totalVI

A multimodal reference lets us map new data, even of a single modality, onto its embedding and predict the missing modality.
totalVI maps a query onto a trained reference by architectural surgery, which fine-tunes only the parameters of the new batches (Lotfollahi *et al.*, 2022 [5]).
We train a totalVI reference on the first three sites of the CITE-seq data and map the fourth site as if only its RNA had been measured.

```python
cite = ln.Artifact.get(key="multimodal_integration/neurips2021_cite.h5mu").load()
rna = cite["rna"].copy()
rna.obsm["protein_counts"] = pd.DataFrame(
    cite["adt"].X.toarray(), index=rna.obs_names, columns=cite["adt"].var_names
)
sc.pp.highly_variable_genes(
    rna, n_top_genes=4000, flavor="seurat_v3", batch_key="batch", subset=True
)
is_query = rna.obs["site"] == "site4"
reference, query = rna[~is_query].copy(), rna[is_query].copy()
measured = query.obsm["protein_counts"].copy()
query.obsm["protein_counts"].loc[:] = 0
reference.n_obs, query.n_obs
```

Output:
```text
(73511, 16750)
```

totalVI treats proteins that are zero in all cells of a batch as missing, so the query only contributes its RNA.

```python
scvi.model.TOTALVI.setup_anndata(
    reference, batch_key="batch", protein_expression_obsm_key="protein_counts"
)
totalvi = scvi.model.TOTALVI(reference, use_observed_lib_size=False)
totalvi.train()
totalvi_query = scvi.model.TOTALVI.load_query_data(query, totalvi)
totalvi_query.train(max_epochs=200, plan_kwargs={"weight_decay": 0.0})
reference.obsm["X_totalVI"] = totalvi.get_latent_representation()
query.obsm["X_totalVI"] = totalvi_query.get_latent_representation()
```

Output:
```text
INFO     Using column names from columns of adata.obsm['protein_counts']                                           
INFO     Computing empirical prior initialization for protein background.                                          
Training:   0%|          | 0/109 [00:00<?, ?it/s]
INFO     Found batches with missing protein expression                                                             
INFO     Computing empirical prior initialization for protein background.                                          
Training:   0%|          | 0/200 [00:00<?, ?it/s]
```

We predict the protein abundances of the query from its RNA and compare them with the held-out measurements.

```python
_, imputed = totalvi_query.get_normalized_expression(
    query, n_samples=25, return_mean=True
)
correlation = pd.Series(
    {
        protein: spearmanr(imputed[protein], measured[protein]).statistic
        for protein in measured
    },
    name="Spearman correlation",
).sort_values()
correlation.describe()
```

Output:
```text
count    134.000000
mean       0.350262
std        0.174187
min       -0.149701
25%        0.202560
50%        0.344847
75%        0.483299
max        0.750580
Name: Spearman correlation, dtype: float64
```

```python
pd.concat([correlation.head(5), correlation.tail(5)])
```

Output:
```text
PROT_CD274    -0.149701
PROT_TCRVd2    0.031028
PROT_CD23      0.054187
PROT_CD83      0.063094
PROT_CD45      0.072993
PROT_CD226     0.673451
PROT_CD35      0.700162
PROT_CD3       0.719574
PROT_CD5       0.733126
PROT_CD7       0.750580
Name: Spearman correlation, dtype: float64
```

The imputed proteins correlate with the held-out measurements with a median Spearman correlation of 0.34.
Lineage markers such as CD3, CD5 and CD7 are predicted well, whereas proteins that are rare or poorly reflected in the RNA, such as PD-L1 (CD274) and the γδ T cell receptor chain TCRVd2, are not.
Imputed values should therefore only be used for proteins whose prediction has been validated.

```python
knn = KNeighborsClassifier(n_neighbors=15).fit(
    reference.obsm["X_totalVI"], reference.obs["cell_type"]
)
predicted = knn.predict(query.obsm["X_totalVI"])
(predicted == query.obs["cell_type"].to_numpy()).mean()
```

Output:
```text
np.float64(0.6707462686567164)
```

67% of the query cells receive the correct label among the 45 fine cell types of the reference.

## Mosaic integration with MultiVI

In mosaic integration, datasets share only some modalities.
MultiVI embeds cells with any combination of RNA, chromatin accessibility and proteins, using the modalities that were measured in each cell (Ashuach *et al.*, 2023 [6]).
We integrate the CITE-seq cells of the first site with the Multiome cells of the second site, which share only their RNA.

```python
cite = cite[cite["rna"].obs["site"] == "site1"].copy()
multiome = multiome[multiome["rna"].obs["site"] == "site2"].copy()
genes = cite["rna"].var_names.intersection(multiome["rna"].var_names)
rna = ad.concat(
    [cite["rna"][:, genes], multiome["rna"][:, genes]],
    label="dataset",
    keys=["CITE-seq", "Multiome"],
)
sc.pp.highly_variable_genes(
    rna, n_top_genes=4000, flavor="seurat_v3", batch_key="batch", subset=True
)
atac = multiome["atac"][
    :, np.asarray((multiome["atac"].X > 0).mean(axis=0)).ravel() > 0.05
]
```

Cells without a modality get zero counts for it, which MultiVI interprets as missing.

```python
def fill_missing(adata: ad.AnnData, obs_names: pd.Index) -> ad.AnnData:
    missing = obs_names.difference(adata.obs_names)
    empty = ad.AnnData(
        sp.csr_matrix((len(missing), adata.n_vars)),
        obs=pd.DataFrame(index=missing),
        var=adata.var,
    )
    return ad.concat([adata, empty], merge="first")[obs_names].copy()

mosaic = md.MuData(
    {
        "rna": rna,
        "atac": fill_missing(atac, rna.obs_names),
        "adt": fill_missing(cite["adt"], rna.obs_names),
    }
)
mosaic.obs[["batch", "dataset", "cell_type_l1"]] = rna.obs[
    ["batch", "dataset", "cell_type_l1"]
]
mosaic
```

Output:
```text
MuData object with n_obs × n_vars = 31537 × 17209
  obs:	'batch', 'dataset', 'cell_type_l1'
  3 modalities
    rna:	31537 × 4000
      obs:	'cell_type', 'batch', 'site', 'donor', 'cell_type_l1', 'dataset'
      var:	'highly_variable', 'highly_variable_rank', 'means', 'variances', 'variances_norm', 'highly_variable_nbatches'
      uns:	'hvg'
      layers:	None
    atac:	31537 × 13075
      layers:	None
    adt:	31537 × 134
      layers:	None
```

```python
scvi.model.MULTIVI.setup_mudata(
    mosaic,
    batch_key="batch",
    modalities={
        "rna_layer": "rna",
        "atac_layer": "atac",
        "protein_layer": "adt",
        "batch_key": "rna",
    },
)
multivi = scvi.model.MULTIVI(
    mosaic, n_genes=mosaic["rna"].n_vars, n_regions=mosaic["atac"].n_vars
)
multivi.train()
rna.obsm["X_multiVI"] = multivi.get_latent_representation()
```

Output:
```text
INFO     Found batches with missing protein expression                                                             
Training:   0%|          | 0/500 [00:00<?, ?it/s]
Monitored metric reconstruction_loss_validation did not improve in the last 50 records. Best score: 3780.102. Signaling Trainer to stop.
```

```python
sc.pp.neighbors(rna, use_rep="X_multiVI")
sc.tl.umap(rna)
sc.pl.umap(rna, color=["dataset", "cell_type_l1"], wspace=0.4)
```

Lymphocytes of both datasets mix within their lineages, whereas monocytes and erythroid cells remain partly separated by dataset, which may reflect differences between the sites as well as between the assays.

```python
sc.pp.pca(rna, n_comps=30)
benchmark = Benchmarker(
    rna,
    batch_key="dataset",
    label_key="cell_type_l1",
    embedding_obsm_keys=["X_pca", "X_multiVI"],
    pre_integrated_embedding_obsm_key="X_pca",
)
benchmark.benchmark()
```

Output:
```text
INFO     Other T consists of a single batch or is too small. Skip.                                                 
INFO     Other T consists of a single batch or is too small. Skip.                                                 
```

```python
_ = benchmark.plot_results_table(min_max_scale=False)
```

MultiVI improves cell type conservation and batch mixing over the PCA of the shared genes, but the low iLISI and kBET scores confirm that the datasets are not fully mixed.
Mosaic integrations therefore have to be checked against known cell types or held-out modalities before the joint embedding is used for downstream analyses.

## Further methods

Seurat’s bridge integration maps unimodal queries onto a reference through a multimodal bridge dataset and was among the best methods for transferring labels from RNA to ATAC data (Hao *et al.*, 2024 [7]; Wang & Zhao, 2026 [8]), but it is only available in R.
For mosaic data of RNA and proteins, MIDAS and StabMap performed best in benchmarks, and MIDAS imputed missing modalities most accurately (He *et al.*, 2024 [9]; Ghazanfar *et al.*, 2024 [10]; Fu *et al.*, 2025 [2]).
As in any integration, the results should be checked against known cell types and the measured modalities, as we did above.

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Anastasia Litinetskaya

### Reviewers

- Lukas Heumos

## References

1. Hu, Y., Wan, S., Luo, Y., Li, Y., Wu, T., Deng, W., Jiang, C., Jiang, S., Zhang, Y., Liu, N., Yang, Z., Chen, F., Li, B., & Qu, K. (2024). Benchmarking algorithms for single-cell multi-omics prediction and integration. *Nature Methods*, *21*(11), 2182–2194. https://doi.org/10.1038/s41592-024-02429-w
2. Fu, S., Wang, S., Si, D., Li, G., Gao, Y., & Liu, Q. (2025). Benchmarking single-cell multi-modal data integrations. *Nature Methods*, *22*(11), 2437–2448. https://doi.org/10.1038/s41592-025-02737-9
3. Liu, C., Ding, S., Kim, H. J., Long, S., Xiao, D., Ghazanfar, S., & Yang, P. (2025). Multitask benchmarking of single-cell multimodal omics integration methods. *Nature Methods*, *22*(11), 2449–2460. https://doi.org/10.1038/s41592-025-02856-3
4. Cao, Z.-J., & Gao, G. (2022). Multi-omics single-cell data integration and regulatory inference with graph-linked embedding. *Nature Biotechnology*, *40*(10), 1458–1466. https://doi.org/10.1038/s41587-022-01284-4
5. Lotfollahi, M., Naghipourfar, M., Luecken, M. D., Khajavi, M., Büttner, M., Wagenstetter, M., Avsec, Ž., Gayoso, A., Yosef, N., Interlandi, M., Rybakov, S., Misharin, A. V., & Theis, F. J. (2022). Mapping single-cell data to reference atlases by transfer learning. *Nature Biotechnology*, *40*(1), 121–130. https://doi.org/10.1038/s41587-021-01001-7
6. Ashuach, T., Gabitto, M. I., Koodli, R. V., Saldi, G.-A., Jordan, M. I., & Yosef, N. (2023). MultiVI: deep generative model for the integration of multimodal data. *Nature Methods*, *20*(8), 1222–1231. https://doi.org/10.1038/s41592-023-01909-9
7. Hao, Y., Stuart, T., Kowalski, M. H., Choudhary, S., Hoffman, P., Hartman, A., Srivastava, A., Molla, G., Madad, S., Fernandez-Granda, C., & Satija, R. (2024). Dictionary learning for integrative, multimodal and scalable single-cell analysis. *Nature Biotechnology*, *42*(2), 293–304. https://doi.org/10.1038/s41587-023-01767-y
8. Wang, Y., & Zhao, H. (2026). A comprehensive benchmarking study on computational tools for cross-omics label transfer from single-cell RNA to ATAC data. *G3: Genes, Genomes, Genetics*, *16*(4), jkag026. https://doi.org/10.1093/g3journal/jkag026
9. He, Z., Hu, S., Chen, Y., An, S., Zhou, J., Liu, R., Shi, J., Wang, J., Dong, G., Shi, J., Zhao, J., Ou-Yang, L., Zhu, Y., Bo, X., & Ying, X. (2024). Mosaic integration and knowledge transfer of single-cell multimodal data with MIDAS. *Nature Biotechnology*, *42*(10), 1594–1605. https://doi.org/10.1038/s41587-023-02040-y
10. Ghazanfar, S., Guibentif, C., & Marioni, J. C. (2024). Stabilized mosaic single-cell data integration using unshared features. *Nature Biotechnology*, *42*(2), 284–292. https://doi.org/10.1038/s41587-023-01766-z
