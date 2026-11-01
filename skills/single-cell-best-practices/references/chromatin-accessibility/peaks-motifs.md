# Peak calling and motif analysis

Source: https://www.sc-best-practices.org/chromatin-accessibility/peaks-motifs  
Authors: Lukas Heumos

**🧠 Key takeaways**

- Peaks are called separately for each cell type and merged into one set of fixed-width peaks, so that rare cell types contribute their own peaks.
- Cell type-specific peaks can be selected quickly by comparing pooled accessibility, whereas significance requires a statistical test.
- Motifs enriched in the specific peaks of a cell type point to the transcription factors that regulate it.

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

Tiles are enough to cluster cells, but peaks, the regions with more accessibility than the genomic background, are the candidate regulatory elements that we want to compare between cell types and scan for transcription factor (TF) binding motifs.
Peaks called on all cells together are dominated by abundant cell types, so we call peaks separately on the pooled fragments of each cell type and merge them into one set of fixed-width peaks (Corces *et al.*, 2018 [1]; Granja *et al.*, 2021 [2]).

```python
import logging

import lamindb as ln
import snapatac2 as snap

for name in ("kaleido", "choreographer"):
    logging.getLogger(name).setLevel(logging.WARNING)

ln.connect("theislab/sc-best-practices")

ln.track("wziys4Y5jNux")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ loaded Transform('wziys4Y5jNux0000', key='peaks_motifs.ipynb'), started new Run('oErvc76qTUJM9RFR') at 2026-09-29 15:38:52 UTC
→ notebook imports: lamindb-core==2.10.0 snapatac2==2.10.0
```

We load the cells annotated in the [previous chapter](../chromatin-accessibility/dimensionality-reduction-clustering.md).

```python
adata = ln.Artifact.get(key="chromatin_accessibility/pbmc10k_clustered.h5ad").load()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 9255 × 6062095
    obs: 'n_fragment', 'frac_dup', 'frac_mito', 'tsse', 'doublet_probability', 'doublet_score', 'leiden', 'cell_type'
    var: 'count', 'selected'
    uns: 'TSS_profile', 'cell_type_colors', 'doublet_rate', 'frac_overlap_TSS', 'frag_size_distr', 'leiden_colors', 'library_tsse', 'reference_sequences', 'scrublet_sim_doublet_score', 'spectral_eigenvalue'
    obsm: 'X_spectral', 'X_umap', 'fragment_paired'
    obsp: 'distances'
    layers: None (.X)
```

## Peak calling

SnapATAC2 calls peaks with MACS3 (Zhang *et al.*, 2008 [3]) on the fragments of each cell type.
`merge_peaks` then centers every peak on its summit, extends it to 500 bp and, where peaks overlap, keeps only the most significant one.

```python
snap.tl.macs3(adata, groupby="cell_type")
peaks = snap.tl.merge_peaks(adata.uns["macs3"], snap.genome.hg38.chrom_sizes)
peak_matrix = snap.pp.make_peak_matrix(adata, use_rep=peaks["Peaks"])
```

```python
peak_matrix
```

Output:
```text
AnnData object with n_obs × n_vars = 9255 × 201931
    obs: 'n_fragment', 'frac_dup', 'frac_mito', 'tsse', 'doublet_probability', 'doublet_score', 'leiden', 'cell_type'
    layers: None (.X)
```

## Cell type-specific peaks

`marker_regions` quickly finds peaks that are more accessible in one cell type than in the others by comparing their accessibility after pooling the cells of each type.
It does not test for significance, which requires a statistical model such as the one in `snap.tl.diff_test`, but it is enough to select regions for motif analysis.

```python
markers = snap.tl.marker_regions(peak_matrix, groupby="cell_type", pvalue=0.01)
snap.pl.regions(peak_matrix, groupby="cell_type", peaks=markers, interactive=False)
```

## Motif enrichment

TFs bind short sequence motifs, so a motif that is overrepresented in the peaks of a cell type points to TFs that regulate it.
We test the marker peaks of each cell type for the TF motifs of CIS-BP (Weirauch *et al.*, 2014 [4]), keeping the most informative motif per TF, against the marker peaks of all cell types.

```python
fasta = ln.Artifact.get(key="chromatin_accessibility/gencode_v41_GRCh38.fa").cache()
motif_file = ln.Artifact.get(key="chromatin_accessibility/cisBP_human.meme").cache()
cis_bp = {}
for motif in snap.read_motifs(str(motif_file)):
    motif.id = motif.name = motif.id.split("+")[0]
    if (
        motif.name not in cis_bp
        or motif.info_content() > cis_bp[motif.name].info_content()
    ):
        cis_bp[motif.name] = motif
enrichment = snap.tl.motif_enrichment(
    motifs=list(cis_bp.values()), regions=markers, genome_fasta=fasta
)
```

```python
snap.pl.motif_enrichment(enrichment, max_fdr=1e-20, height=1200, interactive=False)
```

The motifs enriched in each cell type match its known regulators: CEBP and AP-1 motifs in CD14+ monocytes, PU.1 (SPI1) motifs in CD16+ monocytes and cDC2, and NR4A motifs in CD16+ monocytes.
NK and effector CD8+ T cells are enriched for the T-box motif of EOMES and T-bet, naive T cells for the motif of LEF1 and TCF7, and MAIT cells for the ROR motif.
B cells are enriched for EBF1 and octamer motifs, which OCT2 binds together with its coactivator OBF1 (POU2AF1), and pDCs for E-box motifs, which include the motif of TCF4.
TFs of one family share nearly identical motifs, so enrichment points to a family rather than a single TF, and the expression of its members shows which of them is active.

Motif enrichment describes groups of peaks, not single cells.
chromVAR estimates the accessibility of each motif in every cell against background peaks with matching GC content and accessibility (Schep *et al.*, 2017 [5]), but its Python port, pychromVAR, has neither been published nor updated since 2023, so we do not use it here.

We store the peak matrix for the [gene regulatory network chapter](../chromatin-accessibility/gene-regulatory-networks-atac.md).

```python
ln.Artifact.from_anndata(
    peak_matrix,
    key="chromatin_accessibility/pbmc10k_peaks.h5ad",
    description="PBMC 10k multiome peak matrix of cell type-specific peaks",
).save()
```

Output:
```text
→ returning artifact with same hash: Artifact(uid='cVC0NFWH4GNmOHGK0000', key='chromatin_accessibility/pbmc10k_peaks.h5ad', description='PBMC 10k multiome peak matrix of cell type-specific peaks', suffix='.h5ad', kind='dataset', otype='AnnData', size=589440702, hash='LJhJVBzFJWyHV2LgZbZpG-', n_files=None, n_observations=9255, extra_data=None, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=171, schema_id=None, created_by_id=2, created_at=2026-09-29 15:34:35 UTC, is_locked=False, version_tag=None, is_latest=True); to track this artifact as an input, use: ln.Artifact.get()
Artifact(uid='cVC0NFWH4GNmOHGK0000', key='chromatin_accessibility/pbmc10k_peaks.h5ad', description='PBMC 10k multiome peak matrix of cell type-specific peaks', suffix='.h5ad', kind='dataset', otype='AnnData', size=589440702, hash='LJhJVBzFJWyHV2LgZbZpG-', n_files=None, n_observations=9255, extra_data=None, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=171, schema_id=None, created_by_id=2, created_at=2026-09-29 15:34:35 UTC, is_locked=False, version_tag=None, is_latest=True)
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Lukas Heumos

## References

1. Corces, M. R., Granja, J. M., Shams, S., Louie, B. H., Seoane, J. A., Zhou, W., Silva, T. C., Groeneveld, C., Wong, C. K., Cho, S. W., Satpathy, A. T., Mumbach, M. R., Hoadley, K. A., Robertson, A. G., Sheffield, N. C., Felau, I., Castro, M. A. A., Berman, B. P., Staudt, L. M., … Zhu, J. (2018). The chromatin accessibility landscape of primary human cancers. *Science*, *362*(6413), eaav1898. https://doi.org/10.1126/science.aav1898
2. Granja, J. M., Corces, M. R., Pierce, S. E., Bagdatli, S. T., Choudhry, H., Chang, H. Y., & Greenleaf, W. J. (2021). ArchR is a scalable software package for integrative single-cell chromatin accessibility analysis. *Nature Genetics*, *53*(3), 403–411. https://doi.org/10.1038/s41588-021-00790-6
3. Zhang, Y., Liu, T., Meyer, C. A., Eeckhoute, J., Johnson, D. S., Bernstein, B. E., Nusbaum, C., Myers, R. M., Brown, M., Li, W., & Liu, X. S. (2008). Model-based Analysis of ChIP-Seq (MACS). *Genome Biology*, *9*(9), R137. https://doi.org/10.1186/gb-2008-9-9-r137
4. Weirauch, M. T., Yang, A., Albu, M., Cote, A. G., Montenegro-Montero, A., Drewe, P., Najafabadi, H. S., Lambert, S. A., Mann, I., Cook, K., Zheng, H., Goity, A., van Bakel, H., Lozano, J.-C., Galli, M., Lewsey, M. G., Huang, E., Mukherjee, T., Chen, X., … Hughes, T. R. (2014). Determination and Inference of Eukaryotic Transcription Factor Sequence Specificity. *Cell*, *158*(6), 1431–1443. https://doi.org/10.1016/j.cell.2014.08.009
5. Schep, A. N., Wu, B., Buenrostro, J. D., & Greenleaf, W. J. (2017). chromVAR: inferring transcription-factor-associated accessibility from single-cell epigenomic data. *Nature Methods*, *14*(10), 975–978. https://doi.org/10.1038/nmeth.4401
