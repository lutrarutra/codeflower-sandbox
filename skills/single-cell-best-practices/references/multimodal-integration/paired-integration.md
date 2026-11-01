# Paired integration

Source: https://www.sc-best-practices.org/multimodal-integration/paired-integration  
Authors: Anastasia Litinetskaya, Lukas Heumos

**🧠 Key takeaways**

- Paired integration combines modalities measured in the same cells into one representation, and no method is best for every dataset.
- Integrated embeddings should be scored against the unimodal embeddings with metrics for cell type conservation and batch mixing.
- WNN is a strong baseline for CITE-seq and Multiome data, and totalVI and MultiVI additionally model raw counts and batch effects.

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

Assays such as CITE-seq and 10x Multiome measure two modalities in the same cells: gene expression together with surface proteins or with chromatin accessibility.
Integrating them yields one representation per cell that combines the information of both modalities, which is called paired or vertical integration.
The modalities differ in their number of features, from about a hundred proteins to more than 100,000 peaks, and in their noise and count distributions, so each needs its own preprocessing or likelihood.

Three recent benchmarks agree that no method is best for every dataset (Hu *et al.*, 2024 [1]; Fu *et al.*, 2025 [2]; Liu *et al.*, 2025 [3]).
Weighted nearest neighbors (WNN) ranked at or near the top for both CITE-seq and Multiome data, and totalVI ranked among the best methods for CITE-seq, especially across batches.
We integrate a CITE-seq and a Multiome dataset with these methods, compare them with MOFA+ and MultiVI, and score all embeddings against the unimodal ones.

## Dataset

We use bone marrow mononuclear cells of the NeurIPS 2021 multimodal integration challenge, which were measured with CITE-seq and with 10x Multiome at four sites (Luecken *et al.*, 2021 [4]).
To keep run times short, we use the three donors of the first site, whose samples still form three batches.

```python
import logging
import warnings

warnings.filterwarnings("ignore")
logging.getLogger("jax").setLevel(logging.ERROR)

import anndata as ad
import lamindb as ln
import muon as mu
import scanpy as sc
import scvi
from scib_metrics.benchmark import Benchmarker

scvi.settings.seed = 0

ln.connect("theislab/sc-best-practices")

ln.track("m4RWUGhX2RO8")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
! It looks like you are running jupyter lab but don't have jupyter-server module installed. Please install it via pip install jupyter-server
→ loaded Transform('m4RWUGhX2RO80000', key='paired_integration.ipynb'), started new Run('4RAPew33xe4LCOAE') at 2026-09-30 12:52:59 UTC
→ notebook imports: anndata==0.13.2 lamindb-core==2.10.0 muon==0.1.9 scanpy==1.12.4 scib-metrics==0.6.1 scvi-tools==1.5.1
```

## CITE-seq

The CITE-seq data contain the raw counts of 13,953 genes and 134 surface proteins.

```python
mdata = ln.Artifact.get(key="multimodal_integration/neurips2021_cite.h5mu").load()
mdata = mdata[mdata["rna"].obs["site"] == "site1"].copy()
mdata.pull_obs()
rna, adt = mdata["rna"], mdata["adt"]
mdata
```

Output:
```text
MuData object with n_obs × n_vars = 16311 × 14087
  2 modalities
    rna:	16311 × 13953
      obs:	'cell_type', 'batch', 'site', 'donor', 'cell_type_l1'
      var:	'gene_id'
      layers:	None
    adt:	16311 × 134
      obs:	'cell_type', 'batch', 'site', 'donor', 'cell_type_l1'
      layers:	None
```

We normalize the gene expression with the shifted logarithm and select highly variable genes as described in the [preprocessing chapters](../preprocessing-visualization/normalization.md).
Protein counts are normalized with the centered log ratio (CLR) transformation as described in the [surface protein chapter](../surface-protein/normalization.md).
Both modalities keep their raw counts in a layer for the count-based models.

```python
for data in (rna, adt):
    data.layers["counts"] = data.X.copy()
sc.pp.normalize_total(rna)
sc.pp.log1p(rna)
sc.pp.highly_variable_genes(rna, n_top_genes=4000, batch_key="batch")
sc.pp.pca(rna, mask_var="highly_variable")
adt.X = adt.X.tocsc()
mu.prot.pp.clr(adt)
sc.pp.pca(adt, n_comps=30)
embeddings = ad.AnnData(obs=rna.obs[["cell_type", "cell_type_l1", "batch"]])
embeddings.obsm["RNA"] = rna.obsm["X_pca"]
embeddings.obsm["Protein"] = adt.obsm["X_pca"]
```

### Weighted nearest neighbors

WNN learns for every cell how informative each modality is, based on how well the neighbors in one modality predict its profile in the other, and combines the neighbor graphs of both modalities with these weights (Hao *et al.*, 2021 [5]).
muon implements WNN on top of the neighbor graphs of the individual modalities (Bredikhin *et al.*, 2022 [6]).

```python
sc.pp.neighbors(rna)
sc.pp.neighbors(adt)
mu.pp.neighbors(mdata, key_added="wnn")
mu.tl.umap(mdata, neighbors_key="wnn")
mu.pl.umap(mdata, color=["rna:cell_type_l1", "rna:batch"], wspace=0.4)
```

WNN separates the lineages clearly, but cells of the same type still split by donor, since WNN combines the neighbor graphs of the uncorrected modalities.
With several batches, WNN therefore needs batch-corrected inputs for each modality.

### MOFA+

MOFA+ is a linear factor model that decomposes all modalities into a small number of factors, whose feature weights make them interpretable (Argelaguet *et al.*, 2020 [7]).
We fit 20 factors on the highly variable genes and all proteins, and let MOFA+ model the three batches as groups.

```python
adt.var["highly_variable"] = True
mdata.pull_var("highly_variable")
mu.tl.mofa(
    mdata, groups_label="rna:batch", use_var="highly_variable", n_factors=20, quiet=True
)
```

Output:
```text
        #########################################################
        ###           __  __  ____  ______                    ### 
        ###          |  \/  |/ __ \|  ____/\    _             ### 
        ###          | \  / | |  | | |__ /  \ _| |_           ### 
        ###          | |\/| | |  | |  __/ /\ \_   _|          ###
        ###          | |  | | |__| | | / ____ \|_|            ###
        ###          |_|  |_|\____/|_|/_/    \_\              ###
        ###                                                   ### 
        ######################################################### 
         
Loaded view='rna' group='s1d1' with N=5227 samples and D=4000 features...
Loaded view='rna' group='s1d2' with N=4978 samples and D=4000 features...
Loaded view='rna' group='s1d3' with N=6106 samples and D=4000 features...
Loaded view='adt' group='s1d1' with N=5227 samples and D=134 features...
Loaded view='adt' group='s1d2' with N=4978 samples and D=134 features...
Loaded view='adt' group='s1d3' with N=6106 samples and D=134 features...
Model options:
- Automatic Relevance Determination prior on the factors: True
- Automatic Relevance Determination prior on the weights: True
- Spike-and-slab prior on the factors: False
- Spike-and-slab prior on the weights: True
Likelihoods:
- View 0 (rna): gaussian
- View 1 (adt): gaussian

... (16 more lines)
```

### totalVI

totalVI is a variational autoencoder that models the RNA counts with a negative binomial distribution and the protein counts as a mixture of foreground and background, which accounts for the unspecific binding of antibodies (Gayoso *et al.*, 2021 [8]).
It corrects batch effects in the same model and takes the raw counts of both modalities as input.

```python
rna_hvg = rna[:, rna.var["highly_variable"]].copy()
rna_hvg.obsm["protein_counts"] = adt.layers["counts"].toarray()
scvi.model.TOTALVI.setup_anndata(
    rna_hvg,
    layer="counts",
    batch_key="batch",
    protein_expression_obsm_key="protein_counts",
)
totalvi = scvi.model.TOTALVI(rna_hvg)
totalvi.train()
embeddings.obsm["totalVI"] = totalvi.get_latent_representation()
```

Output:
```text
INFO     Generating sequential column names                                                                        
INFO     Computing empirical prior initialization for protein background.                                          
Training:   0%|          | 0/400 [00:00<?, ?it/s]
```

```python
sc.pp.neighbors(embeddings, use_rep="totalVI")
sc.tl.umap(embeddings)
sc.pl.umap(embeddings, color=["cell_type_l1", "batch"], wspace=0.4)
```

totalVI mixes the three donors within each cell type, since it models the batches together with both modalities.

### Evaluation

We score the embeddings with the scIB metrics, which measure how well cell types are conserved and batches are mixed (Luecken *et al.*, 2022 [9]).
scib-metrics replaces the silhouette-based batch metric by BRAS, since silhouette scores can reward embeddings that do not remove batch effects (Rautenstrauch & Ohler, 2026 [10]).
The PCA embeddings of the individual modalities serve as baselines, and the WNN graph cannot be scored with these embedding-based metrics.

```python
embeddings.obsm["MOFA+"] = mdata.obsm["X_mofa"]
benchmark = Benchmarker(
    embeddings,
    batch_key="batch",
    label_key="cell_type",
    embedding_obsm_keys=["RNA", "Protein", "MOFA+", "totalVI"],
    pre_integrated_embedding_obsm_key="RNA",
)
benchmark.benchmark()
```

Output:
```text
INFO     Diffusion distance failed. Skip.                                                                          
INFO     CD8+ T CD57+ CD45RO+ consists of a single batch or is too small. Skip.                                    
INFO     CD8+ T naive CD127+ CD26- CD101- consists of a single batch or is too small. Skip.                        
INFO     ILC consists of a single batch or is too small. Skip.                                                     
INFO     Plasma cell IGKC- consists of a single batch or is too small. Skip.                                       
INFO     dnT consists of a single batch or is too small. Skip.                                                     
INFO     Diffusion distance failed. Skip.                                                                          
INFO     CD8+ T CD57+ CD45RO+ consists of a single batch or is too small. Skip.                                    
INFO     CD8+ T naive CD127+ CD26- CD101- consists of a single batch or is too small. Skip.                        
INFO     ILC consists of a single batch or is too small. Skip.                                                     
INFO     Plasma cell IGKC- consists of a single batch or is too small. Skip.                                       
INFO     dnT consists of a single batch or is too small. Skip.                                                     
INFO     Diffusion distance failed. Skip.                                                                          
INFO     CD8+ T CD57+ CD45RO+ consists of a single batch or is too small. Skip.                                    
INFO     CD8+ T naive CD127+ CD26- CD101- consists of a single batch or is too small. Skip.                        
INFO     ILC consists of a single batch or is too small. Skip.                                                     
INFO     Plasma cell IGKC- consists of a single batch or is too small. Skip.                                       
INFO     dnT consists of a single batch or is too small. Skip.                                                     
INFO     Diffusion distance failed. Skip.                                                                          
INFO     CD8+ T CD57+ CD45RO+ consists of a single batch or is too small. Skip.                                    
INFO     CD8+ T naive CD127+ CD26- CD101- consists of a single batch or is too small. Skip.                        
INFO     ILC consists of a single batch or is too small. Skip.                                                     
INFO     Plasma cell IGKC- consists of a single batch or is too small. Skip.                                       
INFO     dnT consists of a single batch or is too small. Skip.                                                     
```

```python
_ = benchmark.plot_results_table(min_max_scale=False)
```

totalVI achieves the best overall score, mainly because it removes the batch effects, whereas all embeddings conserve the cell types similarly well.
MOFA+ conserves cell types as well as the RNA alone, and its factors can additionally be interpreted through their gene and protein weights.

## Multiome

Chromatin accessibility is measured in more than 100,000 peaks and is very sparse.
We reduce it with latent semantic indexing (LSI), which applies a singular value decomposition to the TF-IDF normalized counts, and drop the first component, which mostly captures sequencing depth, as described in the [chromatin accessibility chapters](../chromatin-accessibility/introduction.md).

```python
mdata = ln.Artifact.get(key="multimodal_integration/neurips2021_multiome.h5mu").load()
mdata = mdata[mdata["rna"].obs["site"] == "site1"].copy()
mdata.pull_obs()
rna, atac = mdata["rna"], mdata["atac"]
for data in (rna, atac):
    data.layers["counts"] = data.X.copy()
sc.pp.normalize_total(rna)
sc.pp.log1p(rna)
sc.pp.highly_variable_genes(rna, n_top_genes=4000, batch_key="batch")
sc.pp.pca(rna, mask_var="highly_variable")
mu.atac.pp.tfidf(atac, scale_factor=1e4)
mu.atac.tl.lsi(atac)
atac.obsm["X_lsi"] = atac.obsm["X_lsi"][:, 1:]
embeddings = ad.AnnData(obs=rna.obs[["cell_type", "cell_type_l1", "batch"]])
embeddings.obsm["RNA"] = rna.obsm["X_pca"]
embeddings.obsm["ATAC"] = atac.obsm["X_lsi"]
```

### Weighted nearest neighbors

```python
sc.pp.neighbors(rna)
sc.pp.neighbors(atac, use_rep="X_lsi")
mu.pp.neighbors(mdata, key_added="wnn")
mu.tl.umap(mdata, neighbors_key="wnn")
mu.pl.umap(mdata, color=["rna:cell_type_l1", "rna:batch"], wspace=0.4)
```

### MultiVI

MultiVI extends the variational autoencoder of scVI to chromatin accessibility and learns a joint embedding from the raw counts of both modalities (Ashuach *et al.*, 2023 [11]).
It models whether a region is accessible rather than how many fragments it contains, although fragment counts carry additional information (Martens *et al.*, 2024 [12]).

```python
mdata_hvg = mdata[
    :, mdata["rna"].var_names[rna.var["highly_variable"]].append(atac.var_names)
].copy()
scvi.model.MULTIVI.setup_mudata(
    mdata_hvg,
    rna_layer="counts",
    atac_layer="counts",
    batch_key="batch",
    modalities={"rna_layer": "rna", "atac_layer": "atac", "batch_key": "rna"},
)
multivi = scvi.model.MULTIVI(
    mdata_hvg, n_genes=mdata_hvg["rna"].n_vars, n_regions=mdata_hvg["atac"].n_vars
)
multivi.train()
embeddings.obsm["MultiVI"] = multivi.get_latent_representation()
```

Output:
```text
Training:   0%|          | 0/500 [00:00<?, ?it/s]
Monitored metric reconstruction_loss_validation did not improve in the last 50 records. Best score: 12224.635. Signaling Trainer to stop.
```

```python
sc.pp.neighbors(embeddings, use_rep="MultiVI")
sc.tl.umap(embeddings)
sc.pl.umap(embeddings, color=["cell_type_l1", "batch"], wspace=0.4)
```

```python
benchmark = Benchmarker(
    embeddings,
    batch_key="batch",
    label_key="cell_type",
    embedding_obsm_keys=["RNA", "ATAC", "MultiVI"],
    pre_integrated_embedding_obsm_key="RNA",
)
benchmark.benchmark()
```

Output:
```text
INFO     CD8+ T naive consists of a single batch or is too small. Skip.                                            
INFO     CD8+ T naive consists of a single batch or is too small. Skip.                                            
INFO     CD8+ T naive consists of a single batch or is too small. Skip.                                            
```

```python
_ = benchmark.plot_results_table(min_max_scale=False)
```

MultiVI mixes the batches better than either modality alone and conserves cell types slightly better, which gives it the best overall score.
The gain from adding a second modality is modest in this dataset, whose cell types are already well separated in the RNA.

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
4. Luecken, M. D., Burkhardt, D. B., Cannoodt, R., Lance, C., Agrawal, A., Aliee, H., Chen, A. T., Deconinck, L., Detweiler, A. M., Granados, A. A., Huynh, S., Isacco, L., Kim, Y. J., Klein, D., KUMAR, B. D., Kuppasani, S., Lickert, H., McGeever, A., Mekonen, H., … Bloom, J. M. (2021). A sandbox for prediction and integration of DNA, RNA, and proteins in single cells. *Thirty-Fifth Conference on Neural Information Processing Systems Datasets and Benchmarks Track (Round 2)*. https://openreview.net/forum?id=gN35BGa1Rt
5. Hao, Y., Hao, S., Andersen-Nissen, E., Mauck, W. M., Zheng, S., Butler, A., Lee, M. J., Wilk, A. J., Darby, C., Zager, M., Hoffman, P., Stoeckius, M., Papalexi, E., Mimitou, E. P., Jain, J., Srivastava, A., Stuart, T., Fleming, L. M., Yeung, B., … Satija, R. (2021). Integrated analysis of multimodal single-cell data. *Cell*, *184*(13), 3573-3587.e29. https://doi.org/10.1016/j.cell.2021.04.048
6. Bredikhin, D., Kats, I., & Stegle, O. (2022). MUON: multimodal omics analysis framework. *Genome Biology*, *23*(1), 42. https://doi.org/10.1186/s13059-021-02577-8
7. Argelaguet, R., Arnol, D., Bredikhin, D., Deloro, Y., Velten, B., Marioni, J. C., & Stegle, O. (2020). MOFA+: a statistical framework for comprehensive integration of multi-modal single-cell data. *Genome Biology*, *21*(1), 111. https://doi.org/10.1186/s13059-020-02015-1
8. Gayoso, A., Steier, Z., Lopez, R., Regier, J., Nazor, K. L., Streets, A., & Yosef, N. (2021). Joint probabilistic modeling of single-cell multi-omic data with totalVI. *Nature Methods*, *18*(3), 272–282. https://doi.org/10.1038/s41592-020-01050-x
9. Luecken, M. D., Büttner, M., Chaichoompu, K., Danese, A., Interlandi, M., Mueller, M. F., Strobl, D. C., Zappia, L., Dugas, M., Colomé-Tatché, M., & Theis, F. J. (2022). Benchmarking atlas-level data integration in single-cell genomics. *Nature Methods*, *19*(1), 41–50. https://doi.org/10.1038/s41592-021-01336-8
10. Rautenstrauch, P., & Ohler, U. (2026). Shortcomings of silhouette in single-cell integration benchmarking. *Nature Biotechnology*, *44*(6), 954–958. https://doi.org/10.1038/s41587-025-02743-4
11. Ashuach, T., Gabitto, M. I., Koodli, R. V., Saldi, G.-A., Jordan, M. I., & Yosef, N. (2023). MultiVI: deep generative model for the integration of multimodal data. *Nature Methods*, *20*(8), 1222–1231. https://doi.org/10.1038/s41592-023-01909-9
12. Martens, L. D., Fischer, D. S., Yépez, V. A., Theis, F. J., & Gagneur, J. (2024). Modeling fragment counts improves single-cell ATAC-seq analysis. *Nature Methods*, *21*(1), 28–31. https://doi.org/10.1038/s41592-023-02112-6
