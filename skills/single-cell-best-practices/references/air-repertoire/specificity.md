# Specificity analysis

Source: https://www.sc-best-practices.org/air-repertoire/specificity  
Authors: Felix Drost, Lukas Heumos

**🧠 Key takeaways**

- Specificity is determined mainly by the CDR3 sequences and V genes, and can be inferred from databases, sequence similarity or machine learning models.
- TCRdist finds more database matches than exact matching, but the sequence definitions and gene names of both sides have to agree.
- Many database matches are coincidental, which the paired gene expression reveals, and predictions for unseen epitopes are close to random.

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

The antigen specificity of a receptor is determined mainly by its CDR3 sequences and additionally by its V genes, which encode CDR1 and CDR2 (Dash *et al.*, 2017 [1]; Springer *et al.*, 2021 [2]).
Specificity can be measured with barcoded peptide-MHC multimers or antigens, but most datasets lack such measurements.
It can instead be inferred by matching receptors to databases of receptors with known specificity, by grouping receptors with similar sequences, or with machine learning models.

```python
import warnings

import anndata as ad
import lamindb as ln
import pandas as pd
import scirpy as ir

warnings.filterwarnings("ignore", category=ad.ExperimentalFeatureWarning)

ln.connect("theislab/sc-best-practices")

ln.track("as8W2VK7byRf")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
! It looks like you are running jupyter lab but don't have jupyter-server module installed. Please install it via pip install jupyter-server
→ loaded Transform('as8W2VK7byRf0000', key='specificity.ipynb'), started new Run('a5Azn9RySEgETINU') at 2026-09-29 18:11:18 UTC
```

We load the T and B cells with the clonotypes from the [previous chapter](../air-repertoire/clonotype.md).

```python
mdata_tcr = ln.Artifact.get(
    key="air_repertoire/stephenson2021_tcr_clonotypes.h5mu"
).load()
mdata_bcr = ln.Artifact.get(
    key="air_repertoire/stephenson2021_bcr_clonotypes.h5mu"
).load()
```

## Querying VDJdb

VDJdb collects TCRs with experimentally determined epitopes (Shugay *et al.*, 2018 [3]; Bagaev *et al.*, 2020 [4]).
We use the human TCRs of a pinned release, which scirpy obtains from IggyTop with all CDR3 sequences harmonized to junctions, and first search for cells whose α and β chains are identical to an entry.

```python
vdjdb = ln.Artifact.get(key="air_repertoire/vdjdb_human.h5ad").load()
vdjdb
```

Output:
```text
AnnData object with n_obs × n_vars = 175339 × 0
    obs: 'MHC_class', 'MHC_gene_1', 'MHC_gene_2', 'PMID', 'antigen_name', 'antigen_species', 'assay_category', 'assay_method_raw', 'epitope_sequence', 'iedb_iri', 'source_organism', 'tissue', 'source'
    uns: 'DB', 'chain_indices', 'iggytop_metadata'
    obsm: 'airr', 'chain_indices'
```

```python
ir.pp.ir_dist(mdata_tcr, vdjdb, metric="identity", sequence="aa")
ir.tl.ir_query(
    mdata_tcr,
    vdjdb,
    metric="identity",
    sequence="aa",
    receptor_arms="all",
    dual_ir="any",
)
exact = ir.tl.ir_query_annotate(
    mdata_tcr,
    vdjdb,
    metric="identity",
    sequence="aa",
    include_ref_cols=["antigen_species"],
    inplace=False,
)
```

Output:
```text
  0%|          | 0/411 [00:00<?, ?it/s]
```

```python
exact["antigen_species"].value_counts().head(8)
```

Output:
```text
antigen_species
ambiguous                                          142
Epstein-Barr virus                                  67
Cytomegalovirus                                     53
Influenza A virus                                   47
Homo sapiens                                        26
M.tuberculosis                                      22
Severe acute respiratory syndrome coronavirus 2     18
Yellow fever virus                                  12
Name: count, dtype: int64
```

Few cells share both chains with an entry, since even TCRs against the same epitope rarely have identical sequences.
Cells that match entries of different antigens are labeled as ambiguous.

TCRdist compares CDR3 sequences with an amino acid substitution matrix and gap penalties, and TCRs within a small distance likely recognize the same epitope (Dash *et al.*, 2017 [1]).
It grouped TCRs by epitope at least as well as other clustering methods and protein language models in independent comparisons (Hudson *et al.*, 2024 [5]; Nagano *et al.*, 2025 [6]).
We accept matches within a TCRdist of 15 in both chains and require the same V genes.

```python
ir.pp.ir_dist(mdata_tcr, vdjdb, metric="tcrdist", sequence="aa", cutoff=15)
ir.tl.ir_query(
    mdata_tcr,
    vdjdb,
    metric="tcrdist",
    sequence="aa",
    receptor_arms="all",
    dual_ir="any",
    same_v_gene=True,
)
ir.tl.ir_query_annotate(
    mdata_tcr,
    vdjdb,
    metric="tcrdist",
    sequence="aa",
    include_ref_cols=["antigen_species", "epitope_sequence", "MHC_class"],
)
mdata_tcr.pull_obs()
```

Output:
```text
  0%|          | 0/4575 [00:00<?, ?it/s]
```

```python
mdata_tcr.obs["airr:antigen_species"].value_counts().head(8)
```

Output:
```text
airr:antigen_species
ambiguous                                          495
Cytomegalovirus                                    312
Epstein-Barr virus                                 196
Influenza A virus                                  152
Homo sapiens                                        87
Severe acute respiratory syndrome coronavirus 2     72
M.tuberculosis                                      53
Human immunodeficiency virus 1                      39
Name: count, dtype: int64[pyarrow]
```

TCRdist annotates almost four times as many cells as exact matching.
Most matches are to cytomegalovirus, Epstein-Barr virus and influenza A virus, against which most adults carry memory T cells, and about a third of the matched cells match entries of several antigens.

## How reliable are the matches?

A match only indicates that a similar TCR bound an epitope in another person, and the paired gene expression lets us test whether the matches are plausible.
Epitopes presented by MHC class I are recognized by CD8+ T cells and those presented by MHC class II by CD4+ T cells.

```python
pd.crosstab(mdata_tcr.obs["airr:MHC_class"], mdata_tcr.obs["gex:cell_type_coarse"])
```

Of the cells matched to MHC class I epitopes, 728 are CD4+ T cells, which cannot recognize them, and 437 are CD8+ T cells.
Since CD4+ T cells outnumber CD8+ T cells about 2.5 to 1, the matches are barely enriched in CD8+ T cells, so many of them must be coincidental.

```python
sars_cov_2 = "Severe acute respiratory syndrome coronavirus 2"
donors = (
    mdata_tcr.obs.assign(
        sars_cov_2=lambda obs: obs["airr:antigen_species"].eq(sars_cov_2).fillna(False),
        cytomegalovirus=lambda obs: (
            obs["airr:antigen_species"].eq("Cytomegalovirus").fillna(False)
        ),
    )
    .groupby(["gex:severity", "gex:patient_id"], observed=True)[
        ["sars_cov_2", "cytomegalovirus"]
    ]
    .mean()
)
donors.groupby("gex:severity", observed=True).median()
```

If the matches reflected specificity, T cells matching SARS-CoV-2 epitopes should be more frequent in patients than in healthy donors.
Instead, they make up about 0.1% of the T cells of each donor in every group, whereas cytomegalovirus matches are more frequent in all groups.

```python
expansion = pd.crosstab(
    mdata_tcr.obs["airr:antigen_species"],
    mdata_tcr.obs["airr:clonal_expansion"],
    normalize="index",
).loc[["Cytomegalovirus", "Epstein-Barr virus", "Influenza A virus", sars_cov_2]]
expansion.loc["all T cells"] = mdata_tcr.obs["airr:clonal_expansion"].value_counts(
    normalize=True
)
expansion
```

Cells matching cytomegalovirus or influenza A virus epitopes are twice as often part of clonotypes with more than two cells as T cells overall, consistent with the memory T cells that these viruses induce.
Cells matching SARS-CoV-2 epitopes are not expanded, so database matches alone cannot identify the T cells that respond to the infection.

## Predicting specificity

Machine learning models predict whether a TCR binds a given epitope.
In community benchmarks, they performed reasonably for epitopes with many known TCRs but close to random for epitopes that were absent from their training data (Meysman *et al.*, 2023 [7]; Nielsen *et al.*, 2024 [8]).
Independent evaluations of 21 published predictors and of 50 models confirmed that none generalizes to such unseen epitopes (Drost *et al.*, 2025 [9]; Lu *et al.*, 2026 [10]).
Their predictions for epitopes outside the training data should therefore be treated as hypotheses that require experimental validation.

## BCR specificity

BCRs bind diverse antigens without MHC restriction, and far fewer BCRs with known specificity are available than TCRs.
CoV-AbDab collects published antibodies against coronaviruses (Raybould *et al.*, 2021 [11]).
It reports CDR3 sequences without the conserved flanking residues, so we compare them to the `cdr3_aa` field of our BCRs rather than to their junctions, and search for heavy chains with the same CDR3 and V gene.

```python
cov_abdab = ln.Artifact.get(key="air_repertoire/cov_abdab_080224.csv").load()
cov_abdab["v_call"] = cov_abdab["Heavy V Gene"].str.split(" ").str[0]
heavy = ir.get.airr(mdata_bcr, ["cdr3_aa", "v_call"], "VDJ_1")
heavy["VDJ_1_v_call"] = heavy["VDJ_1_v_call"].str.split("*").str[0]
heavy.reset_index().merge(
    cov_abdab, left_on=["VDJ_1_cdr3_aa", "VDJ_1_v_call"], right_on=["CDRH3", "v_call"]
)[["cell_id", "VDJ_1_cdr3_aa", "VDJ_1_v_call", "Name", "Binds to"]]
```

A single IgG plasma cell of a patient with mild COVID-19 carries the heavy chain CDR3 and V gene of REGN10957, an antibody against SARS-CoV-2, but its light chain differs.
Somatic hypermutation and the diversity of BCRs make such matches rare, so the specificity of B cells is better measured experimentally, for example by sequencing them together with barcoded antigens (Setliff *et al.*, 2019 [12]).

We store the annotated T cells for the [integration with gene expression](../air-repertoire/multimodal-integration.md).

```python
ln.Artifact.from_mudata(
    mdata_tcr,
    key="air_repertoire/stephenson2021_tcr_specificity.h5mu",
    description="T cells of the Stephenson 2021 Cambridge samples with VDJdb matches",
).save()
```

Output:
```text
→ returning artifact with same hash: Artifact(uid='3I589652WSqI0YEs0000', key='air_repertoire/stephenson2021_tcr_specificity.h5mu', description='T cells of the Stephenson 2021 Cambridge samples with VDJdb matches', suffix='.h5mu', kind='dataset', otype='MuData', size=814847697, hash='MdD7EGk9EbChbko_zXTqE3', n_files=None, n_observations=54137, extra_data=None, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=182, schema_id=None, created_by_id=2, created_at=2026-09-29 18:09:12 UTC, is_locked=False, version_tag=None, is_latest=True); to track this artifact as an input, use: ln.Artifact.get()
Artifact(uid='3I589652WSqI0YEs0000', key='air_repertoire/stephenson2021_tcr_specificity.h5mu', description='T cells of the Stephenson 2021 Cambridge samples with VDJdb matches', suffix='.h5mu', kind='dataset', otype='MuData', size=814847697, hash='MdD7EGk9EbChbko_zXTqE3', n_files=None, n_observations=54137, extra_data=None, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=182, schema_id=None, created_by_id=2, created_at=2026-09-29 18:09:12 UTC, is_locked=False, version_tag=None, is_latest=True)
```

## Quiz

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q1",
        "Why does a match to a database entry not prove the specificity of a T cell?",
        "Different TCRs can match by chance, databases contain noisy entries, and the epitope must also be presented by an MHC molecule that the donor carries.",
        back_font_size=15,
    )
    flip_card(
        "q2",
        "How can gene expression help to check database matches?",
        "Cells matching MHC class I epitopes should be CD8+ T cells and cells matching class II epitopes CD4+ T cells, and T cells against an ongoing infection should be expanded effector cells.",
        back_font_size=15,
    )
    flip_card(
        "q3",
        "Why is it important to know whether a database reports junctions or CDR3 sequences?",
        "Junctions include the conserved flanking residues and CDR3 sequences do not, so sequences only match if both sides use the same definition.",
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

1. Dash, P., Fiore-Gartland, A. J., Hertz, T., Wang, G. C., Sharma, S., Souquette, A., Crawford, J. C., Clemens, E. B., Nguyen, T. H., Kedzierska, K., & others. (2017). Quantifiable predictive features define epitope-specific T cell receptor repertoires. *Nature*, *547*(7661), 89–93.
2. Springer, I., Tickotsky, N., & Louzoun, Y. (2021). Contribution of t cell receptor alpha and beta cdr3, mhc typing, v and j genes to peptide binding prediction. *Frontiers in Immunology*, *12*.
3. Shugay, M., Bagaev, D. V., Zvyagin, I. V., Vroomans, R. M., Crawford, J. C., Dolton, G., Komech, E. A., Sycheva, A. L., Koneva, A. E., Egorov, E. S., & others. (2018). VDJdb: a curated database of T-cell receptor sequences with known antigen specificity. *Nucleic Acids Research*, *46*(D1), D419–D427.
4. Bagaev, D. V., Vroomans, R. M. A., Samir, J., Stervbo, U., Rius, C., Dolton, G., Greenshields-Watson, A., Attaf, M., Egorov, E. S., Zvyagin, I. V., Babel, N., Cole, D. K., Godkin, A. J., Sewell, A. K., Kesmir, C., Chudakov, D. M., Luciani, F., & Shugay, M. (2020). VDJdb in 2019: database extension, new analysis infrastructure and a T-cell receptor motif compendium. *Nucleic Acids Research*, *48*(D1), D1057–D1062. https://doi.org/10.1093/nar/gkz874
5. Hudson, D., Lubbock, A., Basham, M., & Koohy, H. (2024). A comparison of clustering models for inference of T cell receptor antigen specificity. *ImmunoInformatics*, *13*, 100033. https://doi.org/10.1016/j.immuno.2024.100033
6. Nagano, Y., Pyo, A. G. T., Milighetti, M., Henderson, J., Shawe-Taylor, J., Chain, B., & Tiffeau-Mayer, A. (2025). Contrastive learning of T cell receptor representations. *Cell Systems*, *16*(1), 101165. https://doi.org/10.1016/j.cels.2024.12.006
7. Meysman, P., Barton, J., Bravi, B., Cohen-Lavi, L., Karnaukhov, V., Lilleskov, E., Montemurro, A., Nielsen, M., Mora, T., Pereira, P., Postovskaya, A., Martínez, M. R., Fernandez-de Cossio-Diaz, J., Vujkovic, A., Walczak, A. M., Weber, A., Yin, R., Eugster, A., & Sharma, V. (2023). Benchmarking solutions to the T-cell receptor epitope prediction problem: IMMREP22 workshop report. *ImmunoInformatics*, *9*, 100024. https://doi.org/10.1016/j.immuno.2023.100024
8. Nielsen, M., Eugster, A., Jensen, M. F., Goel, M., Tiffeau-Mayer, A., Pelissier, A., Valkiers, S., Martínez, M. R., Meynard-Piganeeau, B., Greiff, V., Mora, T., Walczak, A. M., Croce, G., Moreno, D. L., Gfeller, D., Meysman, P., & Barton, J. (2024). Lessons learned from the IMMREP23 TCR-epitope prediction challenge. *ImmunoInformatics*, *16*, 100045. https://doi.org/10.1016/j.immuno.2024.100045
9. Drost, F., Chernysheva, A., Albahah, M., Kocher, K., Schober, K., & Schubert, B. (2025). Benchmarking of T cell receptor-epitope predictors with ePytope-TCR. *Cell Genomics*, *5*(8), 100946. https://doi.org/10.1016/j.xgen.2025.100946
10. Lu, Y., Wang, Y., Xu, M., Xie, B., Yang, Y., Xu, H., & Suo, S. (2026). Assessment of computational methods in predicting TCR–epitope binding recognition. *Nature Methods*, *23*(1), 248–259. https://doi.org/10.1038/s41592-025-02910-0
11. Raybould, M. I. J., Kovaltsuk, A., Marks, C., & Deane, C. M. (2021). CoV-AbDab: the Coronavirus Antibody Database. *Bioinformatics*, *37*(5), 734–735. https://doi.org/10.1093/bioinformatics/btaa739
12. Setliff, I., Shiakolas, A. R., Pilewski, K. A., Murji, A. A., Mapengo, R. E., Janowska, K., Richardson, S., Oosthuysen, C., Raju, N., Ronsard, L., Kanekiyo, M., Qin, J. S., Kramer, K. J., Greenplate, A. R., McDonnell, W. J., Graham, B. S., Connors, M., Lingwood, D., Acharya, P., … Georgiev, I. S. (2019). High-Throughput Mapping of B Cell Receptor Sequences to Antigen Specificity. *Cell*, *179*(7), 1636-1646.e15. https://doi.org/10.1016/j.cell.2019.11.003
