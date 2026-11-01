# Pseudotemporal ordering

Source: https://www.sc-best-practices.org/trajectories/pseudotemporal  
Authors: Philipp Weiler, Seo H. Kim, Lukas Heumos

**🧠 Key takeaways**

- Trajectory inference methods require the start of the biological process to be known (approximately).
- The nature of the biological process defines which TI algorithms can be used.
`dynguidelines` helps selecting the appropriate TI method.

**⚙️ Environment setup**

**yml:**

```yaml
name: pseudotemporal
channels:
  - conda-forge
dependencies:
  - conda-forge::python=3.14.6
  - conda-forge::scanpy=1.12.3
  - pip
  - pip:
      - lamindb==2.8.1
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

Single-cell sequencing assays provide high-resolution measurements of biological tissues (Islam *et al.*, 2011 [1]), (Hwang *et al.*, 2018 [2]).
Consequently, such technologies can help decipher and understand cellular heterogeneity (Briggs *et al.*, 2018 [3]), (Sikkema *et al.*, 2022 [4]) and the dynamics of a biological process (Jardine *et al.*, 2021 [5]), (He *et al.*, 2022 [6]).  
Corresponding studies include quantifying cellular fates and identifying genes that drive the process.
However, as cells are destroyed when sequenced in classical single-cell RNA sequencing (scRNA-seq) protocols, it is impossible to track their development and, for example, gene expression profile over time.
Although recent technological advances enable the sequential recording of the transcriptome (Chen *et al.*, 2022 [7]), they are experimentally challenging and currently fail to scale to larger datasets.
Consequently, the underlying dynamic process needs to be estimated from the measured snapshot data instead.

Although samples are traditionally taken from a single experimental time point, a variety of cell types can be observed.
This diversity stems from the asynchronous nature of biological processes.
As such, a range of the developmental process can be observed.
Reconstructing the developmental landscape is the goal of the field, which is referred to as trajectory inference (TI).
This task is achieved by ordering the observed cellular states according to the developmental process.
States are aligned along the developmental direction by mapping discrete annotations to a continuous domain - the so-called *pseudotime*.

Pseudotimes rank cells relative to each other according to their respective stage in the developmental process.
Less mature cells are assigned small values, while mature cells are assigned large values.
Studying a bone marrow sample, for example, hematopoietic stem cells are assigned a low pseudotime, and erythroid cells a high pseudotime.
The assignment, in the case of single-cell RNA sequencing data, is based on the transcriptomic profile of a single cell.
Additionally, the construction usually requires the specification of an initial, or equivalently, a root cell, where the overall process begins.

## Pseudotime construction

Pseudotime construction generally follows a common workflow: As a first step, the [ultra-high-dimensional](../glossary.md#term-high-dimensional-data) single-cell data is projected onto a lower-dimensional representation.
This procedure is justified by the observation that dynamical processes progress on a low-dimensional manifold (Wagner *et al.*, 2016 [8]).
In practice, pseudotime methods may rely on principal components (for example, Palantir (Setty *et al.*, 2019 [9])) or diffusion components (for example, diffusion pseudotime (DPT) (Haghverdi *et al.*, 2016 [10])).
Following, pseudotimes are constructed based on one of the following principles.

1. Observations are first clustered and, following, connections between these clusters are identified.
   The clusters can be ordered, and thereby, a pseudotime can be constructed.
   Henceforth, we will refer to this approach as the *cluster approach*.
   Classical cluster algorithms include $k$-means (Lloyd, 1982 [11]), (MacQueen, 1967 [12]), Leiden (Traag *et al.*, 2019 [13]), or hierarchical clustering (Müllner, 2011 [14]).
   Clusters may be connected based on similarity, or by constructing a minimum spanning tree (MST) (Pettie & Ramachandran, 2002 [15]).
2. The *graph approach* first finds connections between the lower-dimensional representation of the observations.
   This procedure defines a graph based on which clusters are defined, and thus an ordering is established.
   *PAGA* (Wolf *et al.*, 2019 [16]), for example, partitions the graph into Leiden clusters and estimates connections between them.
   Intuitively, this approach preserves the global topology of the data while analyzing it at a lower resolution.
   Consequently, the computational efficiency is increased.
3. *Manifold-learning based approaches* proceed similar to the *cluster approach*.
   However, connections between clusters are defined by using principal curves or graphs to estimate the underlying trajectories.
   Principal curves find a one-dimensional curve that connects cellular observations in the higher-dimensional space.
   A notable representation of this approach is Slingshot (Street *et al.*, 2018 [17]).
4. Probabilistic frameworks assign transition probabilities to ordered cell-cell pairs.
   Each transition probability quantifies the likelihood that the reference cell is the ancestor of the other cell.
   These probabilities define random processes that are used to define a pseudotime.
   DPT (Diffusion Pseudotime), for example, is defined as the difference between consecutive states of a random walk.
   Contrastingly, Palantir (Setty *et al.*, 2019 [9]) models trajectories as Markov chains themselves.
   While both approaches rely on a probabilistic framework, they require a root cell to be specified.
   The pseudotime itself is computed with respect to this cell.

Trajectory inference (TI) is a well-studied field providing a rich set of methods.
To apply the appropriate method for analyzing a single-cell dataset, it is essential to understand the biological process itself.
This understanding especially includes the nature of the process, *i.e.*, if it, for example, is linear, cyclic, or branching.
Similarly, orthogonal processes within one dataset limits the TI methods, which are applicable.
To help identify appropriate tools, dynguidelines (Deconinck *et al.*, 2021 [18]) provides an exhaustive overview of algorithms and their characteristics.

> **Orthogonal process in single-cell transcriptomics**
> 
> Orthogonal processes describe two independent biological programs who are uncorrelated.
> A cell cycle and a disease would be orthogonal processes.

## Down-stream tasks and outlook

Although TI and pseudotime can already provide valuable insights, they typically serve as a stepping stone for more fine-grained analysis.
Identifying terminal states, for example, is a classical biological question that can be studied.
Similarly, lineage bifurcation and [driver genes](../glossary.md#term-driver-genes) can be identified based on TI and pseudotime.
Which question can be answered, and how the answer is found, is usually method-specific.
Palantir (Setty *et al.*, 2019 [9]), for example, identifies terminal states as absorbing states of its constructed Markov chain.

The success of trajectory inference is well-documented, and consequently, many methods have been proposed.
However, with the advances of sequencing technologies, new sources of information have become available.
ATAC-seq (Buenrostro *et al.*, 2015 [19]), CITE-seq (Stoeckius *et al.*, 2017 [20]), and DOGMA-seq (Mimitou *et al.*, 2021 [21]), for example, measure additional modalities beyond the transcriptome.
Lineage tracing (Weinreb *et al.*, 2020 [22]) and metabolic labeling (Erhard *et al.*, 2019 [23]), (Battich *et al.*, 2020 [24]), (Qiu *et al.*, 2020 [25]), (Erhard *et al.*, 2022 [26]) even provide the (likely) future state of a given cell.
Consequently, future TI tools will be able to include more information to estimate trajectories and pseudotime more accurately and robustly, allowing for the answer to novel questions.
For example, RNA velocity (Manno *et al.*, 2018 [27]), (Bergen *et al.*, 2020 [28]), (Bergen *et al.*, 2021 [29]) is one technique that uses unspliced and spliced [mRNA](../glossary.md#term-messenger-rna-mrna) to infer directed, dynamic information beyond classical, static snapshot data.

## Inferring pseudotime for adult human bone marrow

To demonstrate how a pseudotime can be constructed and how different pseudotimes can be compared, we analyze a dataset of adult human bone marrow (Setty *et al.*, 2019 [9]).

### Environment setup

```python
import lamindb as ln
import scanpy as sc

ln.connect("theislab/sc-best-practices")

ln.track("5tukHKyz8kFR")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ loaded Transform('5tukHKyz8kFR0002', key='pseudotemporal.ipynb'), re-started Run('b4LCLYIODPoR5fUv') at 2026-08-12 15:26:46 UTC
→ notebook imports: lamindb-core==2.8.1 scanpy==1.12.3
```

### Data loading

```python
af = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="trajectory/pseudotemporal.h5ad", is_latest=True
)
adata = af.load()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 5780 × 27876
    obs: 'clusters', 'palantir_pseudotime', 'palantir_diff_potential'
    var: 'palantir'
    uns: 'clusters_colors', 'palantir_branch_probs_cell_types'
    obsm: 'MAGIC_imputed_data', 'X_tsne', 'palantir_branch_probs'
    layers: 'spliced', 'unspliced'
```

To construct pseudotimes, the data must be preprocessed.
Here, we filter out genes expressed in only a small number of cells (here, at least 20).
Notably, the construction of the pseudotime later on is robust to the exact choice of the threshold.
Following this initial gene filtering, the cell size is normalized, and the counts are log1p-transformed to reduce the effect of outliers.
As usual, we also identify and annotate highly variable genes.
Finally, a nearest neighbor graph is constructed based on which we will define the pseudotime.
The number of principal components is chosen based on the explained variance.

```python
sc.pp.filter_genes(adata, min_counts=20)
sc.pp.normalize_total(adata)
sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata)

sc.tl.pca(adata)
sc.pp.neighbors(adata, n_pcs=10)
```

```python
sc.pl.scatter(adata, basis="tsne", color="clusters")
```

The two-dimensional [t-SNE](../glossary.md#term-t-distributed-stochastic-neighbor-embedding-t-sne) representation colored by cell type annotations shows that the cell types cluster together well.

Additionally, the developmental hierarchy is visible.

### Pseudotime construction

To calculate diffusion pseudotime (DPT), the corresponding diffusion maps must first be calculated.

```python
sc.tl.diffmap(adata)
```

The differentiation hierarchy in bone marrow is well understood.
However, it is only known that the developmental process starts in the form of hematopoietic stem cells, but not which cell, exactly, in the corresponding cluster in our dataset.
To identify a putative initial cell, we study the individual diffusion components.
We identify the stem cell with the most extreme diffusion component in one dimension (in our case, dimension 3).

> **Diffusion map and diffusion components**
> 
> *Diffusion map* shows us the non-linear distance between one state of a cell to another.
> It is important for this distance to be non-linear, since cells follow a continuous path of gradual changes, rather than “jumping” from one state to another.
> Unlike PCA, diffusion map ignores the Euclidean distance and tries to find the curved path the data follows.
> 
> *Diffusion components* is the eigenvector of a transition matrix that represents the “preferred directions” of movement in the diffusion map.
> Lower-order diffusion components capture more significant biological transitions.

```python
# Setting root cell as described above
root_ixs = adata.obsm["X_diffmap"][:, 3].argmin()
sc.pl.scatter(
    adata,
    basis="diffmap",
    color=["clusters"],
    components=[2, 3],
)

adata.uns["iroot"] = root_ixs
```

```python
sc.tl.dpt(adata)
```

Different pseudotime methods give different results.
Sometimes, one pseudotime captures the underlying developmental processes more accurately than others.
Here, we compare the just-computed diffusion pseudotime (DPT) with the pre-computed Palantir pseudotime (see [here](https://github.com/dpeerlab/Palantir/blob/master/notebooks/Palantir_sample_notebook.ipynb) for the corresponding tutorial).
One option for comparing different pseudotimes is to color the low-dimensional embedding of the data (here, t-SNE).
Here, DPT is extremely high in the cluster of CLPs compared to all other cell types.
Contrastingly, the Palantir pseudotime increases continuously with developmental maturity.

```python
sc.pl.scatter(
    adata,
    basis="tsne",
    color=["dpt_pseudotime", "palantir_pseudotime"],
    color_map="gnuplot2",
)
```

Instead of coloring the lower-dimensional representation of the data, we can study the distribution of pseudotime values assigned to each cell type cluster.
This representation again shows that the CLP cluster forms an outlier in the case of DPT.
Additionally, clusters such as *HSC_1* and *HSC_2* include several cells with increased pseudotime.
These inflated values contrast with our prior biological knowledge that these clusters form the beginning of the developmental process.

```python
sc.pl.violin(
    adata,
    keys=["dpt_pseudotime", "palantir_pseudotime"],
    groupby="clusters",
    rotation=45,
    order=[
        "HSC_1",
        "HSC_2",
        "Precursors",
        "Ery_1",
        "Ery_2",
        "Mono_1",
        "Mono_2",
        "CLP",
        "DCs",
        "Mega",
    ],
)
```

Considering these observations and prior knowledge about the development in bone marrow, we would conclude to continue working with the Palantir pseudotime.

```python
af = ln.Artifact.from_anndata(
    adata, key="trajectories/pseudotemporal/bonemarrow_result.h5ad"
).save()
```

Output:
```text
→ returning artifact with same hash: Artifact(uid='enADatm9ThSn74oY0000', key='trajectories/pseudotemporal/bonemarrow_result.h5ad', description=None, suffix='.h5ad', kind='dataset', otype='AnnData', size=391745946, hash='v9NKnwJn5jIfzkE-zwosPR', n_files=None, n_observations=5780, extra_data=None, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=104, schema_id=None, created_by_id=6, created_at=2026-07-29 06:45:33 UTC, is_locked=False, version_tag=None, is_latest=True); to track this artifact as an input, use: ln.Artifact.get()
```

> **Downstream analysis**
> 
> We save the pseudotime results for downstream [gene set enrichment analysis](../glossary.md#term-gene-set-enrichment-analysis-gsea)
> See the [corresponding chapter](../conditions/gsea-pathway.md#pseudotime-enrichment-scoring) for details.

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Philipp Weiler
- Seo H. Kim

### Reviewers

- Lukas Heumos

## References

1. Islam, S., Kjällquist, U., Moliner, A., Zajac, P., Fan, J.-B., Lönnerberg, P., & Linnarsson, S. (2011). Characterization of the single-cell transcriptional landscape by highly multiplex RNA-seq. *Genome Research*, *21*(7), 1160–1167. https://doi.org/10.1101/gr.110882.110
2. Hwang, B., Lee, J. H., & Bang, D. (2018). Single-cell RNA sequencing technologies and bioinformatics pipelines. *Experimental &\mathsemicolon Molecular Medicine*, *50*(8), 1–14. https://doi.org/10.1038/s12276-018-0071-8
3. Briggs, J. A., Weinreb, C., Wagner, D. E., Megason, S., Peshkin, L., Kirschner, M. W., & Klein, A. M. (2018). The dynamics of gene expression in vertebrate embryogenesis at single-cell resolution. *Science*, *360*(6392). https://doi.org/10.1126/science.aar5780
4. Sikkema, L., Strobl, D. C., Zappia, L., Madissoon, E., Markov, N. S., Zaragosi, L.-E., Ansari, M., Arguel, M.-J., Apperloo, L., Becavin, C., Berg, M., Chichelnitskiy, E., Chung, M.-I., Collin, A., Gay, A. C. A., Kashani, B. H., Jain, M., Kapellos, T., Kole, T. M., … Theis, F. J. (2022). An integrated cell atlas of the human lung in health and disease. *bioRxiv*, 2022.03.10.483747. https://doi.org/10.1101/2022.03.10.483747
5. Jardine, L., Webb, S., Goh, I., Londoño, M. Q., Reynolds, G., Mather, M., Olabi, B., Stephenson, E., Botting, R. A., Horsfall, D., Engelbert, J., Maunder, D., Mende, N., Murnane, C., Dann, E., McGrath, J., King, H., Kucinski, I., Queen, R., … Haniffa, M. (2021). Blood and immune development in human fetal bone marrow and Down syndrome. *Nature*, *598*(7880), 327–331. https://doi.org/10.1038/s41586-021-03929-x
6. He, P., Lim, K., Sun, D., Pett, J. P., Jeng, Q., Polanski, K., Dong, Z., Bolt, L., Richardson, L., Mamanova, L., Dabrowska, M., Wilbrey-Clark, A., Madissoon, E., Tuong, Z. K., Dann, E., Suo, C., Goh, I., Yoshida, M., Nikolić, M. Z., … Rawlins, E. L. (2022). A human fetal lung cell atlas uncovers proximal-distal gradients of differentiation and key regulators of epithelial fates. *bioRxiv*. https://doi.org/10.1101/2022.01.11.474933
7. Chen, W., Guillaume-Gentil, O., Rainer, P. Y., Gäbelein, C. G., Saelens, W., Gardeux, V., Klaeger, A., Dainese, R., Zachara, M., Zambelli, T., Vorholt, J. A., & Deplancke, B. (2022). Live-seq enables temporal transcriptomic recording of single cells. *Nature*, *608*(7924), 733–740. https://doi.org/10.1038/s41586-022-05046-9
8. Wagner, A., Regev, A., & Yosef, N. (2016). Revealing the vectors of cellular identity with single-cell genomics. *Nature Biotechnology*, *34*(11), 1145–1160. https://doi.org/10.1038/nbt.3711
9. Setty, M., Kiseliovas, V., Levine, J., Gayoso, A., Mazutis, L., & Pe’er, D. (2019). Characterization of cell fate probabilities in single-cell data with Palantir. *Nature Biotechnology*, *37*(4), 451–460. https://doi.org/10.1038/s41587-019-0068-4
10. Haghverdi, L., Büttner, M., Wolf, F. A., Buettner, F., & Theis, F. J. (2016). Diffusion pseudotime robustly reconstructs lineage branching. *Nature Methods*, *13*(10), 845–848. https://doi.org/10.1038/nmeth.3971
11. Lloyd, S. (1982). Least squares quantization in PCM. *IEEE Transactions on Information Theory*, *28*(2), 129–137. https://doi.org/10.1109/tit.1982.1056489
12. MacQueen, J. B. (1967). Some Methods for Classification and Analysis of MultiVariate Observations. In L. M. L. Cam & J. Neyman (Eds.), *Proc. of the fifth Berkeley Symposium on Mathematical Statistics and Probability* (Vol. 1, pp. 281–297). University of California Press.
13. Traag, V. A., Waltman, L., & van Eck, N. J. (2019). From Louvain to Leiden: guaranteeing well-connected communities. *Scientific Reports*, *9*(1). https://doi.org/10.1038/s41598-019-41695-z
14. Müllner, D. (2011). *Modern hierarchical, agglomerative clustering algorithms*. arXiv. https://doi.org/10.48550/ARXIV.1109.2378
15. Pettie, S., & Ramachandran, V. (2002). An optimal minimum spanning tree algorithm. *Journal of the ACM*, *49*(1), 16–34. https://doi.org/10.1145/505241.505243
16. Wolf, F. A., Hamey, F. K., Plass, M., Solana, J., Dahlin, J. S., Göttgens, B., Rajewsky, N., Simon, L., & Theis, F. J. (2019). PAGA: graph abstraction reconciles clustering with trajectory inference through a topology preserving map of single cells. *Genome Biology*, *20*(1). https://doi.org/10.1186/s13059-019-1663-x
17. Street, K., Risso, D., Fletcher, R. B., Das, D., Ngai, J., Yosef, N., Purdom, E., & Dudoit, S. (2018). Slingshot: cell lineage and pseudotime inference for single-cell transcriptomics. *BMC Genomics*, *19*(1). https://doi.org/10.1186/s12864-018-4772-0
18. Deconinck, L., Cannoodt, R., Saelens, W., Deplancke, B., & Saeys, Y. (2021). Recent advances in trajectory inference from single-cell omics data. *Current Opinion in Systems Biology*, *27*, 100344. https://doi.org/10.1016/j.coisb.2021.05.005
19. Buenrostro, J. D., Wu, B., Litzenburger, U. M., Ruff, D., Gonzales, M. L., Snyder, M. P., Chang, H. Y., & Greenleaf, W. J. (2015). Single-cell chromatin accessibility reveals principles of regulatory variation. *Nature*, *523*(7561), 486–490. https://doi.org/10.1038/nature14590
20. Stoeckius, M., Hafemeister, C., Stephenson, W., Houck-Loomis, B., Chattopadhyay, P. K., Swerdlow, H., Satija, R., & Smibert, P. (2017). Simultaneous epitope and transcriptome measurement in single cells. *Nature Methods*, *14*(9), 865–868. https://doi.org/10.1038/nmeth.4380
21. Mimitou, E. P., Lareau, C. A., Chen, K. Y., Zorzetto-Fernandes, A. L., Hao, Y., Takeshima, Y., Luo, W., Huang, T.-S., Yeung, B. Z., Papalexi, E., Thakore, P. I., Kibayashi, T., Wing, J. B., Hata, M., Satija, R., Nazor, K. L., Sakaguchi, S., Ludwig, L. S., Sankaran, V. G., … Smibert, P. (2021). Scalable, multimodal profiling of chromatin accessibility, gene expression and protein levels in single cells. *Nature Biotechnology*, *39*(10), 1246–1258. https://doi.org/10.1038/s41587-021-00927-2
22. Weinreb, C., Rodriguez-Fraticelli, A., Camargo, F. D., & Klein, A. M. (2020). Lineage tracing on transcriptional landscapes links state to fate during differentiation. *Science*, *367*(6479). https://doi.org/10.1126/science.aaw3381
23. Erhard, F., Baptista, M. A. P., Krammer, T., Hennig, T., Lange, M., Arampatzi, P., Jürges, C. S., Theis, F. J., Saliba, A.-E., & Dölken, L. (2019). scSLAM-seq reveals core features of transcription dynamics in single cells. *Nature*, *571*(7765), 419–423. https://doi.org/10.1038/s41586-019-1369-y
24. Battich, N., Beumer, J., de Barbanson, B., Krenning, L., Baron, C. S., Tanenbaum, M. E., Clevers, H., & van Oudenaarden, A. (2020). Sequencing metabolically labeled transcripts in single cells reveals mRNA turnover strategies. *Science*, *367*(6482), 1151–1156. https://doi.org/10.1126/science.aax3072
25. Qiu, Q., Hu, P., Qiu, X., Govek, K. W., Cámara, P. G., & Wu, H. (2020). Massively parallel and time-resolved RNA sequencing in single cells with scNT-seq. *Nature Methods*, *17*(10), 991–1001. https://doi.org/10.1038/s41592-020-0935-4
26. Erhard, F., Saliba, A.-E., Lusser, A., Toussaint, C., Hennig, T., Prusty, B. K., Kirschenbaum, D., Abadie, K., Miska, E. A., Friedel, C. C., Amit, I., Micura, R., & Dölken, L. (2022). Time-resolved single-cell RNA-seq using metabolic RNA labelling. *Nature Reviews Methods Primers*, *2*(1). https://doi.org/10.1038/s43586-022-00157-z
27. Manno, G. L., Soldatov, R., Zeisel, A., Braun, E., Hochgerner, H., Petukhov, V., Lidschreiber, K., Kastriti, M. E., Lönnerberg, P., Furlan, A., Fan, J., Borm, L. E., Liu, Z., van Bruggen, D., Guo, J., He, X., Barker, R., Sundström, E., Castelo-Branco, G., … Kharchenko, P. V. (2018). RNA velocity of single cells. *Nature*, *560*(7719), 494–498. https://doi.org/10.1038/s41586-018-0414-6
28. Bergen, V., Lange, M., Peidli, S., Wolf, F. A., & Theis, F. J. (2020). Generalizing RNA velocity to transient cell states through dynamical modeling. *Nature Biotechnology*, *38*(12), 1408–1414. https://doi.org/10.1038/s41587-020-0591-3
29. Bergen, V., Soldatov, R. A., Kharchenko, P. V., & Theis, F. J. (2021). RNA velocity—current challenges and future perspectives. *Molecular Systems Biology*, *17*(8). https://doi.org/10.15252/msb.202110282
