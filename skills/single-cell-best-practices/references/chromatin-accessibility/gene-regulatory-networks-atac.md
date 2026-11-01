# Gene regulatory networks

Source: https://www.sc-best-practices.org/chromatin-accessibility/gene-regulatory-networks-atac  
Authors: Ignacio Ibarra, Lukas Heumos, Anna Schaar

**🧠 Key takeaways**

- Multiome data allow regions to be linked to genes and TFs to regions in the same cells, but the resulting networks are hypotheses that differ between methods.
- Region-gene links combine genomic proximity with the correlation of accessibility and expression, and TF-region links require a binding motif.
- Only a small fraction of inferred links is supported by prior knowledge, so networks need validation, ideally by perturbing the TFs.

**⚙️ Environment setup**

**yml:**

```yaml
name: chromatin-accessibility
channels:
  - conda-forge
dependencies:
  - conda-forge::ipykernel=7.3.0
  - conda-forge::ipywidgets=8.1.9
  - conda-forge::python=3.13.15
  - conda-forge::scanpy=1.12.4
  - pip
  - pip:
      - lamindb==2.10.0
      - macs3==3.0.5
      - muon==0.1.9
      - snapatac2==2.10.0
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

Transcription factors (TFs) regulate genes by binding to accessible regulatory regions, such as promoters and enhancers, whose accessibility changes with their activity (Spitz & Furlong, 2012 [1]).
Multiome data measure accessibility and expression in the same cells, which allows us to link regions to the genes whose expression follows their accessibility, and TFs to the regions that contain their motifs.
Together, these links form a network from TFs through regions to target genes, the idea behind methods such as SCENIC+ (Bravo González-Blas *et al.*, 2023 [2]).

Such networks are hypotheses rather than measurements: the networks of different methods barely overlap, change with random seeds and preprocessing, and predict the effects of perturbations poorly (Mompel *et al.*, 2024 [3]).
For TF activities from gene expression alone, see the [gene regulatory network chapter](../mechanisms/gene-regulatory-networks.md) of the RNA section.

```python
import lamindb as ln
import pandas as pd
import scanpy as sc
import snapatac2 as snap

ln.connect("theislab/sc-best-practices")

ln.track("N64Xsy5YJqH4")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ loaded Transform('N64Xsy5YJqH40000', key='gene_regulatory_networks_atac.ipynb'), started new Run('Zh98aN728L2pCIMK') at 2026-09-29 15:44:48 UTC
→ notebook imports: lamindb-core==2.10.0 pandas==2.3.3 scanpy==1.12.4 snapatac2==2.10.0
```

We load the peak matrix from the [previous chapter](../chromatin-accessibility/peaks-motifs.md) and the gene expression of the same cells, and normalize both with the shifted logarithm.
We restrict the network to the cell type-specific peaks and to the 2,000 most variable genes, which keeps it small and focused on regulation that differs between cell types.

```python
peak_matrix = ln.Artifact.get(key="chromatin_accessibility/pbmc10k_peaks.h5ad").load()
rna = ln.Artifact.get(
    key="introduction/advanced_data_structures_and_frameworks_muon.h5mu"
).load()["rna"]
rna = rna[peak_matrix.obs_names].copy()
rna.var_names_make_unique()
for data in (peak_matrix, rna):
    sc.pp.normalize_total(data)
    sc.pp.log1p(data)
sc.pp.highly_variable_genes(rna, n_top_genes=2000)
markers = snap.tl.marker_regions(peak_matrix, groupby="cell_type", pvalue=0.01)
regions = sorted({region for peaks in markers.values() for region in peaks})
```

## Linking regions to genes

We connect every region to the genes whose transcription start site lies within 250 kb and keep the links in which accessibility and expression are correlated across cells.

```python
annotation = ln.Artifact.get(
    key="chromatin_accessibility/gencode_v41_GRCh38.gff3.gz"
).cache()
network = snap.tl.init_network_from_annotation(regions, annotation)
variable_genes = set(rna.var_names[rna.var["highly_variable"]])
network = snap.tl.prune_network(
    network, node_filter=lambda node: node.type != "gene" or node.id in variable_genes
)
snap.tl.add_cor_scores(network, gene_mat=rna, peak_mat=peak_matrix)
network = snap.tl.prune_network(
    network, edge_filter=lambda source, target, link: link.cor_score > 0.1
)
```

```python
f"{network.num_edges()} region-gene links"
```

Output:
```text
'541 region-gene links'
```

## Adding transcription factors

Next, we connect TFs to the linked regions that contain their CIS-BP motif (Weirauch *et al.*, 2014 [4]) and derive TF-gene links through these regions (Zhang *et al.*, 2024 [5]).
A motif only shows that a TF could bind, so we additionally require that the TF and its target are co-expressed, and we remove links of TFs to their own gene, whose correlation is trivially 1.

```python
fasta = ln.Artifact.get(key="chromatin_accessibility/gencode_v41_GRCh38.fa").cache()
motif_file = ln.Artifact.get(key="chromatin_accessibility/cisBP_human.meme").cache()
cis_bp = {}
for motif in snap.read_motifs(str(motif_file)):
    motif.name = motif.id.split("+")[0]
    if (
        motif.name not in cis_bp
        or motif.info_content() > cis_bp[motif.name].info_content()
    ):
        cis_bp[motif.name] = motif
snap.tl.add_tf_binding(network, motifs=list(cis_bp.values()), genome_fasta=fasta)
grn = snap.tl.link_tf_to_gene(network)
snap.tl.add_cor_scores(grn, gene_mat=rna, peak_mat=peak_matrix)
grn = snap.tl.prune_network(
    grn,
    edge_filter=lambda source, target, link: source != target and link.cor_score > 0.1,
)
edges = pd.DataFrame(
    [
        (grn[source].id, grn[target].id, grn.get_edge_data(source, target).cor_score)
        for source, target in grn.edge_list()
    ],
    columns=["tf", "target", "correlation"],
)
```

```python
edges["tf"].value_counts().head(10)
```

Output:
```text
tf
BCL11A     30
MEF2C      23
KLF4       11
POU2AF1    11
IRF8        8
IRF4        4
YBX3        3
EBF1        3
TCF4        3
CREB5       2
Name: count, dtype: int64
```

The network consists of 115 links from 23 TFs to 84 genes, most of them from regulators of B cells, pDCs and monocytes such as BCL11A, MEF2C, POU2AF1, IRF8 and KLF4.
`link_tf_to_gene` only keeps TFs whose own gene is part of the network, so regulators that are not among the highly variable genes, such as LEF1, TCF7, CEBPA and SPI1, are missing although their motifs are enriched in the [previous chapter](../chromatin-accessibility/peaks-motifs.md).

## Comparison with prior knowledge

To see how much of the network is supported by known regulation, we compare its TF-gene links with CollecTRI (Müller-Dott *et al.*, 2023 [6]), the prior-knowledge network that we use in the RNA section.

```python
collectri = ln.Artifact.get(key="conditions/gsea_pathway/collectri.parquet").load()
known = set(zip(collectri["source"], collectri["target"], strict=True))
edges["in_collectri"] = [
    edge in known for edge in zip(edges["tf"], edges["target"], strict=True)
]
edges[edges["in_collectri"]]
```

Only 4 of the 115 links are in CollecTRI, although CollecTRI contains all 23 TFs.
Prior knowledge is incomplete and not specific to cell types, so the other links are not necessarily wrong, but they remain hypotheses until they are tested, for example by perturbing the TF.

## Quiz

### Theory

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q1",
        "Are there generally more chromatin peaks than genes when processing ATAC and RNA data? What is the consequence at the level of structure, when building GRNs?",
        "Generally, there are more chromatin peaks than genes in ATAC-seq data, leading to a many-to-one relationship in gene regulatory networks (GRNs) where multiple regulatory elements can control a single gene.",
        front_font_size=15,
        back_font_size=15,
    )
    flip_card(
        "q2",
        "What is considered a TF activator/repressor at the level of chromatin accessibility, and at the level of gene regulation?",
        "At the level of chromatin accessibility, transcription factor (TF) activators increase accessibility by promoting an open chromatin state, while repressors decrease accessibility by inducing a closed state; in terms of gene regulation, activators enhance transcription, whereas repressors inhibit it.",
        back_font_size=13,
    )
    flip_card(
        "q3",
        "Which additional readouts are complementary to scRNA-seq and scATAC-seq, when interpreting ATAC+RNA GRN models?",
        "Complementary readouts to scRNA-seq and scATAC-seq include techniques like ChIP-seq for profiling protein-DNA interactions and Hi-C for capturing chromatin conformation, providing additional layers of regulatory information.",
        back_font_size=15,
    )
```

### Networks from multiome data

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q4",
        "Why is a TF motif in an accessible region not enough evidence that the TF regulates a nearby gene?",
        "A motif only shows that the TF could bind. Many motif instances are never bound, TFs of the same family share motifs, and the region may regulate a different gene or none at all.",
        back_font_size=15,
    )
    flip_card(
        "q5",
        "Why do multiome data help to link regions to genes?",
        "Accessibility and expression are measured in the same cells, so a region whose accessibility follows the expression of a nearby gene across cells can be linked to it without matching cells between separate experiments.",
        back_font_size=15,
    )
    flip_card(
        "q6",
        "How can the links of an inferred network be validated?",
        "By comparing them with prior knowledge such as curated TF-target interactions, with TF binding measured by ChIP-seq, and with the effects of perturbing the TF, which is the strongest test of a causal link.",
        back_font_size=15,
    )
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Ignacio Ibarra

### Reviewers

- Lukas Heumos
- Anna Schaar

## References

1. Spitz, F., & Furlong, E. E. M. (2012). Transcription factors: from enhancer binding to developmental control. *Nat. Rev. Genet.*, *13*(9), 613–626.
2. Bravo González-Blas, C., De Winter, S., Hulselmans, G., Hecker, N., Matetovici, I., Christiaens, V., Poovathingal, S., Wouters, J., Aibar, S., & Aerts, S. (2023). SCENIC+: single-cell multiomic inference of enhancers and gene regulatory networks. *Nature Methods*, *20*(9), 1355–1367. https://doi.org/10.1038/s41592-023-01938-4
3. Badia-i Mompel, P., Casals-Franch, R., Wessels, L., Müller-Dott, S., Trimbour, R., Yang, Y., Ramirez Flores, R. O., & Saez-Rodriguez, J. (2024). Comparison and evaluation of methods to infer gene regulatory networks from multimodal single-cell data. *bioRxiv*. https://doi.org/10.1101/2024.12.20.629764
4. Weirauch, M. T., Yang, A., Albu, M., Cote, A. G., Montenegro-Montero, A., Drewe, P., Najafabadi, H. S., Lambert, S. A., Mann, I., Cook, K., Zheng, H., Goity, A., van Bakel, H., Lozano, J.-C., Galli, M., Lewsey, M. G., Huang, E., Mukherjee, T., Chen, X., … Hughes, T. R. (2014). Determination and Inference of Eukaryotic Transcription Factor Sequence Specificity. *Cell*, *158*(6), 1431–1443. https://doi.org/10.1016/j.cell.2014.08.009
5. Zhang, K., Zemke, N. R., Armand, E. J., & Ren, B. (2024). A fast, scalable and versatile tool for analysis of single-cell omics data. *Nature Methods*, *21*(2), 217–227. https://doi.org/10.1038/s41592-023-02139-9
6. Müller-Dott, S., Tsirvouli, E., Vazquez, M., Ramirez Flores, R. O., Badia-i Mompel, P., Fallegger, R., Türei, D., Lægreid, A., & Saez-Rodriguez, J. (2023). Expanding the coverage of regulons from high-confidence prior knowledge for accurate estimation of transcription factor activities. *Nucleic Acids Research*, *51*(20), 10934–10949. https://doi.org/10.1093/nar/gkad841
