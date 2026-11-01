# Clonotype analysis

Source: https://www.sc-best-practices.org/air-repertoire/clonotype  
Authors: Juan Henao, Lukas Heumos

**🧠 Key takeaways**

- Clonotypes group cells that descend from the same lymphocyte, and their expansion reveals which cells responded to an antigen.
- The number of clonotypes depends on the number of sampled cells, so repertoires are better compared by evenness, which varies strongly between donors.
- B cell clonotypes are defined by similar junctions with the same V and J genes, since somatic hypermutation changes the receptors within a clone.

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

## Motivation

When a T or B cell recognizes its antigen, it proliferates into a clone of cells that share the receptor of their ancestor.
Grouping cells into [clonotypes](../glossary.md#term-clonotype) therefore reveals which cells expanded in an immune response, how they differentiated and how diverse a repertoire is.
There is no consensus definition of a clonotype for single-cell data (Mhanna *et al.*, 2024 [1]), and TCRs and BCRs need different definitions, since only BCRs mutate after activation.

```python
import warnings

import anndata as ad
import lamindb as ln
import scirpy as ir

warnings.filterwarnings("ignore", category=ad.ExperimentalFeatureWarning)

ln.connect("theislab/sc-best-practices")

ln.track("vISuAyonHdGO")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
! It looks like you are running jupyter lab but don't have jupyter-server module installed. Please install it via pip install jupyter-server
→ loaded Transform('vISuAyonHdGO0000', key='clonotype.ipynb'), started new Run('JlAriU0dhHFEp8c5') at 2026-09-29 18:09:53 UTC
→ notebook imports: anndata==0.13.2 lamindb-core==2.10.0 scirpy==0.25.1
```

We load the T and B cells that passed [quality control](../air-repertoire/ir-profiling.md).

```python
mdata_tcr = ln.Artifact.get(key="air_repertoire/stephenson2021_tcr_qc.h5mu").load()
mdata_bcr = ln.Artifact.get(key="air_repertoire/stephenson2021_bcr_qc.h5mu").load()
```

## T cell clonotypes

Cells of the same T cell clone have identical receptors, so we group cells whose primary α and β chains have identical CDR3 nucleotide sequences.
Cells without both chains remain unassigned, since an orphan chain cannot be told apart from a different receptor that shares it.
We do not merge cells of different donors, whose identical TCRs arose independently.

```python
ir.pp.ir_dist(mdata_tcr)
ir.tl.define_clonotypes(
    mdata_tcr,
    receptor_arms="all",
    dual_ir="primary_only",
    within_group="gex:patient_id",
)
ir.tl.clonal_expansion(mdata_tcr)
mdata_tcr.pull_obs()
```

`clonal_expansion` labels each cell by the size of its clonotype, which we compare between cell types.

```python
_ = ir.pl.clonal_expansion(mdata_tcr, groupby="gex:cell_type", figsize=(8, 4))
```

About 70% of terminal effector CD8+ T cells (CD8.TE) belong to clonotypes of more than two cells, followed by NKT cells and effector memory and proliferating CD8+ T cells.
Naive T cells are almost never expanded, as expected for cells that have not encountered their antigen.

## Gene usage

V genes are not used uniformly, and their usage is shaped by selection (Elhanati *et al.*, 2014 [2]).
A striking example are mucosal-associated invariant T (MAIT) cells, which recognize a conserved bacterial metabolite with a semi-invariant α chain built from TRAV1-2 (Reantragoon *et al.*, 2013 [3]).
`airr_context` temporarily adds chain fields such as the V gene to `.obs`.

```python
with ir.get.airr_context(mdata_tcr, "v_call"):
    trav1_2 = mdata_tcr.obs["VJ_1_v_call"] == "TRAV1-2"
trav1_2.groupby(mdata_tcr.obs["gex:cell_type_coarse"], observed=True).mean()
```

Output:
```text
gex:cell_type_coarse
CD4             0.004050
CD8             0.025099
Lymph_prolif    0.036866
MAIT            0.691238
Treg            0.007282
gdT             0.018349
Name: VJ_1_v_call, dtype: float64
```

About 70% of MAIT cells use TRAV1-2, compared to a few percent of the other T cells, so the TCR confirms the transcriptomic annotation of these cells.

## Diversity

Clonal expansion reduces the diversity of a repertoire.
The number of clonotypes grows with the number of sampled cells, which differs between donors, so we instead compare how evenly the cells are distributed across clonotypes.
The Shannon entropy normalized by the number of clonotypes measures this evenness and is among the indices that are least affected by subsampling (Mika *et al.*, 2025 [4]).
We compute it for the CD8+ T cells of each donor, which contain most expanded clonotypes.

```python
cd8 = mdata_tcr[mdata_tcr.obs["gex:cell_type_coarse"] == "CD8"]
diversity = ir.tl.alpha_diversity(cd8, groupby="gex:patient_id", inplace=False)
severity = cd8.obs.groupby("gex:patient_id", observed=True)["gex:severity"].first()
diversity.columns = ["evenness"]
diversity.join(severity).groupby("gex:severity", observed=True).agg(
    ["median", "min", "max"]
).loc[["Healthy", "Asymptomatic", "Mild", "Moderate", "Severe", "Critical"]]
```

The evenness is close to 1 for most donors, but a few donors in most groups, including healthy donors, carry strongly expanded clonotypes.
These differences between donors are larger than those between severity groups, so comparing groups requires many donors and has to consider expansions against latent viruses such as cytomegalovirus, which we look at in the [specificity chapter](../air-repertoire/specificity.md).

## B cell clonotypes

BCRs of the same clone differ by somatic hypermutation, so grouping identical sequences would split clonal families (Balashova *et al.*, 2024 [5]).
Instead, BCRs with the same V and J genes and junction length are clustered by the Hamming distance of their junction nucleotides, which identifies clones with high sensitivity and specificity (Gupta *et al.*, 2017 [6]).
We use a normalized Hamming distance of at most 15% of the junction length and require both heavy and light chains to match, since the light chain separates clones that share a similar heavy chain (Jaffe *et al.*, 2022 [7]).

```python
ir.pp.ir_dist(mdata_bcr, metric="normalized_hamming", cutoff=15, sequence="nt")
ir.tl.define_clonotype_clusters(
    mdata_bcr,
    sequence="nt",
    metric="normalized_hamming",
    receptor_arms="all",
    dual_ir="any",
    same_v_gene=True,
    same_j_gene=True,
    within_group="gex:patient_id",
    key_added="clone_id",
)
ir.tl.clonal_expansion(mdata_bcr)
mdata_bcr.pull_obs()
```

```python
_ = ir.pl.clonal_expansion(mdata_bcr, groupby="gex:cell_type", figsize=(8, 4))
```

Plasmablasts and plasma cells are most often clonally expanded, since they arise from B cells that proliferated after encountering their antigen.
Naive and immature B cells are rarely expanded.

## Isotypes and somatic hypermutation

The constant gene of the heavy chain determines the isotype of a B cell.
Somatic hypermutation is measured by comparing the V gene of each BCR with its reconstructed germline, which `mutational_load` does for the whole sequence and each of its regions.

```python
ir.tl.mutational_load(mdata_bcr)
with ir.get.airr_context(mdata_bcr, ["c_call", "v_mutation_freq"]):
    _ = ir.pl.group_abundance(
        mdata_bcr,
        groupby="gex:cell_type",
        target_col="VDJ_1_c_call",
        normalize=True,
        figsize=(8, 4),
    )
    mutation = mdata_bcr.obs.groupby("gex:cell_type", observed=True)[
        "VDJ_1_v_mutation_freq"
    ].median()
mutation
```

Output:
```text
gex:cell_type
B_exhausted              0.032051
B_immature                    0.0
B_naive                       0.0
B_non-switched_memory    0.032051
B_switched_memory        0.059295
Plasma_cell_IgA          0.067308
Plasma_cell_IgG          0.051282
Plasma_cell_IgM          0.003205
Plasmablast              0.044872
Name: VDJ_1_v_mutation_freq, dtype: Float64
```

Naive and immature B cells express IgM and IgD and carry almost no mutations.
Switched memory B cells and IgA and IgG plasma cells have undergone class switching, and around 5% of the nucleotides of their V genes are mutated.

We store the clonotypes for the [specificity analysis](../air-repertoire/specificity.md) and the [integration with gene expression](../air-repertoire/multimodal-integration.md).

```python
ln.Artifact.from_mudata(
    mdata_tcr,
    key="air_repertoire/stephenson2021_tcr_clonotypes.h5mu",
    description="T cells of the Stephenson 2021 Cambridge samples with clonotypes",
).save()
ln.Artifact.from_mudata(
    mdata_bcr,
    key="air_repertoire/stephenson2021_bcr_clonotypes.h5mu",
    description="B cells of the Stephenson 2021 Cambridge samples with clonotypes and mutational load",
).save()
```

Output:
```text
→ returning artifact with same hash: Artifact(uid='Tfd4y2f2suUjTVPw0001', key='air_repertoire/stephenson2021_tcr_clonotypes.h5mu', description='T cells of the Stephenson 2021 Cambridge samples with clonotypes', suffix='.h5mu', kind='dataset', otype='MuData', size=759562317, hash='PmhNx3rxbtdTRTiPFqY0l0', n_files=None, n_observations=54137, extra_data=None, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=180, schema_id=None, created_by_id=2, created_at=2026-09-29 18:07:09 UTC, is_locked=False, version_tag=None, is_latest=True); to track this artifact as an input, use: ln.Artifact.get()
→ creating new artifact version for key 'air_repertoire/stephenson2021_bcr_clonotypes.h5mu' in storage 's3://lamin-eu-central-1/VPwcjx3CDAa2'

... uploading 9u5AeRoRPsXssywH0002.h5mu:  0.0%

... uploading 9u5AeRoRPsXssywH0002.h5mu: 16.0%

... uploading 9u5AeRoRPsXssywH0002.h5mu: 51.9%

... uploading 9u5AeRoRPsXssywH0002.h5mu: 84.0%

... uploading 9u5AeRoRPsXssywH0002.h5mu: 100.0%
• replacing the existing cache path /home/lheumos/.cache/lamindb/lamin-eu-central-1/VPwcjx3CDAa2/air_repertoire/stephenson2021_bcr_clonotypes.h5mu
Artifact(uid='9u5AeRoRPsXssywH0002', key='air_repertoire/stephenson2021_bcr_clonotypes.h5mu', description='B cells of the Stephenson 2021 Cambridge samples with clonotypes and mutational load', suffix='.h5mu', kind='dataset', otype='MuData', size=326684601, hash='HILCJa0SSlNPU7E8S3rQfu', n_files=None, n_observations=13422, extra_data=None, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=183, schema_id=None, created_by_id=2, created_at=2026-09-29 18:10:09 UTC, is_locked=False, version_tag=None, is_latest=True)
```

## Quiz

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q1",
        "Why are BCR clonotypes defined by sequence similarity rather than identity?",
        "Somatic hypermutation changes the receptors of activated B cells, so cells of the same clone carry similar but not identical sequences.",
        back_font_size=15,
    )
    flip_card(
        "q2",
        "Which T cells are most often clonally expanded?",
        "Antigen-experienced effector and effector memory CD8+ T cells, whereas naive T cells are rarely expanded.",
        back_font_size=15,
    )
    flip_card(
        "q3",
        "Why is the number of clonotypes a poor measure for comparing repertoire diversity between samples?",
        "It grows with the number of sampled cells, so evenness measures such as the normalized Shannon entropy are more robust.",
        back_font_size=15,
    )
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Juan Henao

### Reviewers

- Lukas Heumos

## References

1. Mhanna, V., Bashour, H., Lê Quý, K., Barennes, P., Rawat, P., Greiff, V., & Mariotti-Ferrandiz, E. (2024). Adaptive immune receptor repertoire analysis. *Nature Reviews Methods Primers*, *4*(1), 6. https://doi.org/10.1038/s43586-023-00284-1
2. Elhanati, Y., Murugan, A., Callan Jr, C. G., Mora, T., & Walczak, A. M. (2014). Quantifying selection in immune receptor repertoires. *Proceedings of the National Academy of Sciences*, *111*(27), 9875–9880.
3. Reantragoon, R., Corbett, A. J., Sakala, I. G., Gherardin, N. A., Furness, J. B., Chen, Z., Eckle, S. B. G., Uldrich, A. P., Birkinshaw, R. W., Patel, O., Kostenko, L., Meehan, B., Kedzierska, K., Liu, L., Fairlie, D. P., Hansen, T. H., Godfrey, D. I., Rossjohn, J., McCluskey, J., & Kjer-Nielsen, L. (2013). Antigen-loaded MR1 tetramers define T cell receptor heterogeneity in mucosal-associated invariant T cells. *Journal of Experimental Medicine*, *210*(11), 2305–2320. https://doi.org/10.1084/jem.20130958
4. Mika, J., Polanska, A., Blenman, K. R., Pusztai, L., Polanska, J., Candéias, S., & Marczyk, M. (2025). A comprehensive evaluation of diversity measures for TCR repertoire profiling. *BMC Biology*, *23*(1), 133. https://doi.org/10.1186/s12915-025-02236-5
5. Balashova, D., van Schaik, B. D. C., Stratigopoulou, M., Guikema, J. E. J., Caniels, T. G., Claireaux, M., van Gils, M. J., Musters, A., Anang, D. C., de Vries, N., Greiff, V., & van Kampen, A. H. C. (2024). Systematic evaluation of B-cell clonal family inference approaches. *BMC Immunology*, *25*(1), 13. https://doi.org/10.1186/s12865-024-00600-8
6. Gupta, N. T., Adams, K. D., Briggs, A. W., Timberlake, S. C., Vigneault, F., & Kleinstein, S. H. (2017). Hierarchical Clustering Can Identify B Cell Clones with High Confidence in Ig Repertoire Sequencing Data. *The Journal of Immunology*, *198*(6), 2489–2499. https://doi.org/10.4049/jimmunol.1601850
7. Jaffe, D. B., Shahi, P., Adams, B. A., Chrisman, A. M., Finnegan, P. M., Raman, N., Royall, A. E., Tsai, F., Vollbrecht, T., Reyes, D. S., Hepler, N. L., & McDonnell, W. J. (2022). Functional antibodies exhibit light chain coherence. *Nature*, *611*(7935), 352–357. https://doi.org/10.1038/s41586-022-05371-z
