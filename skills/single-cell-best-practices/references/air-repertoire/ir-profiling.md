# Immune receptor profiling

Source: https://www.sc-best-practices.org/air-repertoire/ir-profiling  
Authors: Felix Drost, Lukas Heumos

**🧠 Key takeaways**

- T and B cells recognize antigens with receptors whose diversity arises from V(D)J recombination, and the CDR3 at the junction of the gene segments is their most diverse part.
- Droplet-based V(D)J libraries are assembled with Cell Ranger, and BCRs should be re-annotated with IgBLAST to reconstruct germline sequences.
- Cells with more than two chains of a type or with both TCR and BCR chains are likely doublets, and the receptor type should agree with the transcriptomic cell type.

**⚙️ Environment setup**

**yml:**

```yaml
name: air-repertoire
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
      - mudata==0.4.1
      - scirpy==0.25.1
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Adaptive immune receptors

T and B cells recognize antigens with their adaptive immune receptors (AIRs), the T cell receptor (TCR) and the B cell receptor (BCR) (Cooper & Alder, 2006 [1]).
TCRs bind peptides presented by major histocompatibility complex (MHC) molecules, whereas BCRs bind antigens directly and are secreted as antibodies by plasma cells.
Both receptors consist of two chains, an α and a β or a γ and a δ chain for TCRs and a heavy and a κ or λ light chain for BCRs.
We refer to the α, γ, κ and λ chains as VJ chains and to the β, δ and heavy chains as VDJ chains, after the gene segments that encode them.

![AIR types](https://www.sc-best-practices.org/build/AIR_types-3bbb1e7c66dc653e88fdc3e21b9fb8b2.png)

*Figure 1: Schematic drawing of the two AIR types. Created with [BioRender.com](http://BioRender.com).*

Each developing lymphocyte assembles its receptor chains by [V(D)J recombination](../glossary.md#term-v-d-j-recombination) of one V, (D) and J gene segment and inserts or deletes nucleotides where they join.
This allows for about 10<sup>20</sup> different TCRs, of which a human carries 10<sup>7</sup> to 10<sup>8</sup> (Zarnitsyna *et al.*, 2013 [2]; Qi *et al.*, 2014 [3]).
The third [complementarity-determining region](../glossary.md#term-complementarity-determining-region-cdr) (CDR3) spans these junctions and is therefore the most diverse part of each chain and its main contact with the antigen, whereas CDR1 and CDR2 are encoded by the V gene.
Activated B cells further diversify their receptors by [somatic hypermutation](../glossary.md#term-somatic-hypermutation-shm) and switch the constant region of the heavy chain, which determines the antibody isotype.

![VDJ recombination](https://www.sc-best-practices.org/build/VDJ_recombination-6577617fcc2b38055a5031fc98c92a10.png)

*Figure 2: VDJ recombination at the example of an αβ-TCR. Created with [BioRender.com](http://BioRender.com).*

Tools and databases report the CDR3 either as the [junction](../glossary.md#term-junction), which includes the conserved cysteine and the phenylalanine or tryptophan that flank it, or without these residues.
The AIRR Rearrangement standard, which scirpy follows, stores both as separate fields, `junction` and `cdr3`, and sequences can only be compared between resources if they use the same definition (Vander Heiden *et al.*, 2018 [4]).

## Sequencing immune receptors

Droplet-based protocols such as 10x Genomics 5’ sequencing amplify the receptor transcripts of each cell into a V(D)J library next to the gene expression library.
Cell Ranger assembles these reads into contigs, annotates their gene segments and assigns them to cells.
Receptors can also be reconstructed from gene expression reads alone, for which TRUST4 and MiXCR perform best, but only with sufficient sequencing depth and read length (Song *et al.*, 2021 [5]; Bolotin *et al.*, 2015 [6]; Tian *et al.*, 2025 [7]).
For plate-based data with full-length transcripts, BraCeR and BALDR reconstruct mutated BCRs most accurately (Andreani *et al.*, 2022 [8]).

BCRs should additionally be re-annotated with IgBLAST against IMGT references, for example with Dandelion or the Immcantation suite, which also reconstructs the germline sequences needed to measure somatic hypermutation (Suo *et al.*, 2024 [9]; Gupta *et al.*, 2015 [10]).

## Dataset

We use peripheral blood mononuclear cells (PBMCs) of the COVID-19 study by Stephenson et al., for which gene expression, TCR and BCR libraries were sequenced from the same cells with the 10x Genomics 5’ protocol (Stephenson *et al.*, 2021 [11]).
We keep the 46 donors sampled in Cambridge, 11 healthy donors and 35 patients with asymptomatic to critical COVID-19, and the cell type annotation of the authors.
The TCRs were assembled with Cell Ranger, and the BCRs were re-annotated with IgBLAST and their germline sequences reconstructed with Dandelion.

```python
import warnings

import anndata as ad
import lamindb as ln
import scirpy as ir

warnings.filterwarnings("ignore", category=ad.ExperimentalFeatureWarning)

ln.connect("theislab/sc-best-practices")

ln.track("eZhjlUu0uDVY")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
! It looks like you are running jupyter lab but don't have jupyter-server module installed. Please install it via pip install jupyter-server
→ loaded Transform('eZhjlUu0uDVY0000', key='ir_profiling.ipynb'), started new Run('AsSbEc6LOmD0yA5J') at 2026-09-29 18:06:28 UTC
→ notebook imports: anndata==0.13.2 lamindb-core==2.10.0 scirpy==0.25.1
```

The data are stored as a MuData object with the gene expression in the `gex` modality and the receptors in the `airr` modality, as introduced in the [chapter on multimodal data structures](../introduction/advanced-data-structures-and-frameworks.md).
Cells without a detected receptor, such as monocytes, are only part of the `gex` modality.

```python
mdata = ln.Artifact.get(key="air_repertoire/stephenson2021_cambridge.h5mu").load()
mdata
```

Output:
```text
MuData object with n_obs × n_vars = 104492 × 24737
  2 modalities
    gex:	104492 × 24737
      obs:	'patient_id', 'sample_id', 'sex', 'age', 'severity', 'days_from_onset', 'worst_clinical_status', 'outcome', 'cell_type_coarse', 'cell_type'
      obsm:	'X_pca_harmony', 'X_umap'
      layers:	None
    airr:	75188 × 0
      uns:	'scirpy_version'
      obsm:	'airr'
```

Scirpy stores all contigs of a cell in the AIRR format.
`index_chains` keeps the productive chains and ranks them by their number of UMIs into a primary and a secondary VJ and VDJ chain, which we can retrieve with `ir.get.airr`.

```python
ir.pp.index_chains(mdata)
ir.get.airr(
    mdata, ["locus", "junction_aa", "v_call"], ["VJ_1", "VDJ_1"]
).dropna().head()
```

## Quality control

A cell can express a second VJ or VDJ chain, since T cells often carry two α chains and B cells two light chains, whereas more than two chains of a type indicate doublets (Schuldt & Binstadt, 2019 [12]; Zhu *et al.*, 2023 [13]).
`chain_qc` summarizes each cell by its receptor type and by the pairing of its chains:

- `single pair`: one VJ and one VDJ chain
- `orphan VJ` and `orphan VDJ`: only one of the two chains
- `extra VJ`, `extra VDJ` and `two full chains`: a second chain of one or both types
- `multichain`: more than two chains of a type, most likely doublets
- `ambiguous`: TCR and BCR chains in the same cell

```python
ir.tl.chain_qc(mdata)
mdata.pull_obs()
```

The receptors detected in a cell should agree with its cell type, which the gene expression tells us.

```python
_ = ir.pl.group_abundance(
    mdata,
    groupby="gex:cell_type_coarse",
    target_col="airr:receptor_type",
    normalize=True,
    figsize=(8, 4),
)
```

Most T cells and MAIT cells carry a TCR, and most B cells and plasmablasts a BCR.
TCRs in NK cells or in cells annotated as platelets or red blood cells point to doublets, platelets bound to T cells or ambient RNA.
γδ T cells rarely have a TCR, since the V(D)J library only amplifies αβ chains.

```python
_ = ir.pl.group_abundance(
    mdata, groupby="airr:receptor_type", target_col="airr:chain_pairing", normalize=True
)
```

About 70% of T cells and 80% of B cells have a single pair of chains.
Most of the remaining T cells lack the α chain, which is detected less often than the β chain, whereas B cells more often carry a second light chain.

## Filtering

We remove cells with more chains than a cell can express and cells whose receptor does not match their cell type.
We keep orphan chains and flag them, since whether they are usable depends on the analysis.
Clonotypes defined by both chains cannot include them, whereas a database query of the β chain can.
From here on, we analyze T and B cells separately, since their receptors are treated differently.

```python
t_cells = ["CD4", "CD8", "Treg", "MAIT", "gdT", "Lymph_prolif"]
b_cells = ["B_cell", "Plasmablast"]
receptor_type = mdata.obs["airr:receptor_type"]
cell_type = mdata.obs["gex:cell_type_coarse"]
mdata_tcr = mdata[(receptor_type == "TCR") & cell_type.isin(t_cells)].copy()
mdata_bcr = mdata[(receptor_type == "BCR") & cell_type.isin(b_cells)].copy()
for data in (mdata_tcr, mdata_bcr):
    data.obs = data.obs.apply(
        lambda col: (
            col.cat.remove_unused_categories() if col.dtype == "category" else col
        )
    )
mdata_tcr.n_obs, mdata_bcr.n_obs
```

Output:
```text
(54137, 13422)
```

We store both objects for the [clonotype analysis](../air-repertoire/clonotype.md).

```python
ln.Artifact.from_mudata(
    mdata_tcr,
    key="air_repertoire/stephenson2021_tcr_qc.h5mu",
    description="T cells with TCRs of the Stephenson 2021 Cambridge samples after quality control",
).save()
ln.Artifact.from_mudata(
    mdata_bcr,
    key="air_repertoire/stephenson2021_bcr_qc.h5mu",
    description="B cells with BCRs of the Stephenson 2021 Cambridge samples after quality control",
).save()
```

Output:
```text
→ creating new artifact version for key 'air_repertoire/stephenson2021_tcr_qc.h5mu' in storage 's3://lamin-eu-central-1/VPwcjx3CDAa2'

... uploading A54ugwVUlFz0PV5n0002.h5mu:  0.0%

... uploading A54ugwVUlFz0PV5n0002.h5mu:  7.1%

... uploading A54ugwVUlFz0PV5n0002.h5mu: 14.1%

... uploading A54ugwVUlFz0PV5n0002.h5mu: 28.2%

... uploading A54ugwVUlFz0PV5n0002.h5mu: 42.3%

... uploading A54ugwVUlFz0PV5n0002.h5mu: 70.5%

... uploading A54ugwVUlFz0PV5n0002.h5mu: 71.8%

... uploading A54ugwVUlFz0PV5n0002.h5mu: 78.8%

... uploading A54ugwVUlFz0PV5n0002.h5mu: 85.9%

... uploading A54ugwVUlFz0PV5n0002.h5mu: 100.0%
• replacing the existing cache path /home/lheumos/.cache/lamindb/lamin-eu-central-1/VPwcjx3CDAa2/air_repertoire/stephenson2021_tcr_qc.h5mu
→ creating new artifact version for key 'air_repertoire/stephenson2021_bcr_qc.h5mu' in storage 's3://lamin-eu-central-1/VPwcjx3CDAa2'

... uploading ORrJ4xnxnhHL8smm0002.h5mu:  0.0%
... (7 more lines)
```

## Quiz

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q1",
        "Why is the CDR3 the most diverse part of an immune receptor?",
        "It spans the junctions of the V, (D) and J gene segments, where nucleotides are randomly inserted and deleted during recombination.",
        back_font_size=15,
    )
    flip_card(
        "q2",
        "Why should BCRs be re-annotated with IgBLAST?",
        "Re-annotation against IMGT references reconstructs the germline sequences, which are needed to quantify somatic hypermutation.",
        back_font_size=15,
    )
    flip_card(
        "q3",
        "Which cells should be removed before clonotype analysis?",
        "Cells with more than two chains of a type or with both TCR and BCR chains, which are likely doublets, and cells whose receptor does not match their cell type.",
        back_font_size=15,
    )
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Felix Drost

### Reviewers

- Lukas Heumos

## References

1. Cooper, M. D., & Alder, M. N. (2006). The evolution of adaptive immune systems. *Cell*, *124*(4), 815–822.
2. Zarnitsyna, V., Evavold, B., Schoettle, L., Blattman, J., & Antia, R. (2013). Estimating the diversity, completeness, and cross-reactivity of the T cell repertoire. *Frontiers in Immunology*, *4*, 485.
3. Qi, Q., Liu, Y., Cheng, Y., Glanville, J., Zhang, D., Lee, J.-Y., Olshen, R. A., Weyand, C. M., Boyd, S. D., & Goronzy, J. J. (2014). Diversity and clonal selection in the human T-cell repertoire. *Proceedings of the National Academy of Sciences*, *111*(36), 13139–13144. https://doi.org/10.1073/pnas.1409155111
4. Vander Heiden, J. A., Marquez, S., Marthandan, N., Bukhari, S. A. C., Busse, C. E., Corrie, B., Hershberg, U., Kleinstein, S. H., Matsen IV, F. A., Ralph, D. K., Rosenfeld, A. M., Schramm, C. A., Community, T. A., Christley, S., & Laserson, U. (2018). AIRR Community Standardized Representations for Annotated Immune Repertoires. *Frontiers in Immunology*, *9*, 2206. https://doi.org/10.3389/fimmu.2018.02206
5. Song, L., Cohen, D., Ouyang, Z., Cao, Y., Hu, X., & Liu, X. S. (2021). TRUST4: immune repertoire reconstruction from bulk and single-cell RNA-seq data. *Nature Methods*, *18*(6), 627–630. https://doi.org/10.1038/s41592-021-01142-2
6. Bolotin, D. A., Poslavsky, S., Mitrophanov, I., Shugay, M., Mamedov, I. Z., Putintseva, E. V., & Chudakov, D. M. (2015). MiXCR: software for comprehensive adaptive immunity profiling. *Nature Methods*, *12*(5), 380–381. https://doi.org/10.1038/nmeth.3364
7. Tian, R., Yu, Z., Xue, Z., Wu, J., Wu, L., Cai, S., Gao, B., He, B., Zhao, Y., Yao, J., Lu, L., & Liu, W. (2025). Evaluation of T Cell Receptor Construction Methods from scRNA-Seq Data. *Genomics, Proteomics & Bioinformatics*, *22*(6), qzae086. https://doi.org/10.1093/gpbjnl/qzae086
8. Andreani, T., Slot, L. M., Gabillard, S., Strübing, C., Reimertz, C., Yaligara, V., Bakker, A. M., Olfati-Saber, R., Toes, R. E. M., Scherer, H. U., Augé, F., & Šimaitė, D. (2022). Benchmarking computational methods for B-cell receptor reconstruction from single-cell RNA-seq data. *NAR Genomics and Bioinformatics*, *4*(3), lqac049. https://doi.org/10.1093/nargab/lqac049
9. Suo, C., Polanski, K., Dann, E., Lindeboom, R. G. H., Vilarrasa-Blasi, R., Vento-Tormo, R., Haniffa, M., Meyer, K. B., Dratva, L. M., Tuong, Z. K., Clatworthy, M. R., & Teichmann, S. A. (2024). Dandelion uses the single-cell adaptive immune receptor repertoire to explore lymphocyte developmental origins. *Nature Biotechnology*, *42*(1), 40–51. https://doi.org/10.1038/s41587-023-01734-7
10. Gupta, N. T., Vander Heiden, J. A., Uduman, M., Gadala-Maria, D., Yaari, G., & Kleinstein, S. H. (2015). Change-O: a toolkit for analyzing large-scale B cell immunoglobulin repertoire sequencing data. *Bioinformatics*, *31*(20), 3356–3358.
11. Stephenson, E., Reynolds, G., Botting, R. A., Calero-Nieto, F. J., Morgan, M. D., Tuong, Z. K., Bach, K., Sungnak, W., Worlock, K. B., Yoshida, M., & others. (2021). Single-cell multi-omics analysis of the immune response in COVID-19. *Nature Medicine*, *27*(5), 904–916.
12. Schuldt, N. J., & Binstadt, B. A. (2019). Dual TCR T cells: identity crisis or multitaskers? *The Journal of Immunology*, *202*(3), 637–644.
13. Zhu, L., Peng, Q., Wu, Y., & Yao, X. (2023). scBCR-seq revealed a special and novel IG H&L V(D)J allelic inclusion rearrangement and the high proportion dual BCR expressing B cells. *Cellular and Molecular Life Sciences*, *80*(11), 319. https://doi.org/10.1007/s00018-023-04973-8
