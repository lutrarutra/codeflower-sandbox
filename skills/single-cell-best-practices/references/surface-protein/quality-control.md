# Quality control

Source: https://www.sc-best-practices.org/surface-protein/quality-control  
Authors: Javier Marchena-Hurtado, Daniel Strobl, Ciro Ramírez-Suástegui, Anna Schaar, Lukas Heumos

**🧠 Key takeaways**

- Single-cell surface protein measurements complement RNA-seq data, improving cell type identification and revealing treatment effects not visible at the transcript level. Quality control of the ADT (surface protein) data removes cells with too few or too protein counts.

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

In addition to capturing only transcriptomic data with single cell analyses, we are now able to also capture the abundance of surface protein expression.
The protocol used for this is usually referred to as CITE-seq(Stoeckius *et al.*, 2017 [1]).
This modality requires different preprocessing compared to what we described earlier for gene expression data since the data distributions are different.
In the following, we will guide you through the process of dealing with CITE-seq data.
As CITE-seq data provides you with two different modalities, you can either analyze them separately or jointly.
Here, we will focus on the ADT part of the data and analyze it unimodally. For a joint analysis of ADT and RNA data, we refer to the [multimodal integration chapter](../multimodal-integration/paired-integration.md).

Single-cell RNA-seq data acts as a proxy for protein level with a partial correlation at various transcription states of a cell(Liu *et al.*, 2016 [2]).
Therefore, it is in our interest to measure the protein levels in single-cells if we are to capture a better picture of cellular processes.
Quantifying these aspects of a cell is essential to understand cell differentiation and fate, cell signal transduction pathways, disease progression, perturbations, and clinical diagnostics(Xie & Ding, 2022 [3]).

We can already detect relevant populations with single-cell transcriptomics.
This is a valuable piece of information, but incomplete if we want to better understand the cellular identities and dynamics happening in the biological processes we study.
Having surface protein measurements allows us to close the gap between identity by transcription and identity by protein where there might be a delay in synthesis that could be important in our experiment.
For example, it has been noted that ICOS, an immune checkpoint protein, was increased on the surface of treated cells, regardless of the fact that this protein’s [mRNA](../glossary.md#term-messenger-rna-mrna) does not differ in abundance between the treatment groups(Peterson *et al.*, 2017 [4]).
Another advantage is that surface protein levels help us detect doublets that might not be reflected at the transcript level in our data.
This is possible by looking at the co-occurrence of cell-type-specific markers(Sun *et al.*, 2021 [5]), see [Doublet detection](../surface-protein/doublet-detection.md).

By using antibodies tagged with a nucleotide barcode, it is possible to first bind the antibodies to the cells and later sequence the barcodes together with the RNA.
There are two main protocols: CITE-seq (Cellular Indexing of Transcriptomes and Epitopes by Sequencing) and REAP-seq (RNA expression and protein sequencing assay).
The main difference resides in their antibody-oligo conjugates also known as Antibody-Derived Tags (ADT).
CITE-seq uses streptavidin that is noncovalently bound to biotinylated DNA barcodes. REAP-seq implements covalent bonds between the antibody and a DNA barcode(Peterson *et al.*, 2017 [4]).
Furthermore, there have been advances integrating the CITE-seq protocol in a multimodal assay.
One is DOGMA-seq(Mimitou *et al.*, 2021 [6]), an adaptation of CITE-seq that allows the measurement of chromatin accessibility, gene expression, and protein from the same cell.
This method includes ASAP-seq, which combines scATAC-seq and ADT by adding a bridge oligo specific to the CITE-seq reagents(Mimitou *et al.*, 2021 [6]).
The advantage of ASAP-seq is that it can measure surface and intracellular proteins.
We will refer to the surface protein measurements as ADT data.

![CITE-Seq](https://www.sc-best-practices.org/build/84f0f052d8dc78c9a0c8d1ed3245c9c5.png)

With ADT data, we can identify cell types based on conventional markers usually utilized in flow cytometry experiments.
These markers are especially useful for specific immune cell populations.
The advantage of ADT is that other modalities are measured simultaneously.
However, the way we process ADT data differs from others.
Contrary to the negative binomial distribution of UMI counts, ADT data is less sparse with a negative peak for non-specific antibody binding and a positive peak resembling enrichment of specific cell surface proteins(Zheng *et al.*, 2022 [7]).
Many experiments include only a small number—typically in the tens or hundreds—of antibodies of interest..
Moreover, sequencing resources can be concentrated enabling deeper coverage of ADTs since they are separated from transcripts.
ADT data can also be noisier, as unbound antibodies lead to counts in cells or empty droplets where the protein is not present.

## Environment setup and data

We use a CITE-seq data set generated for a single cell data integration challenge at the NeurIPS conference 2021 (Luecken *et al.*, 2021 [8]).
This dataset captures single-cell RNA and Antibody-Derived Tag (ADT) data from bone marrow mononuclear cells of 12 healthy human donors measured at four different sites to obtain nested batch effects.
In this tutorial, we will use the whole dataset which contains 140 surface proteins.

We will use scanpy and muon(Bredikhin *et al.*, 2022 [9]) to analyze the data.
We first start by importing all packages that are required for running this notebook.

```python
import warnings

import muon as mu
import numpy as np
import pandas as pd
import scanpy as sc
import seaborn as sns
from scipy.stats import median_abs_deviation

warnings.filterwarnings("ignore")
sc.settings.verbosity = 0
sc.set_figure_params(
    dpi=80,
    facecolor="white",
    frameon=False,
)

import lamindb as ln

ln.connect("theislab/sc-best-practices")

ln.track("zDY31sPkaDcP")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ found notebook quality_control.ipynb, making new version -- anticipating changes
→ created Transform('FATGTTa0bL500008', key='quality_control.ipynb'), re-started Run('HPJKfoKHttQ0YNhZ') at 2026-07-29 10:07:52 UTC
→ notebook imports: lamindb-core==2.3.1 muon==0.1.9 numpy==2.4.6 pandas==2.3.3 scanpy==1.12.3 scipy==1.16.3 seaborn==0.13.2
• recommendation: to identify the notebook across renames, pass the uid: ln.track("FATGTTa0bL50")
```

### Loading the CITE-seq data

Next, we now load the CITE-seq dataset from the single cell data integration challenge at the NeurIPS conference 2021 (Luecken *et al.*, 2021 [8]).
This CITE-seq dataset is organized into a MuData object.
A MuData object of a CITE-seq dataset contains two AnnData objects of the two data modalities: an AnnData object of the RNA data and an AnnData object of the ADT (protein) data.

```python
af = ln.Artifact.connect("theislab/sc-best-practices").get(
    key="surface-protein/cite_filtered.h5mu", is_latest=True
)
mdata = af.load()
mdata
```

We have 122,016 droplets.
The RNA data contains 36601 genes (the full transcriptome) and the ADT data contains 140 surface proteins.
Here we use the filtered version of the data, that is, with all barcodes that passed the preprocessing filter with CellRanger.

## Quality Control

As in transcriptomics data quality control and filtering, we need to remove cells that failed to capture ADTs.
Solely reusing the earlier introduced transcriptomics quality control measures is inappropriate due to the above-mentioned fundamentally different count distributions in ADT data.

We recommend to first remove cells that captured few surface proteins.
In practice, this is more robust than filtering based on total ADT counts alone.
When targeted proteins are successfully captured, total ADT counts can increase disproportionately, driven by the near-binary expression patterns of many surface markers (i.e., largely present or absent rather than continuously varying).
As a result, when removing cells that failed to capture ADTs, we recommend removing cells that captured few surface proteins rather than removing cells with low total ADT counts.

Since in CITE-seq we have surface protein and transcriptomic data, in the following we perform quality control and filtering based on both data modalities.

We now apply lenient filtering cutoffs for all samples, and in the next section we apply more stringent per-sample cutoffs.

```python
sc.pp.calculate_qc_metrics(mdata["prot"], inplace=True, percent_top=None)
mdata["rna"].var["mt"] = mdata["rna"].var_names.str.startswith("MT-")
sc.pp.calculate_qc_metrics(
    mdata["rna"], qc_vars=["mt"], inplace=True, percent_top=[20], log1p=True
)
mdata
```

We first look at the distribution of captured ADTs per cell over all samples.
We plot this using the seaborn library.
We first take a look at the whole range and can see that most cells
express between 70 and 140 proteins.

```python
sns.displot(mdata["prot"].obs.n_genes_by_counts)
```

Output:
```text
<seaborn.axisgrid.FacetGrid at 0x7f4fe976ecf0>
```

As the cells falling below a certain threshold of present ADT markers and not following the distribution are probably not viable cells, we want to filter out those cells.
Thus, we look at the lower end of the distribution:

```python
sns.displot(
    mdata["prot"][mdata["prot"].obs.n_genes_by_counts < 70].obs.n_genes_by_counts
)
```

Output:
```text
<seaborn.axisgrid.FacetGrid at 0x7f4f84ab8050>
```

We can see a ‘valley’ in the distribution at around 55 ADTs.
This looks like an appropriate cutoff.

```python
sc.pp.filter_cells(mdata["prot"], min_genes=55)
```

Next, we do the same thing based on total counts per cell.

```python
sns.displot(mdata["prot"].obs.total_counts)
```

Output:
```text
<seaborn.axisgrid.FacetGrid at 0x7f4f84b50550>
```

Looking at the total range, we can’t see any apparent ranges of the distribution of counts.
We zoom in to see the upper end of the distribution for the total counts to decide on a cutoff for the maximum number of counts as droplets exceeding a certain threshold probably either contain multiple cells, so-called doublets, or are the result of an artificial aggregate of antibodies.

```python
sns.displot(
    mdata["prot"].obs.query("total_counts>20000 and total_counts<100000").total_counts
)
```

Output:
```text
<seaborn.axisgrid.FacetGrid at 0x7f4f848e7d90>
```

We remove cells with more than 100000 total protein counts, since from the last two plots we can say there are very few such cells and they are definitely either doublets or the result of an artificial aggregate of antibodies.

```python
sc.pp.filter_cells(mdata["prot"], max_counts=100000)
```

We now perform a similar analysis and cutoff for the transcriptomics data. For more information, see the quality control chapter for scRNA-seq data [Quality Control](../preprocessing-visualization/quality-control.md).

```python
sns.displot(
    mdata["rna"].obs.query("total_counts>20000 and total_counts<100000").total_counts
)
```

Output:
```text
<seaborn.axisgrid.FacetGrid at 0x7f4fe3fdcb90>
```

```python
sc.pp.filter_cells(mdata["rna"], max_counts=100000)
```

We finally filter based on the percentage of mitochondrial counts.

```python
sns.displot(mdata["rna"].obs.pct_counts_mt)
```

Output:
```text
<seaborn.axisgrid.FacetGrid at 0x7f4fe947d310>
```

We filter out cells with a percentage of mitochondrial counts higher than 40%.

```python
mu.pp.filter_obs(mdata["rna"], "pct_counts_mt", lambda x: x < 40)
```

```python
mdata.update()
mu.pp.filter_obs(mdata, mdata["prot"].obs_names)
mu.pp.filter_obs(mdata, mdata["rna"].obs_names)
mdata
```

### Sample-wise QC

Now we search for a more stringent, sample-wise cutoff of low quality cells.
We look at the distribution of counts per cell across the samples to see if there are differences.
As the total amount of reads and droplets can differ between the samples, a stringent, hard cutoff applied to all samples would not be appropriate.

```python
sns.boxplot(y=mdata["prot"].obs.total_counts, x=mdata["prot"].obs["donor"])
```

Output:
```text
<Axes: xlabel='donor', ylabel='total_counts'>
```

The distributions of counts are different between samples.
Thus, sample-wise QC is deemed pertinent.
If we compare sample s3d7 versus sample s4d8, we can see that the outliers of one sample would fit the regular distribution of normal counts in the other sample.

Since we have a significant number of samples, we can do sample-wise QC automatically as described in the RNA preprocessing chapte [Quality Control](../preprocessing-visualization/quality-control.md).

```python
def is_outlier(adata, metric: str, nmads: int):
    M = adata.obs[metric]
    outlier = (M < np.median(M) - nmads * median_abs_deviation(M)) | (
        np.median(M) + nmads * median_abs_deviation(M) < M
    )
    return outlier
```

```python
prot_outliers = []
rna_outliers = []

for sample in np.unique(mdata["prot"].obs["donor"]):
    # --- protein modality ---
    prot_temp = mdata["prot"][mdata["prot"].obs["donor"] == sample].copy()
    prot_temp.obs["outlier"] = is_outlier(
        prot_temp, "log1p_total_counts", 5
    ) | is_outlier(prot_temp, "log1p_n_genes_by_counts", 5)
    prot_outliers.append(prot_temp.obs["outlier"])
    print(
        f"{sample} (prot): outliers {prot_temp.obs.outlier.value_counts().get(True, 0)}"
    )

    # --- rna modality ---
    rna_temp = mdata["rna"][mdata["rna"].obs["donor"] == sample].copy()
    rna_temp.obs["outlier"] = (
        is_outlier(rna_temp, "pct_counts_mt", 7)
        | is_outlier(rna_temp, "log1p_total_counts", 5)
        | is_outlier(rna_temp, "log1p_n_genes_by_counts", 5)
    )
    rna_outliers.append(rna_temp.obs["outlier"])
    print(
        f"{sample} (rna): outliers {rna_temp.obs.outlier.value_counts().get(True, 0)}"
    )
```

Output:
```text
s1d1 (prot): outliers 163
s1d1 (rna): outliers 483
s1d2 (prot): outliers 142
s1d2 (rna): outliers 1102
s1d3 (prot): outliers 200
s1d3 (rna): outliers 933
s2d1 (prot): outliers 168
s2d1 (rna): outliers 435
s2d4 (prot): outliers 108
s2d4 (rna): outliers 424
s2d5 (prot): outliers 27
s2d5 (rna): outliers 639
s3d1 (prot): outliers 324
s3d1 (rna): outliers 963
s3d6 (prot): outliers 437
s3d6 (rna): outliers 490
s3d7 (prot): outliers 297
s3d7 (rna): outliers 753
s4d1 (prot): outliers 224
s4d1 (rna): outliers 789
s4d8 (prot): outliers 168
s4d8 (rna): outliers 558
s4d9 (prot): outliers 466
s4d9 (rna): outliers 1166
```

Now we actually filter out the outliers:

```python
mdata["prot"].obs["outliers"] = pd.concat(prot_outliers)
mdata["rna"].obs["outliers"] = pd.concat(rna_outliers)
mdata.update()

# Combined outliers: a cell is dropped if it's an outlier in EITHER modality
combined_outliers = mdata["prot"].obs["outliers"].reindex(mdata.obs_names).fillna(
    False
) | mdata["rna"].obs["outliers"].reindex(mdata.obs_names).fillna(False)

mdata = mdata[~combined_outliers].copy()
mdata
```

We removed around 15000 cells during the filtering which is roughly 12% of cells.

```python
sns.boxplot(y=mdata["prot"].obs.total_counts, x=mdata["prot"].obs["donor"])
```

Output:
```text
<Axes: xlabel='donor', ylabel='total_counts'>
```

As we can see in the above plot, outliers are now filtered out for each sample separately.
To now bring the values for each sample into a similar range, we need to normalize the data.

```python
af_quality_control = ln.Artifact.from_mudata(
    mdata,
    key="surface-protein/cite_quality_control.h5mu",
    description="CITE-seq filtered data after quality control",
)
af_quality_control.save()
```

Output:
```text
→ returning artifact with same hash: Artifact(uid='t7ppYU464BQN5AHa0005', key='surface-protein/cite_quality_control.h5mu', description='CITE-seq filtered data after quality control', suffix='.h5mu', kind='dataset', otype='MuData', size=1407368865, hash='WYSCTqkvwmcSW5ILZm4DtZ', n_files=None, n_observations=106515, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=105, schema_id=None, created_by_id=7, created_at=2026-07-29 09:58:15 UTC, is_locked=False, version_tag=None, is_latest=True); to track this artifact as an input, use: ln.Artifact.get()
Artifact(uid='t7ppYU464BQN5AHa0005', key='surface-protein/cite_quality_control.h5mu', description='CITE-seq filtered data after quality control', suffix='.h5mu', kind='dataset', otype='MuData', size=1407368865, hash='WYSCTqkvwmcSW5ILZm4DtZ', n_files=None, n_observations=106515, branch_id=1, created_on_id=1, space_id=1, storage_id=1, run_id=105, schema_id=None, created_by_id=7, created_at=2026-07-29 09:58:15 UTC, is_locked=False, version_tag=None, is_latest=True)
```

```python
ln.finish()
```

Output:
```text
• please hit CTRL + s to save the notebook in your editor .... still waiting .....
 ✓
! returning transform  with same hash & key: Transform(uid='FATGTTa0bL500007', key='quality_control.ipynb', description='Quality control', kind='notebook', hash='r7-F3eKT_IgL2ZuHD9ERAg', reference=None, reference_type=None, environment=None, plan=None, branch_id=1, created_on_id=1, space_id=1, created_by_id=7, created_at=2026-07-29 09:56:33 UTC, is_locked=False, version_tag=None, is_latest=False)
• new latest Transform version is: FATGTTa0bL500007
→ finished Run('HPJKfoKHttQ0YNhZ') after 56s at 2026-07-29 10:08:49 UTC
→ go to: https://lamin.ai/theislab/sc-best-practices/transform/FATGTTa0bL500007
→ to update your notebook from the CLI, run: lamin save /groups/nils/members/javier/single-cell-best-practices/jupyter-book/surface_protein/quality_control.ipynb
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Javier Marchena-Hurtado
- Daniel Strobl
- Ciro Ramírez-Suástegui
- Anna Schaar

### Reviewers

- Lukas Heumos

## References

1. Stoeckius, M., Hafemeister, C., Stephenson, W., Houck-Loomis, B., Chattopadhyay, P. K., Swerdlow, H., Satija, R., & Smibert, P. (2017). Simultaneous epitope and transcriptome measurement in single cells. *Nature Methods*, *14*(9), 865–868. https://doi.org/10.1038/nmeth.4380
2. Liu, Y., Beyer, A., & Aebersold, R. (2016). On the Dependency of Cellular Protein Levels on mRNA Abundance. *Cell*, *165*(3), 535–550. https://doi.org/10.1016/j.cell.2016.03.014
3. Xie, H., & Ding, X. (2022). The Intriguing Landscape of Single-Cell Protein Analysis. *Advanced Science*, *n/a*(n/a), 2105932. https://doi.org/10.1002/advs.202105932
4. Peterson, V. M., Zhang, K. X., Kumar, N., Wong, J., Li, L., Wilson, D. C., Moore, R., McClanahan, T. K., Sadekova, S., & Klappenbach, J. A. (2017). Multiplexed quantification of proteins and transcripts in single cells. *Nature Biotechnology*, *35*(1010), 936–939. https://doi.org/10.1038/nbt.3973
5. Sun, B., Bugarin-Estrada, E., Overend, L. E., Walker, C. E., Tucci, F. A., & Bashford-Rogers, R. J. M. (2021). Double-jeopardy: scRNA-seq doublet/multiplet detection using multi-omic profiling. *Cell Reports Methods*, *1*(1), 100008. https://doi.org/10.1016/j.crmeth.2021.100008
6. Mimitou, E. P., Lareau, C. A., Chen, K. Y., Zorzetto-Fernandes, A. L., Hao, Y., Takeshima, Y., Luo, W., Huang, T.-S., Yeung, B. Z., Papalexi, E., Thakore, P. I., Kibayashi, T., Wing, J. B., Hata, M., Satija, R., Nazor, K. L., Sakaguchi, S., Ludwig, L. S., Sankaran, V. G., … Smibert, P. (2021). Scalable, multimodal profiling of chromatin accessibility, gene expression and protein levels in single cells. *Nature Biotechnology*, *39*(1010), 1246–1258. https://doi.org/10.1038/s41587-021-00927-2
7. Zheng, Y., Jun, S.-H., Tian, Y., Florian, M., & Gottardo, R. (2022). Robust Normalization and Integration of Single-cell Protein Expression across CITE-seq Datasets. *bioRxiv*. https://doi.org/10.1101/2022.04.29.489989
8. Luecken, M. D., Burkhardt, D. B., Cannoodt, R., Lance, C., Agrawal, A., Aliee, H., Chen, A. T., Deconinck, L., Detweiler, A. M., Granados, A. A., Huynh, S., Isacco, L., Kim, Y. J., Klein, D., KUMAR, B. D., Kuppasani, S., Lickert, H., McGeever, A., Mekonen, H., … Bloom, J. M. (2021). A sandbox for prediction and integration of DNA, RNA, and proteins in single cells. *Thirty-Fifth Conference on Neural Information Processing Systems Datasets and Benchmarks Track (Round 2)*. https://openreview.net/forum?id=gN35BGa1Rt
9. Bredikhin, D., Kats, I., & Stegle, O. (2022). MUON: multimodal omics analysis framework. *Genome Biology*, *23*(1). https://doi.org/10.1186/s13059-021-02577-8
