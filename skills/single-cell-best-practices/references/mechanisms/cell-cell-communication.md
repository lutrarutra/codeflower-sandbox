# Cell-cell communication

Source: https://www.sc-best-practices.org/mechanisms/cell-cell-communication  
Authors: Daniel Dimitrov, Gaia Tussardi, Giulia Cesaro, James Nagai, Lukas Heumos, Luiz Heinzimeier

**🧠 Key takeaways**

- Cell-cell communication (CCC) inference from single-cell transcriptomics data relies on the assumption that gene expression is a proxy for protein abundance and intercellular interactions.
- Ligand-receptor inference methods and intracellular signaling models (e.g., NicheNet) are complementary approaches for understanding CCC.
- The Ligand-receptor database and the measurements of different tools are key for the cell-cell communication inference

**⚙️ Environment setup**

**yml:**

```yaml
name: cellcell

channels:
  - conda-forge

dependencies:
  - python=3.14
  - pip
  - pip:
      - git+https://github.com/scverse/liana.git@v2.0.0
      - lamindb==2.10.0
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

Cell communication is a process by which cells react to stimuli from their environment and also from themselves. In multicellular organisms, the dynamic coordination of cells, also called cell-cell communication (CCC), is involved in many biological processes, such as apoptosis and cell migration, and is consequently essential in homeostasis and disease. CCC commonly focuses on protein-mediated interactions, most typically perceived as a secreted [ligand](../glossary.md#term-ligand) binding to its corresponding plasma membrane [receptor](../glossary.md#term-receptor). However, this picture can be broadened to include secreted enzymes, extra-cellular matrix proteins, transporters, and interactions that require the physical contact between cells, such as cell-cell adhesion proteins and gap junctions (Armingol *et al.*, 2021 [1]). Cell communication is further not independent of other processes, but the contrary, as external stimuli commonly elicit a downstream response. In the case of CCC, this is typically perceived as the induction of canonical pathways and downstream transcription factors in the cells receiving the signal, or receiver cells. Ultimately these external stimuli alter the function of receiver cells, and this alteration is further propagated via the subsequent interaction of these cells with their microenvironment.

Traditionally, the study of CCC required specialized in-situ biochemical assays, such as proximity labelling proteomics, co-immunoprecipitation, and yeast two-hybrid screening (Armingol *et al.*, 2021 [1]). Yet, the rapid developments and dropping costs of transcriptomics data generation has enabled a paradigm shift away from focusing on which types of cells are present, but rather on the relationships between them (Almet *et al.*, 2021 [2]). As a consequence, CCC inference from single-cell data is now becoming a routine approach, capable of providing a system-level hypotheses of intercellular crosstalk in vivo.

## Background

As a result of this increased interest, a number of computational tools for CCC inference from single-cell transcriptomics have emerged that can be classified as those that predict CCC interactions alone, commonly referred to as ligand-receptor inference methods (e.g. (Efremova *et al.*, 2020 [3]; Jin *et al.*, 2021 [4]; Raredon *et al.*, 2022 [5]; Hou *et al.*, 2020 [6])), and those that additionally estimate intracellular activities induced by CCC (e.g. (Wang *et al.*, 2019 [7]; Browaeys *et al.*, 2020 [8]; Hu *et al.*, 2021 [9])). Both categories of tools use gene expression information as a proxy of protein abundance, and typically require the clustering of cells into biologically-meaningful groups (See [Annotation](../cellular-structure/annotation.md) tutorial). These CCC tools infer intercellular crosstalk between pairs of cell groups, one group being the source and the other the receiver of a CCC event. CCC events are thus commonly represented as interactions between proteins, expressed by the source and receiver cell clusters.

The information about the interacting proteins is commonly extracted from prior knowledge resources. In the case of ligand-receptor methods, the interactions can also be represented by heteromeric protein complexes, as different subunit combinations can induce distinct responses and the inclusion of protein complex information has been shown to reduce false positive rates (Efremova *et al.*, 2020 [3]; Jin *et al.*, 2021 [4]; Liu *et al.*, 2022 [10]). Ligand-receptor databases vary considerably in total number of curated interactions, bias to species or tissue/process, functional classifications, multisubunit complex annotation, intracellular signaling events, and level of curation.  In the current literature, comparisons of existing databases are available in previous reviews (Dimitrov *et al.*, 2022 [11]; Cesaro *et al.*, 2025 [12]). On the other hand, the approaches that model intracellular signalling also leverage the functional information in receiver cell types, and thus require additional information such as intracellular protein-protein interaction network and/or gene regulatory interactions.

Ligand-receptor inference methods usually represent predicted interactions as tuples (source, receiver, ligand, receptor, score), where the score quantifies the evidence supporting intercellular signalling. Methods differ in how these scores are computed, commonly integrating ligand and receptor expression through expression-based scoring, expression specificity, differential expression, or statistical testing. Consequently, scores may reflect the magnitude, specificity, or statistical support of a predicted interaction (Armingol *et al.*, 2024 [13]; Cesaro *et al.*, 2025 [12]).

![CCC Overview ](https://www.sc-best-practices.org/build/cell_cell_communicat-c75e5205a33ad21529b81200bb00448b.png)

*Figure 1: Cell-Cell Communication Overview*

### Validation

Recent work has highlighted that the choice of method and/or resource leads to limited consensus in inferred predictions when using different tools (Dimitrov *et al.*, 2022 [11]; Wang *et al.*, 2022 [14]; Liu *et al.*, 2022 [10]), thus prompting caution when interpreting their output. However, validating CCC predictions remains challenging due to the lack of ground truth (Armingol *et al.*, 2021 [1]; Almet *et al.*, 2021 [2]), capable of capturing the complex and dynamic interplay between large numbers of cells and molecules.  
In the absence of such a ground truth, the reliability of CCC predictions can be assessed through complementary sources of evidence, including (1) literature agreement, (2) experimental validation, (3) indirect validation, (4) in silico validation, and (5) robustness validation, as highlighted by Cesaro et al. (Cesaro *et al.*, 2025 [12]). For instance, independent evaluations have shown that CCC methods are fairly robust to the introduction of noise (Dimitrov *et al.*, 2022 [11]; Wang *et al.*, 2022 [14]; Liu *et al.*, 2022 [10]), and are largely concordant with alternative data modalities such as intracellular signalling and spatial information (Dimitrov *et al.*, 2022 [11]; Liu *et al.*, 2022 [10]). Promising methods for experimental and indirect validation, as reviewed by Armingol et al. (Armingol *et al.*, 2024 [13]) and Cesaro et al. (Cesaro *et al.*, 2025 [12]), include uLIPSTIC, subcellular-resolution spatial transcriptomics (e.g. MERFISH), droplet-based technologies (e.g. PIC-seq), and multiplexed protein imaging methods (e.g. CODEX).

### Reviews and benchmarking

To deepen understanding of CCC research, several efforts offer timeprints of CCC development in recent years.  Novel surveys, such as Armingol et al. (Armingol *et al.*, 2024 [13]), Cesaro et al. (Cesaro *et al.*, 2025 [12]) and Chen  et al., (Cheng *et al.*, 2025 [15]), summarise and provide an outlook on contributions in CCC databases and methods.
Several initiatives further support the exploration and evaluation of the field. Cesaro et al. (Cesaro *et al.*, 2025 [12]) introduced the [CCC-Catalog](https://sysbiobig.gitlab.io/ccc-catalog), an open-source online repository that centralizes and disseminates information on  available CCC tools and databases. Platforms, such as LIANA (Dimitrov *et al.*, 2022 [11]), have been developed and provide a framework for comparative analysis across multiple LR resources and CCC tools, offering a structured approach to manage input and output heterogeneity. Interestingly, another important initiative is the [Open Problems platform](https://openproblems.bio) (Luecken *et al.*, 2025 [16]), which provides a structured framework for evaluating CCC computational tools. It allows researchers to assess tool performance using metrics such as precision-recall AUC and odds ratios, as well as computational efficiency in terms of execution time and memory usage. Other benchmarking efforts provide rankings of CCC tools using quantitative metrics and, where available, ground truth data, evaluating aspects such as accuracy, robustness, and usability. Notably, the EISICC framework (Luo *et al.*, 2023 [17]) benchmarked 18 LR inference tools and 5 LR-target tools across 116 datasets, representing one of the most comprehensive studies to date.

## Environment setup

In this chapter, we first provide an introduction and example to perhaps the most common and simplest CCC approaches, i.e. ligand-receptor inference with CellPhoneDB (Efremova *et al.*, 2020 [3]) and LIANA (Dimitrov *et al.*, 2022 [11]). Finally, we highlight the common assumptions and limitations of CCC inference from single-cell transcriptomics data as well as suggestions how to improve confidence in intercellular communication predictions. Note that here we generalize for the sake of simplicity, however, there are a plethora of different and newly emerging CCC approaches. We highlight some of those in the Overview section.

Although, the prioritized interactions by both CellPhoneDB and LIANA seem biologically-plausible and potentially relevant to the treatment, it is challenging to ascertain their relevance. In particular, the advantage of these methods to generate systems-level insights in a hypothesis-free manner happens to also be one of their major disadvantages. Specifically because ligand-receptor tools return all plausible ligand-receptor interactions for every pair of cell types, thus we end up with huge lists of interactions, and choosing targets for subsequent experimental validation can be challenging.

Thus, prior to experimental validation, we suggest that any potential interaction hypotheses should be supported with additional prior knowledge. This may include domain knowledge for the specific condition (e.g. cell types or receptors of interest), as well as orthogonal modalities, such as protein abundance, spatial co-localization, or downstream signalling. To this end, we also further refer the reader to the [Gene set enrichment and pathway analysis](enrichment-analysis.ipynb) and spatial CCC (to be added) chapters.

```python
import warnings

warnings.filterwarnings("ignore")
```

```python
import lamindb as ln
import liana as li
import pandas as pd
import scanpy as sc

ln.connect("theislab/sc-best-practices")

ln.track("8YR6fz482TZ3")

sc.settings.set_figure_params(dpi=200, frameon=False)
sc.set_figure_params(dpi=200, facecolor="white")
sc.set_figure_params(figsize=(5, 5))
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
! connected in read-only mode, please use ln.DB("theislab/sc-best-practices") instead
! skipping track(), connected in read-only mode
```

## Case study

As a simple example, we will look at ~25k PBMCs from 8 lupus patients, each before and after IFN-β stimulation (Kang *et al.*, 2018 [18]). Note that by focusing on PBMCs, for the purpose of this tutorial, we assume that coordinated events occur among them.

So, let’s first download the pre-processed data.

```python
af = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="conditions/differential_gene_expression.h5ad", is_latest=True
)
adata = af.load()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 24673 × 15706
    obs: 'nCount_RNA', 'nFeature_RNA', 'tsne1', 'tsne2', 'label', 'cluster', 'cell_type', 'replicate', 'nCount_SCT', 'nFeature_SCT', 'integrated_snn_res.0.4', 'seurat_clusters'
    var: 'name'
    obsm: 'X_pca', 'X_umap'
    layers: None (.X)
```

Apply basic quality control steps to remove any low quality cells and lowly expressed genes. We refer the user to the [quality control](../preprocessing-visualization/quality-control.md) chapter for more extensive QC steps.

```python
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)
```

```python
adata.layers["counts"] = adata.X.copy()
adata.obs = adata.obs.rename({"label": "condition", "replicate": "patient"}, axis=1)
adata.obs["sample"] = pd.Categorical(
    adata.obs["condition"].astype("str") + "&" + adata.obs["patient"].astype("str")
)
```

We will also normalize the data to ensure that the [count depth](../glossary.md#term-sequencing-depth) is equalized for all cells, given that we need the gene expression values to be comparable across the cell types. We refer the user to the [Normalization](../preprocessing-visualization/normalization.md) chapter for more information and alternative normalization approaches that might fit their data better.

```python
sc.pp.normalize_total(adata)
sc.pp.log1p(adata)
```

In this case study, we will assume that cell types such as B cells and CD4 T cells carry out a signal mediator role, while others, such as CD8 T cells and Natural Killer cells, are composed of the cells that carry out the response. In other words, we will treat B and CD4 T cells as the sources of CCC signalling, while the latter are the receivers of CCC stimuli. This is of course an oversimplification as signalling sources and receivers are expected to be dynamic and multi-directional, thus the cell types that we treat as which category depends on the hypothesis in mind.

```python
adata.obs["cell_type"].cat.categories
```

Output:
```text
Index(['CD4 T cells', 'CD14+ Monocytes', 'B cells', 'NK cells', 'CD8 T cells',
       'FCGR3A+ Monocytes', 'Dendritic cells', 'Megakaryocytes'],
      dtype='str')
```

Show pre-computed [UMAP](../glossary.md#term-uniform-manifold-approximation-and-projection-umap), just to showcase the data

```python
sc.pl.umap(adata, color=["condition", "cell_type"], frameon=False)
```

### Ligand-receptor inference

First, let’s use the CellPhoneDB (v2) ligand-receptor method (Efremova *et al.*, 2020 [3]).

We will run CellPhoneDB on the data post IFN-beta stimulation alone, as such methods were initially designed for the inference of CCC events in “steady-state” data, or in other words, they are meant to be used not across samples or conditions, but rather on a single condition or sample at a time. Note that, nevertheless, certain approaches exist to apply ligand-receptor methods across conditions but these are out of scope for this tutorial, and instead we refer to them in the **Outlook** section.

```python
adata_stim = adata[adata.obs["condition"] == "stim"].copy()
adata_stim
```

Output:
```text
AnnData object with n_obs × n_vars = 12301 × 15701
    obs: 'nCount_RNA', 'nFeature_RNA', 'tsne1', 'tsne2', 'condition', 'cluster', 'cell_type', 'patient', 'nCount_SCT', 'nFeature_SCT', 'integrated_snn_res.0.4', 'seurat_clusters', 'n_genes', 'sample'
    var: 'name', 'n_cells'
    uns: 'log1p', 'condition_colors', 'cell_type_colors'
    obsm: 'X_pca', 'X_umap'
    layers: None (.X), 'counts'
```

```python
from liana.method import cellphonedb
```

CellPhoneDB is one of the most commonly-used CCC tools, it represents intercellular communication events as the average gene expression of the proteins involved in the interaction.
The proteins involved can also assemble as heteromeric complexes, and in that case the minimum gene expression of the subunits is considered.
In addition to the expression average, interaction significance is determined against a null distribution, generated by shuffling the cell group labels.

Note that we are grouping by cell type and that the CCC statistics that we get will reflect the cell types that were previously pre-defined.

```python
cellphonedb(
    adata_stim, groupby="cell_type", use_raw=False, return_all_lrs=True, verbose=True
)
```

Output:
```text
Generating ligand-receptor stats for 12301 samples and 891 features
```

By default, the results are written in place within the anndata object, more specifically in `.uns['liana_res']`.

Let’s examine the output from the CellPhoneDB method:

```python
adata_stim.uns["liana_res"].head()
```

Here, we see that stats are provided for both ligand and receptor entities, more specifically: - `ligand` and `receptor` are typically the two entities that interact. As a reminder, CCC events are not limited to secreted signalling, but we refer to them as `ligand` and `receptor` for simplicity.

Also, in the case of heteromeric complexes, the `ligand` and `receptor` columns represent the subunit with minimum expression, while `*_complex` corresponds to the actual complex, with subunits being separated by `_`.

- `source` and `target` columns represent the source/sender and target/receiver cell identity for each interaction, respectively
- `*_props`: represents the proportion of cells that express the entity.
  
  By default, in CellPhoneDB and LIANA, any interactions in which either entity is not expressed in above 10% of cells per cell type is considered as a false positive,
  under the assumption that since CCC occurs between cell types, a sufficient proportion of cells within should express the genes.
- `*_means`: entity expression mean per cell type
- `lr_means`: mean ligand-receptor expression, as a measure of ligand-receptor interaction **magnitude**
- `cellphone_pvals`: permutation-based p-values, as a measure of interaction **specificity**

Note that `ligand`, `receptor`, `source`, and `target` columns are returned by every ligand-receptor method, while the rest of the columns can vary across the ligand-receptor methods, as each method relies on different assumptions and scoring functions, and hence each returns different ligand-receptor scores.
Nevertheless, typically most methods use a pair of scoring functions - where one often corresponds to the **magnitude** (strength) of interaction and the other reflects the **specificity** of a given interaction to a pair of cell identities.

#### Visual exploration

We can now visualize the results that we just obtained as a dotplot, in which rows represent the prioritized interactions between source/sender (top) and target/receiver (bottom) cell types.

```python
li.pl.dotplot(
    adata=adata_stim,
    colour="lr_means",
    size="cellphone_pvals",
    inverse_size=True,
    source_labels=["CD4 T cells", "B cells", "FCGR3A+ Monocytes"],
    target_labels=["CD8 T cells", "CD14+ Monocytes", "NK cells"],
    filter_fn=lambda x: x["cellphone_pvals"] <= 0.01,
    orderby="lr_means",
    orderby_ascending=False,
    top_n=20,
    figure_size=(9, 5),
    size_range=(1, 6),
)
```

Great, we get a number of interactions potentially linked to IFN-beta stimulation.

We can also see that both the magnitude (expression strength) and specificity of the interactions are cell-type dependent.
For example, the potential binding of HLA-B binding to CD8A/B logically occurs only when the receiver cells are CD8 T cells.

#### Generating a Ligand-Receptor consensus with LIANA

Given the reported limited agreement between the interactions inferred by different ligand-receptor methods, as a way to further increase the confidence in a potential interaction of interest, one could check if this interaction is predicted as relevant by more than a single method. In the same manner, one could also use multiple methods and focus on their consensus, or in other words focus on interactions consistently predicted as relevant. To this end, we will run the `rank_aggregate` method of liana (Dimitrov *et al.*, 2022 [11]), which generates a probability distribution of highly ranked interactions across the methods.

Let’s first examine the ligand-receptor methods in LIANA:

```python
li.method.show_methods()
```

Let’s now run the Rank_Aggregate method, which will essentially run the other methods in the background and then generate a consensus.

```python
from liana.method import rank_aggregate
```

```python
rank_aggregate(
    adata_stim, groupby="cell_type", return_all_lrs=True, use_raw=False, verbose=True
)
```

Output:
```text
Generating ligand-receptor stats for 12301 samples and 891 features
Assuming that counts were `natural` log-normalized!
Running CellPhoneDB
Running Connectome
Running log2FC
Running NATMI
Running SingleCellSignalR
```

Let’s now check how the output of liana’s rank_aggregate:

```python
adata_stim.uns["liana_res"].drop_duplicates(
    ["ligand_complex", "receptor_complex"]
).head()
```

Here, we can see the output of the scoring functions of all methods (refer to the table above, if interested to map which score belongs to which method).
More importantly, we also get the `magnitude_rank` and `specificity_rank` for each interaction, which represent the consensus interaction **magnitude** (strength of expression) and **specificity** (across all cell type pairs), respectively.
For example, going back to CellPhoneDB, `lr_mean` and `cellphone_pvals` will be correspondingly aggregated into those.

Let’s generate the same plot, but now using the aggregate of the methods:

```python
li.pl.dotplot(
    adata=adata_stim,
    colour="magnitude_rank",
    size="specificity_rank",
    inverse_colour=True,
    inverse_size=True,
    source_labels=["CD4 T cells", "B cells", "FCGR3A+ Monocytes"],
    target_labels=["CD8 T cells", "CD14+ Monocytes", "NK cells"],
    filter_fn=lambda x: x["specificity_rank"] <= 0.05,
    orderby="magnitude_rank",
    orderby_ascending=True,
    top_n=20,
    figure_size=(9, 5),
    size_range=(1, 6),
)
```

## Overview

### Assumptions & Limitations

Single-cell transcriptomics enables the inference of CCC events on an unprecedented scale.
While the methods considered in this work predict the most relevant intercellular interactions between different cell types using single-cell transcriptomics data, some assumptions and limitations should be kept in mind.
The first limitation is the assumption that protein co-expressions reflect intercellular interactions, and consequently they are also reflective of any events preceding the interaction, including protein translation and processing, secretion, and diffusion (Armingol *et al.*, 2021 [1]; Dimitrov *et al.*, 2022 [11]) (**Figure 22.2**). Second, if cell communication within an organism is conceptualized as the combination of CCC events that occur at different ‘length scales’ or ranges (Palla *et al.*, 2022 [19]), then the CCC events that can be inferred from single-cell transcriptomics are potentially limited to only the protein-mediated events that occur at ‘local’ ranges, i.e., between the cell types that were sampled. As a result, long-range signaling and CCC driven by other molecules, such as endocrine signaling and system gradients like Calcium and Oxygen concentrations, are likely not captured (Dimitrov *et al.*, 2022 [11]).
Lastly, while grouping cell types by lineage is common practice to structure our data, when considering the tissue as the communication location, interactions do not necessarily occur between cell types but rather between individual cells (Wilk *et al.*, 2022 [20]). Intercellular interactions are commonly taken as one-to-one events between cell types and/or proteins. Therefore, the assumption that potential co-expression events across cell types might not necessarily reflect true signaling in order to fundamentally capture the events within a local community, one must identify the magnitude, directionality, and biological relevance of the messages passed between the cells within that community (Armingol *et al.*, 2021 [1]).

### Summary & Outlook:

In this chapter we presented two applications of CCC inference methods, namely we used CellPhoneDB and LIANA to predict relevant ligand-receptor interactions from single-context (or steady-state) data and NicheNet to infer potentially active ligands and their targets in a differential-expression context.
As the focus of the single-cell field moves further away from the definition of lineages, and into characterizing changes within cell types between conditions, approaches to disentangle CCC insights across contexts are becoming essential. Thus, in addition to NicheNet, we refer the user to other approaches that enable cross-condition comparisons, such as NATMI’s differential cell-connectivity analysis (Hou *et al.*, 2020 [6]), CrosstalkeR’s network topological measures (Nagai *et al.*, 2021 [21]), CellChat’s pathway-focused manifold learning (Jin *et al.*, 2021 [4]), as well as Tensor-cell2cell’s untargeted factorization approach to infer CCC patterns across contexts (Armingol *et al.*, 2022 [22]).

As a consequence of the ongoing developments within the single-cell and the cell-cell communication field specifically, there is an ever-growing number of methods, some of which propose alternative ways to predict CCC events, such as those that work at the single-cell resolution (Raredon *et al.*, 2023 [23]; Wang *et al.*, 2019 [7]; Wilk *et al.*, 2022 [20]). While others attempt to address some of the limitations above, e.g. by including the inference of interactions mediated by metabolites or small molecules (Zheng *et al.*, 2022 [24]; Garcia-Alonso *et al.*, 2022 [25]; Zhang *et al.*, 2021 [26]).

Albeit, this chapter does not capture the diversity and all current developments of the CCC field in dissociated single-cell data, it serves to introduce some of the general ideas and limitations. Thus, we intend it as a starting point upon which the reader can expand on by combining their knowledge from other chapters, and further reading within the CCC field itself.

![CCC Overview](https://www.sc-best-practices.org/build/ccc_limitations-b943acd9df64ef3a0c305cb7f8eac8f8.png)

**FIGURE 22.2**. Assumptions and Limitations of Cell-Cell Communication from single-cell transcriptomics data

## Quiz

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q1",
        "What are the first three limitations that come to mind when inferring CCC from single-cell transcriptomics data?",
        "Spatial context absence, post-transcriptional modifications, temporal dynamics",
    )
    flip_card(
        "q2",
        "What is the role of heteromeric complexes in ligand-receptor inference?",
        "Heteromeric complexes, composed of multiple protein subunits, function collectively as a single receptor or ligand.",
    )
    flip_card(
        "q3",
        "Can you think of an advantage and a disadvantage of inference based on prior-knowledge?",
        "Advantage: Utilizing established databases of ligand-receptor pairs can enhance the accuracy of inferred interactions by providing a validated framework. Disadvantage: Reliance on prior knowledge may bias analyses toward well-characterized interactions, potentially overlooking novel or context-specific communications not documented in existing databases.",
        back_font_size=13,
    )
    flip_card(
        "q4",
        "Can you think of an important limitation we should consider here regarding the definition of the geneset of interest for the NicheNet analysis on the IFN-beta stimulated PBMC dataset?",
        "An important limitation is ensuring that the gene set of interest accurately reflects the biological response to IFN-beta stimulation. If the selected genes are not truly responsive to IFN-beta, the analysis may yield misleading insights into the signaling pathways and interactions involved.",
        front_font_size=15,
        back_font_size=13,
    )
```

## References

1. Armingol, E., Officer, A., Harismendy, O., & Lewis, N. E. (2021). Deciphering cell-cell interactions and communication from gene expression. *Nature Reviews. Genetics*, *22*(2), 71–88. https://doi.org/10.1038/s41576-020-00292-x
2. Almet, A. A., Cang, Z., Jin, S., & Nie, Q. (2021). The landscape of cell-cell communication through single-cell transcriptomics. *Current Opinion in Systems Biology*, *26*, 12–23. https://doi.org/10.1016/j.coisb.2021.03.007
3. Efremova, M., Vento-Tormo, M., Teichmann, S. A., & Vento-Tormo, R. (2020). CellPhoneDB: inferring cell-cell communication from combined expression of multi-subunit ligand-receptor complexes. *Nature Protocols*, *15*(4), 1484–1506. https://doi.org/10.1038/s41596-020-0292-x
4. Jin, S., Guerrero-Juarez, C. F., Zhang, L., Chang, I., Ramos, R., Kuan, C.-H., Myung, P., Plikus, M. V., & Nie, Q. (2021). Inference and analysis of cell-cell communication using CellChat. *Nature Communications*, *12*(1), 1088. https://doi.org/10.1038/s41467-021-21246-9
5. Raredon, M. S. B., Yang, J., Garritano, J., Wang, M., Kushnir, D., Schupp, J. C., Adams, T. S., Greaney, A. M., Leiby, K. L., Kaminski, N., Kluger, Y., Levchenko, A., & Niklason, L. E. (2022). Computation and visualization of cell-cell signaling topologies in single-cell systems data using Connectome. *Scientific Reports*, *12*(1), 4187. https://doi.org/10.1038/s41598-022-07959-x
6. Hou, R., Denisenko, E., Ong, H. T., Ramilowski, J. A., & Forrest, A. R. (2020). Predicting cell-to-cell communication networks using NATMI. *Nature Communications*, *11*(1), 1–11.
7. Wang, S., Karikomi, M., MacLean, A. L., & Nie, Q. (2019). Cell lineage and communication network inference via optimization for single-cell transcriptomics. *Nucleic Acids Research*, *47*(11), e66. https://doi.org/10.1093/nar/gkz204
8. Browaeys, R., Saelens, W., & Saeys, Y. (2020). NicheNet: modeling intercellular communication by linking ligands to target genes. *Nature Methods*, *17*(2), 159–162. https://doi.org/10.1038/s41592-019-0667-5
9. Hu, Y., Peng, T., Gao, L., & Tan, K. (2021). CytoTalk: De novo construction of signal transduction networks using single-cell transcriptomic data. *Science Advances*, *7*(16). https://doi.org/10.1126/sciadv.abf1356
10. Liu, Z., Sun, D., & Wang, C. (2022). Evaluation of cell-cell interaction methods by integrating single-cell RNA sequencing data with spatial information. *Genome Biology*, *23*(1), 218. https://doi.org/10.1186/s13059-022-02783-y
11. Dimitrov, D., Türei, D., Garrido-Rodriguez, M., Burmedi, P. L., Nagai, J. S., Boys, C., Ramirez Flores, R. O., Kim, H., Szalai, B., Costa, I. G., Valdeolivas, A., Dugourd, A., & Saez-Rodriguez, J. (2022). Comparison of methods and resources for cell-cell communication inference from single-cell RNA-Seq data. *Nature Communications*, *13*(1), 3224. https://doi.org/10.1038/s41467-022-30755-0
12. Cesaro, G., Nagai, J. S., Gnoato, N., Chiodi, A., Tussardi, G., Klöker, V., Musumarra, C. V., Mosca, E., Costa, I. G., Di Camillo, B., & others. (2025). Advances and challenges in cell–cell communication inference: a comprehensive review of tools, resources, and future directions. *Briefings in Bioinformatics*, *26*(3), bbaf280.
13. Armingol, E., Baghdassarian, H. M., & Lewis, N. E. (2024). The diversification of methods for studying cell–cell interactions and communication. *Nature Reviews Genetics*, *25*(6), 381–400.
14. Wang, S., Zheng, H., Choi, J. S., Lee, J. K., Li, X., & Hu, H. (2022). A systematic evaluation of the computational tools for ligand-receptor-based cell-cell interaction inference. *Briefings in Functional Genomics*, *21*(5), 339–356. https://doi.org/10.1093/bfgp/elac019
15. Cheng, X., Huang, H., Su, Y., Nie, Q., Zou, X., & Jin, S. (2025). Cell-cell communication inference and analysis: biological mechanisms, computational approaches, and future opportunities. *arXiv Preprint arXiv:2512.03497*.
16. Luecken, M. D., Gigante, S., Burkhardt, D. B., Cannoodt, R., Strobl, D. C., Markov, N. S., Zappia, L., Palla, G., Lewis, W., Dimitrov, D., & others. (2025). Defining and benchmarking open problems in single-cell analysis. *Nature Biotechnology*, *43*(7), 1035–1040.
17. Luo, J., Deng, M., Zhang, X., & Sun, X. (2023). ESICCC as a systematic computational framework for evaluation, selection, and integration of cell-cell communication inference methods. *Genome Research*, *33*(10), 1788–1805.
18. Kang, H. M., Subramaniam, M., Targ, S., Nguyen, M., Maliskova, L., McCarthy, E., Wan, E., Wong, S., Byrnes, L., Lanata, C. M., & others. (2018). Multiplexed droplet single-cell RNA-sequencing using natural genetic variation. *Nature Biotechnology*, *36*(1), 89–94.
19. Palla, G., Fischer, D. S., Regev, A., & Theis, F. J. (2022). Spatial components of molecular tissue biology. *Nature Biotechnology*, *40*(3), 308–318.
20. Wilk, A. J., Shalek, A. K., Holmes, S., & Blish, C. A. (2022). Comparative analysis of cell-cell communication at single-cell resolution. *BioRxiv*. https://doi.org/10.1101/2022.02.04.479209
21. Nagai, J. S., Leimkühler, N. B., Schaub, M. T., Schneider, R. K., & Costa, I. G. (2021). CrossTalkeR: analysis and visualization of ligand–receptorne tworks. *Bioinformatics*, *37*(22), 4263–4265.
22. Armingol, E., Baghdassarian, H. M., Martino, C., Perez-Lopez, A., Aamodt, C., Knight, R., & Lewis, N. E. (2022). Context-aware deconvolution of cell-cell communication with Tensor-cell2cell. *Nature Communications*, *13*(1), 3665. https://doi.org/10.1038/s41467-022-31369-2
23. Raredon, M. S. B., Yang, J., Kothapalli, N., Lewis, W., Kaminski, N., Niklason, L. E., & Kluger, Y. (2023). Comprehensive visualization of cell-cell interactions in single-cell and spatial transcriptomics with NICHES. *Bioinformatics*, *39*(1). https://doi.org/10.1093/bioinformatics/btac775
24. Zheng, R., Zhang, Y., Tsuji, T., Zhang, L., Tseng, Y.-H., & Chen, K. (2022). MEBOCOST: Metabolic Cell-Cell Communication Modeling by Single Cell Transcriptome. *BioRxiv*. https://doi.org/10.1101/2022.05.30.494067
25. Garcia-Alonso, L., Lorenzi, V., Mazzeo, C. I., Alves-Lopes, J. P., Roberts, K., Sancho-Serra, C., Engelbert, J., Marečková, M., Gruhn, W. H., Botting, R. A., Li, T., Crespo, B., van Dongen, S., Kiselev, V. Y., Prigmore, E., Herbert, M., Moffett, A., Chédotal, A., Bayraktar, O. A., … Vento-Tormo, R. (2022). Single-cell roadmap of human gonadal development. *Nature*, *607*(7919), 540–547. https://doi.org/10.1038/s41586-022-04918-4
26. Zhang, Y., Liu, T., Wang, J., Zou, B., Li, L., Yao, L., Chen, K., Ning, L., Wu, B., Zhao, X., & Wang, D. (2021). Cellinker: a platform of ligand-receptor interactions for intercellular communication analysis. *Bioinformatics*. https://doi.org/10.1093/bioinformatics/btab036
