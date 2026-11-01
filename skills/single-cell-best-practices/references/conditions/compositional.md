# Compositional analysis

Source: https://www.sc-best-practices.org/conditions/compositional  
Authors: Johannes Ostner, Emma Dann, Lukas Heumos, Anastasia Litinetskaya

**🧠 Key takeaways**

- Single-cell cell type proportions are compositional: increasing one cell type necessarily changes the relative abundances of the others.
Ignoring this constraint can lead to spurious differential abundance signals.
- If the primary interest lies in compositional changes among known cell-types or states, use scCODA or tascCODA to statistically evaluate changes in abundance.
- KNN based methods like DA-Seq or MILO should be used if the data does not cluster distinctly, such as during developmental processes, if we are interested in differences in cell abundances that might appear in transitional states between cell types or in a specific subset of cells of a given cell type.
- scCODA and tascCODA uses a reference cell type and estimates changes relative to that population.
The reference cell type should remain stable across conditions.
- A good experimental design simplifies downstream analysis.
Use sufficient biological replicates and distribute samples from each condition across batches.

**⚙️ Environment setup**

**yml:**

```yaml
name: compositional
channels:
  - conda-forge
dependencies:
  - conda-forge::python=3.14.6
  - conda-forge::scvi-tools=1.5.0.post1
  - conda-forge::schist=0.9.4
  - conda-forge::graph-tool=2.98
  - bioconda::pydeseq2=0.5.4
  - pip
  - pip:
      - lamindb==2.8.0
      - "pertpy[tcoda]==1.1.1"
```

**🗄️ Get data and notebooks**: see "Data and notebooks" in SKILL.md.

## Motivation

Beyond changes in gene expression patterns, [cell](../glossary.md#term-cell) compositions, such as the proportions of [cell types](../glossary.md#term-cell-type), can change between conditions.
A specific drug may, for example, induce a transdifferentiation of a cell type which will be reflected in the cell identity composition.
Sufficient cell and sample numbers are required to accurately determine cell-identity [cluster](../glossary.md#term-cluster) proportions and background variation.
Compositional analysis can be done on the level of cell identity clusters in the form of known cell types or [cell states](../glossary.md#term-cell-state) corresponding to, for example, cells recently affected by perturbations.

![Compositional analysis overview](https://www.sc-best-practices.org/build/compositional-84262bd18fb2dc0785783fa7819c5e42.jpg)

*Figure 1: Differential abundance analysis compares the composition of cell types between two conditions.
The samples from both modalities contain different proportions of cell types, which can be tested for significant shifts in abundance.*

This chapter will introduce both approaches and apply them to the Haber dataset (Haber *et al.*, 2017 [1]).
This dataset contains 53,193 individual epithelial cells from the small intestine and organoids of mice.
Some of the cells were also subject to bacterial or helminth infection such as through Salmonella and Heligmosomoides polygyrus respectively.
Throughout this tutorial we are using a subset of the complete Haber dataset which only includes control and infected cells that were collected specifically for this purpose.
Notably, we are excluding an additional dataset which collected only large cells for faster computation and reduced complexity.

As a first step, we load the dataset.

## Data loading

```python
import logging
import warnings

logging.getLogger("matplotlib").setLevel(logging.WARNING)
warnings.filterwarnings("ignore")
warnings.simplefilter("ignore")
```

```python
import lamindb as ln
import matplotlib
import matplotlib.pyplot as plt
import mudata as md
import numpy as np
import pandas as pd
import pertpy as pt
import scanpy as sc
import schist
import scvi
import seaborn as sns

%matplotlib inline

ln.connect("theislab/sc-best-practices")

ln.track("MPGJnDetqKH7")
```

Output:
```text
→ connected lamindb: theislab/sc-best-practices
→ loaded Transform('MPGJnDetqKH70000', key='compositional.ipynb'), re-started Run('ezoVvtnpWgR6O0lK') at 2026-07-14 07:17:19 UTC
• tip: to identify the notebook across renames, pass the uid: ln.track("MPGJnDetqKH7")
```

```python
adata = ln.Artifact.get(
    key="conditions/compositional_haber.h5ad",
).load()
adata
```

Output:
```text
AnnData object with n_obs × n_vars = 9842 × 15215
    obs: 'batch', 'barcode', 'condition', 'cell_label'
```

```python
adata.obs
```

The data was collected in 10 batches.
The four unique conditions are Control, Salmonella, Hpoly.Day3 and Hpoly.Day10 which correspond to the healthy control state, Salmonella infection, Heligmosomoides polygyrus infected cells after 3 days and Heligmosomoides polygyrus infected cells after 10 days.
The `cell_label` corresponds to the cell types.

## Why cell-type count data is compositional

When analyzing the compositional shifts in cell count data, multiple technical and methodological limitations need to be accounted for.
One challenge is the characteristically low number of experimental replicates, which leads to large confidence intervals when conducting [differential abundance analysis](../glossary.md#term-differential-abundance-analysis) with frequentist statistical tests.
Even more important, single-cell [sequencing](../glossary.md#term-sequencing) is naturally limited in the number of cells per sample - we can’t sequence every cell in a tissue or organ, but use a small, representative snapshot instead.
This, however, forces us to view the cell type counts as purely proportional, i.e. the total number of cells in a sample is only a scaling factor.
In the statistical literature, such data is known as compositional data (Aitchison, 1982 [2]), and characterized by the relative abundances of all features (cell types in our case) in one sample always adding up to one.

Because of this sum-to-one constraint, a negative correlation between the cell type abundances is induced.
To illustrate this, let’s consider the following example:

In a case-control study, we want to compare the cell type composition of a healthy and a diseased organ. In both cases, we have three cell types (A, B and C), but their abundances differ:

- The healthy organ consists of 2,000 cells of each type (6,000 cells total).
- The disease leads to a doubling of cell type A, while cell types B and C are not affected, so that the diseased organ has 8,000 cells.

```python
healthy_tissue = [2000, 2000, 2000]
diseased_tissue = [4000, 2000, 2000]
example_data_global = pd.DataFrame(
    data=np.array([healthy_tissue, diseased_tissue]),
    index=[1, 2],
    columns=["A", "B", "C"],
)
example_data_global["Disease status"] = ["Healthy", "Diseased"]
example_data_global
```

```python
plot_data_global = example_data_global.melt(
    "Disease status", ["A", "B", "C"], "Cell type", "count"
)

fig, ax = plt.subplots(1, 2, figsize=(12, 6))
sns.barplot(
    data=plot_data_global, x="Disease status", y="count", hue="Cell type", ax=ax[0]
)
ax[0].set_title("Global abundances, by status")

sns.barplot(
    data=plot_data_global, x="Cell type", y="count", hue="Disease status", ax=ax[1]
)
ax[1].set_title("Global abundances, by cell type")

plt.show()
```

We want to find out which cell types increase or decrease in abundance in the diseased organ.
If we are able to determine the type of every cell in both organs, the case would be clear, as we can see in the right plot above.
Unfortunately, this is not possible.
Since our sequencing process has a limited capacity, we can only take a representative sample of 600 cells from both populations.
To simulate this step, we can use numpy’s `random.multinomial` function to sample 600 cells from the populations without replacement:

```python
rng = np.random.default_rng(42)
healthy_sample = rng.multinomial(pvals=healthy_tissue / np.sum(healthy_tissue), n=600)
diseased_sample = rng.multinomial(
    pvals=diseased_tissue / np.sum(diseased_tissue), n=600
)
example_data_sample = pd.DataFrame(
    data=np.array([healthy_sample, diseased_sample]),
    index=[1, 2],
    columns=["A", "B", "C"],
)
example_data_sample["Disease status"] = ["Healthy", "Diseased"]
example_data_sample
```

```python
plot_data_sample = example_data_sample.melt(
    "Disease status", ["A", "B", "C"], "Cell type", "count"
)

fig, ax = plt.subplots(1, 2, figsize=(12, 6))
sns.barplot(
    data=plot_data_sample, x="Disease status", y="count", hue="Cell type", ax=ax[0]
)
ax[0].set_title("Sampled abundances, by status")

sns.barplot(
    data=plot_data_sample, x="Cell type", y="count", hue="Disease status", ax=ax[1]
)
ax[1].set_title("Sampled abundances, by cell type")
plt.show()
```

Now the picture is not clear anymore.
While the counts of cell type A still increase (approx. from 200 to 300), the other two cell types seem to decrease from about 200 to 150.
This apparent decrease is caused by our constraint to 600 cells.
If a larger fraction of the sample is taken up by cell type A, the share of cell types B and C must be lower.
Therefore, determining the change in abundance of one cell type is impossible without taking the other cell types into account.

If we ignore the compositionality of the data, and use univariate methods like Wilcoxon rank-sum tests or scDC, a method which performs differential cell-type composition analysis by bootstrap resampling (Cao *et al.*, 2019 [3]), we may falsely perceive cell-type population shifts as statistically sound effects, although they were induced by inherent negative correlations of the cell-type proportions.

Furthermore, the subsampled data does not only give us one valid solution to our question.
If both cell types B and C decreased by 1,000 cells in the diseased case, we would obtain the same representative samples of 600 cells as above.
To get a unique result, we can fix a reference point for the data, which is assumed to be unchanged throughout all samples (Brill *et al.*, 2019 [4]).
This can be a single cell type, an aggregation over multiple cell types such as the geometric mean, or a set of orthogonal bases (Egozcue *et al.*, 2003 [5]).

While single-cell datasets of sufficient size and replicate number have only been around for a few years, the same statistical property has also been discussed in the context of microbial analysis (Gloor *et al.*, 2017 [6]).
There, some popular approaches include ANCOM-BC (Lin & Peddada, 2020 [7]) and ALDEx2 (Fernandes *et al.*, 2014 [8]).
However, these approaches often struggle with single-cell datasets due to the small number of experimental replicates.

This issue has been tackled by scCODA (Büttner *et al.*, 2021 [9]), which we are going to introduce and apply to our dataset in the following section.

## With labeled clusters

[scCODA](https://sccoda.readthedocs.io/en/latest) belongs to the family of tools that require pre-defined clusters, most common cell types, to statistically derive changes in composition.
Inspired by methods for compositional analysis of microbiome data, scCODA proposes a Bayesian approach to address the low replicate issue as commonly encountered in single-cell analysis (Büttner *et al.*, 2021 [9]).
It models cell-type counts using a hierarchical Dirichlet-Multinomial model, which accounts for uncertainty in cell-type proportions and the negative correlative bias via joint modeling of all measured cell-type proportions.
To ensure a uniquely identifiable solution and easy interpretability, the reference in scCODA is chosen to be a specific cell type.
Hence, any detected compositional changes by scCODA always have to be viewed in relation to the selected reference.

However, scCODA assumes a log-linear relationship between covariates and cell abundance, which may not always reflect the underlying biological processes when using continuous covariates.
A further limitation of scCODA is the inability to infer correlation structures among cell compositions beyond compositional effects.
Furthermore, scCODA only models shifts in mean abundance, but does not detect changes in response variability (Büttner *et al.*, 2021 [9]).

As a first step, we instantiate a scCODA model.

Then, we use load function to prepare a [MuData](../glossary.md#term-mudata) object for subsequent processing, and it creates a compositional analysis dataset from the input adata.
And we specify the cell_type_identifier as `cell_label`, sample_identifier as `batch`, and covariate_obs as `condition` in our case.

```python
sccoda_model = pt.tl.Sccoda()
sccoda_data = sccoda_model.load(
    adata,
    type="cell_level",
    generate_sample_level=True,
    cell_type_identifier="cell_label",
    sample_identifier="batch",
    covariate_obs=["condition"],
)
sccoda_data
```

To get an overview of the cell type distributions across conditions we can use scCODA’s `boxplots`.
To get an even better understanding of how the data is distributed, the black dots show the actual data points.

```python
sccoda_model.plot_boxplots(
    sccoda_data,
    modality_key="coda",
    feature_name="condition",
    figsize=(12, 5),
    add_dots=True,
)
plt.show()
```

The boxplots highlight some differences in the distributions of the cell types.
Clearly noticeable is the high proportion of enterocytes for the Salmonella condition.
But other cell types such as transit-amplifying (TA) cells also show stark differences in abundance for the Salmonella condition compared to control.
Whether any of these differences are statistically significant has to be properly evaluated.

An alternative visualization is a stacked barplot as provided by scCODA.
This visualization nicely displays the characteristics of compositional data: If we compare the Control and Salmonella groups, we can see that the proportion of Enterocytes greatly increases in the infected mice.
Since the data is proportional, this leads to a decreased share of all other cell types to fulfill the sum-to-one constraint.

```python
sccoda_model.plot_stacked_barplot(
    sccoda_data, modality_key="coda", feature_name="condition", figsize=(4, 2)
)
plt.show()
```

scCODA requires two major parameters beyond the cell count [AnnData](../glossary.md#term-anndata) object: A formula and a reference cell type.

The formula describes the covariates, which are specified using the [R-style](https://www.statsmodels.org/stable/example_formulas.html).
In our case we specify the condition as the only covariate.
Since it is a discrete covariate with four levels (control and three disease states), this models a comparison of each state with the other samples.
If we wanted to model multiple covariates at once, simply adding them in the formula (i.e. `formula = "covariate_1 + covariate_2"`) is enough.

As mentioned above, scCODA requires a reference cell type to compare against, which is believed to be unchanged by the covariates.
scCODA can either automatically select an appropriate cell type as reference, which is a cell type that has nearly constant relative abundance over all samples, or be run with a user specified reference cell type.
Here we set Endocrine cells as the reference since visually their abundance seems to be rather constant.
An alternative to setting a reference cell type manually is to set the `reference_cell_type` to `"automatic"` which will force scCODA to select a suitable reference cell type itself.
If the choice of reference cell type is unclear, we recommend to use this option to get an indicator or even a final selection.

```python
sccoda_data = sccoda_model.prepare(
    sccoda_data,
    modality_key="coda",
    formula="condition",
    reference_cell_type="Endocrine",
)
sccoda_model.run_nuts(sccoda_data, modality_key="coda", rng_key=42)
```

The acceptance rate describes the fraction of proposed samples that are accepted after the initial burn-in phase, and can be an ad-hoc indicator for a bad optimization run.
In the case of scCODA, the desired acceptance rate is between 0.4 and 0.9.
Acceptance rates that are way higher or too low indicate issues with the sampling process.

```python
sccoda_data["coda"].varm["effect_df_condition[T.Salmonella]"]
```

```python
sccoda_data
```

scCODA selects credible effects based on their inclusion probability.
The cutoff between credible and non-credible effects depends on the desired false discovery rate (FDR).
A smaller FDR value will produce more conservative results, but might miss some effects, while a larger FDR value selects more effects at the cost of a larger number of false discoveries.

The desired FDR level can be easily set after inference via `sim_results.set_fdr()`.
Per default, the value is 0.05.
Since, depending on the dataset, the FDR can have a major influence on the result, we recommend to try out different FDRs up to 0.2 to get the most prominent effects.

In our case, we use less strict FDR of 0.2.

```python
sccoda_model.set_fdr(sccoda_data, 0.2)
```

To get the binary classification of compositional changes per cell type we use the `credible_effects` function of scCODA on the result object.
Every cell type labeled as “True” is significantly more or less present.
The fold-changes describe whether the cell type is more or less present.
Hence, we will plot them alongside the binary classification below.

```python
sccoda_model.credible_effects(sccoda_data, modality_key="coda")
```

Output:
```text
Covariate                 Cell Type            
condition[T.Hpoly.Day3]   Endocrine                False
                          Enterocyte               False
                          Enterocyte.Progenitor    False
                          Goblet                   False
                          Stem                     False
                          TA                       False
                          TA.Early                 False
                          Tuft                     False
condition[T.Hpoly.Day10]  Endocrine                False
                          Enterocyte                True
                          Enterocyte.Progenitor    False
                          Goblet                   False
                          Stem                     False
                          TA                       False
                          TA.Early                 False
                          Tuft                      True
condition[T.Salmonella]   Endocrine                False
                          Enterocyte                True
                          Enterocyte.Progenitor    False
                          Goblet                   False
                          Stem                     False
                          TA                       False
                          TA.Early                 False
                          Tuft                     False
... (1 more lines)
```

To plot the fold changes together with the binary classification, we can easily use effects_bar_plot function.

```python
sccoda_model.plot_effects_barplot(
    sccoda_data, modality_key="coda", covariates="condition"
)
plt.show()
```

The plots nicely show the significant and credible effects of conditions on the cell types.
These effects largely agree with the findings in the Haber paper, who used a non-compositional Poisson regression model:

1. “After Salmonella infection, the frequency of mature enterocytes increased substantially.” (Haber *et al.*, 2017 [1])
2. “Heligmosomoides polygyrus caused an increase in the abundance of goblet and tuft cells.” (Haber *et al.*, 2017 [1])

Readers familiar with the original publication may wonder why the model used by Haber et al. found more significant effects than scCODA, for example a decrease in Stem and Transit-Amplifying cells in the case of Salmonella infection (Haber *et al.*, 2017 [1]).
To explain this discrepancy, remember that cell count data is compositional and therefore an increase in the relative abundance of one cell type will lead to a decrease in the relative abundance of all other cell types.
Due to the stark increase of Enterocytes in the small intestinal epithelium of Salmonella-infected mice, all other cell types appear to decrease, even though this shift is only caused by the compositional properties of the data.
While the original (univariate) Poisson regression model will pick up these likely false positive effects, scCODA is able to account for the compositionality of the data and therefore does not fall into this trap.

## With labeled clusters and hierarchical structure

In addition to the abundance of each cell type, a typical single-cell dataset also contains information about the similarity of the different cells in the form of a tree-based hierarchical ordering.
These hierarchies can either be determined automatically via clustering of the gene expression (which is usually done to discover the clusters of cells that belong to the same cell type), or through biologically informed hierarchies like cell lineages.
[tascCODA](https://tasccoda.readthedocs.io/en/latest/) is an extension of scCODA that integrates hierarchical information and experimental covariate data into the generative modeling of compositional count data (Ostner *et al.*, 2021 [10]).
This is especially beneficial for cell atlassing efforts with increased resolution.

At its core, it uses almost the same Dirichlet-Multinomial setup as scCODA, but extends the model to account for effects on groups of cell types defined as internal nodes in the tree structure.

To use tascCODA, we first have to define a hierarchical ordering of the cell types.
One possible hierarchical clustering uses the eight cell types and orders them by their similarity (pearson correlation) in the [PCA](../glossary.md#term-principal-component-analysis-pca) representation with `sc.tl.dendrogram`.
Since this structure is very simple in our data and will therefore not give us many new insights, we want to have a more complex clustering.
One recent method to get such clusters, is the [schist](https://github.com/dawe/schist) package (Morelli *et al.*, 2021 [11]), which uses a nested stochastic block model that clusters the cell population at different resolution levels.
Running the method with standard settings takes some time (~15 minutes on our data), and gives us an assignment of each cell to a hierarchical clustering in `adata.obs`.

First, we need to define a distance measure between the cells through a PCA embedding:

```python
# use logcounts to calculate PCA and neighbors
adata.layers["counts"] = adata.X.copy()
adata.layers["logcounts"] = sc.pp.log1p(adata.layers["counts"]).copy()
adata.X = adata.layers["logcounts"].copy()
sc.pp.pca(adata)
sc.pp.neighbors(adata, n_neighbors=10, n_pcs=30, random_state=1234)
sc.tl.umap(adata)
```

Then, we can run schist on the AnnData object, which results in a clustering that is defined through a set of columns “nsbm_level_{i}” in `adata.obs`:

```python
schist.inference.fit_model(adata, model="nsbm", random_seed=42)
```

A [UMAP](../glossary.md#term-uniform-manifold-approximation-and-projection-umap) plot nicely shows how the clustering from schist (here on levels 1 and 2) is connected to the cell type assignments.
The representation on level 1 of the hierarchy is hereby a strict refinement of the level above, i.e. each cluster from level 2 is split into multiple smaller clusters:

```python
adata.obsm["CM_nsbm_level_1"].max()
```

Output:
```text
np.float64(0.99)
```

```python
adata.obsm["CM_nsbm_level_1"].mean()
```

Output:
```text
np.float64(0.02207360384991964)
```

```python
sc.pl.umap(
    adata, color=["nsbm_level_1", "nsbm_level_2", "cell_label"], ncols=3, wspace=0.5
)
```

Now, we convert our cell-level data to sample-level data and create the tree.
We create a `tasccoda_model` object in the same way as for scCODA, but with the clustering defined by schist and tree levels.

The load function of Tasccoda will prepare a MuData object and it converts our tree representation into a [ete](http://etetoolkit.org/) tree structure and save it as `tasccoda_data['coda'].uns["tree"]`.
To get some clusters that are not too small, we cut the tree before the last level by leaving out `"nsbm_level_0"`.

```python
tasccoda_model = pt.tl.Tasccoda()
tasccoda_data = tasccoda_model.load(
    adata,
    type="cell_level",
    cell_type_identifier="nsbm_level_1",
    sample_identifier="batch",
    covariate_obs=["condition"],
    levels_orig=["nsbm_level_4", "nsbm_level_3", "nsbm_level_2", "nsbm_level_1"],
    add_level_name=True,
)
tasccoda_data
```

```python
tasccoda_model.plot_draw_tree(tasccoda_data)
```

The model setup and execution in tascCODA works analogous to scCODA, and also the free parameters for the reference and the formula are the same.
Additionally, we can adjust the tree aggregation and model selection via the parameters `phi` and `lambda_1` in the `pen_args` argument (see (Ostner *et al.*, 2021 [10]) for more information).
Here, we use an unbiased setting `phi=0` and a model selection that is slightly less strict than the default with `lambda_1=3.5`.
We use cluster 19 as our reference, since it is almost identical to the set of Endocrine cells.

```python
tasccoda_model.prepare(
    tasccoda_data,
    modality_key="coda",
    reference_cell_type="19",
    formula="condition",
    pen_args={"phi": 0, "lambda_1": 3.5},
    tree_key="tree",
)
```

Output:
```text
• Zero counts encountered in data! Added a pseudocount of 0.5.
```

```python
tasccoda_model.run_nuts(
    tasccoda_data, modality_key="coda", rng_key=1234, num_samples=10000, num_warmup=1000
)
```

```python
tasccoda_model.summary(tasccoda_data, modality_key="coda")
```

Again, the acceptance probability is right around the desired value of 0.85 for tascCODA, indicating no apparent problems with the optimization.

The result from tascCODA should first and foremost be interpreted as effects on the nodes of the tree.
A nonzero parameter on a node means that the aggregated count of all cell types under that node changes significantly.
We can easily visualize this in a tree plot for each of the three disease states.
Blue circles indicate an increase, red circles a decrease:

```python
tasccoda_model.plot_draw_effects(
    tasccoda_data,
    modality_key="coda",
    tree="tree",
    covariate="condition[T.Salmonella]",
    show_leaf_effects=False,
    show_legend=False,
)
```

```python
tasccoda_model.plot_draw_effects(
    tasccoda_data,
    modality_key="coda",
    tree="tree",
    covariate="condition[T.Hpoly.Day3]",
    show_leaf_effects=False,
    show_legend=False,
)
```

```python
tasccoda_model.plot_draw_effects(
    tasccoda_data,
    modality_key="coda",
    tree="tree",
    covariate="condition[T.Hpoly.Day10]",
    show_leaf_effects=False,
    show_legend=False,
)
```

Alternatively, effects on internal nodes can also be translated through the tree onto the cell type level, allowing for a calculation of log-fold changes like in scCODA.
To visualize the log-fold changes of the cell types, we do the same plots as for scCODA, inspired by “High-resolution single-cell atlas reveals diversity and plasticity of tissue-resident neutrophils in non-small cell lung cancer” (Salcher *et al.*, 2022 [12]).

```python
tasccoda_model.plot_effects_barplot(
    tasccoda_data, modality_key="coda", covariates="condition"
)
```

Another insightful representation can be gained by plotting the effect sizes for each condition on the UMAP embedding, and comparing it to the cell type assignments:

```python
effects = [
    "effect_df_condition[T.Salmonella]",
    "effect_df_condition[T.Hpoly.Day3]",
    "effect_df_condition[T.Hpoly.Day10]",
]

effect_plot_names = []

for effect in effects:
    df = tasccoda_data["coda"].varm[effect].copy()
    df.loc[df["Effect"] == 0, "Effect"] = np.nan

    new_name = effect + "_plot"
    tasccoda_data["coda"].varm[new_name] = df
    effect_plot_names.append(new_name)

tasccoda_model.plot_effects_umap(
    tasccoda_data,
    effect_name=effect_plot_names,
    cluster_key="nsbm_level_1",
)

sc.pl.umap(
    tasccoda_data["rna"],
    color=["cell_label", "nsbm_level_1"],
    ncols=2,
    wspace=0.5,
    legend_loc="on data",
)
```

The results are very similar to scCODA’s findings:

- For the Salmonella infection, we get an aggregated increase in clusters that approximately represent Enterocytes in the cell type clustering.
  This increase is even stronger for cluster 8, as indicated by the additional positive effect on the leaf level.
- Heligmosomoides polygyrus infection showed no changes at day 3, and decreased Enterocytes at day 10 (both also detected by scCODA).
  The additional decreases in stem and transit-amplifying cells as well as Enterocyte progenitors at day 10 were not captured by scCODA.

## Without labeled clusters

It is not always possible or practical to use precisely labeled clusters such as cell-type definitions, especially when we are interested in studying transitional states between cell type clusters, such as during developmental processes, or when we expect only a subpopulation of a cell type to be affected by the condition of interest.
In such cases, determining compositional changes based on known [annotations](../glossary.md#term-annotation) may not be appropriate.

A set of methods exist to detect compositional changes occurring in subpopulations of cells smaller than the cell type clusters, usually defined starting from a k-nearest neighbor (KNN) graph computed from similarities in the same low dimensional space used for clustering.

- DA-seq computes, for each cell, a score based on the relative prevalence of cells from both biological states in the cell’s neighborhood, using a range of k values (Zhao *et al.*, 2021 [13]).
  The scores are used as input for a logistic classifier to predict the biological condition of each cell.
- Milo assigns cells to partially overlapping neighborhoods on the KNN graph, then differential abundance (DA) testing is performed modelling cell counts with a generalized linear model (GLM) (Dann *et al.*, 2022 [14]).
- MELD calculates a relative likelihood estimate of observing each cell in every condition using graph-based density estimate (Burkhardt *et al.*, 2021 [15]).

These methods have unique strengths and weaknesses.
Because it relies on logistic classification, DA-seq is designed for pairwise comparisons between two biological conditions, but can’t be applied to test for differences associated with a continuous covariate (such as age or timepoints).
DA-seq and Milo use the variance in the abundance statistic between replicate samples of the same condition to estimate the significance of the differential abundance, while MELD doesn’t use this information.
While considering consistency across replicates reduces the number of false positives driven by one or a few samples, all KNN-based methods are sensitive to a loss of information if the conditions of interest and confounders, defined by technical or experimental sources of variation, are strongly correlated.
The impact of confounders can be mitigated using batch integration methods before KNN graph construction and/or incorporating the confounding covariates in the model for DA testing, as we discuss further in the example below.
Another limitation of KNN-based methods to bear in mind is that cells in a neighborhood may not necessarily represent a specific, unique biological subpopulation, because a cellular state may span over multiple neighborhoods.
Reducing k for the KNN graph or constructing a graph on cells from a particular lineage of interest can help mitigate this issue and ensure the predicted effects are robust to the choice of parameters and to the data subset used (Dann *et al.*, 2022 [14]).

Generally, if large differences are apparent in large clusters by visualization or the imbalances between cell types are of interest, direct analysis with cell-type aware methods, such as scCODA, might be more suitable.
KNN-based methods are more powerful when we are interested in differences in cell abundances that might appear in transitional states between cell types or in a specific subset of cells of a given cell type.

We will now apply Milo to the Haber dataset to try to find over- or underrepresented neighborhoods of cells upon infection.

Milo is available as [miloR](https://github.com/MarioniLab/miloR) for R users and in [pertpy](https://github.com/theislab/pertpy) for Python users in the [scverse](../glossary.md#term-scverse) ecosystem.
In the following demonstration, we will use milo of pertpy which is easiest to use with our AnnData object due to its scverse compatibility.

To perform DA analysis with Milo, we need to construct a KNN graph that is representative of the biological similarities between cells, as we do when performing clustering or UMAP visualization of a single-cell dataset.
This means (A) building a common low-dimensional space for all samples and (B) minimizing cell-cell similarities driven by technical factors (i.e. [batch effects](../glossary.md#term-batch-effect)).

We first use the standard [scanpy](../glossary.md#term-scanpy) workflow for dimensionality reduction to qualitatively assess whether we see a batch effect in this dataset.

```python
milo = pt.tl.Milo()
adata = ln.Artifact.get(
    key="conditions/compositional_haber.h5ad",
).load()
mdata = milo.load(adata)
mdata
```

```python
# use logcounts to calculate PCA and neighbors
adata.layers["counts"] = adata.X.copy()
sc.pp.log1p(adata)

sc.pp.highly_variable_genes(
    adata, n_top_genes=3000, subset=False
)  # 3k genes as used by authors for clustering

sc.pp.pca(adata)
sc.pp.neighbors(adata, n_neighbors=10, n_pcs=30)
sc.tl.umap(adata)
```

```python
sc.pl.umap(adata, color=["condition", "batch", "cell_label"], ncols=3, wspace=0.25)
```

While cell type clusters are broadly captured, we can see residual separation between batches, also for replicates of the same treatment.
If we define neighbourhoods on this KNN graph we might have a large fraction of neighbourhoods containing cells from just one or a few batches.
This could introduce false negatives, if the variance in number of cells between replicates is too low (e.g. 0 cells for all replicates) or too high (e.g. all zero cells except for one replicate with a large number of cells), but also false positives, especially when, like in this case, the number of replicates per condition is low.

To minimize these errors, we apply the scVI method to learn a batch-corrected latent space, as introduced in the [integration chapter](../cellular-structure/integration.md).

```python
adata_scvi = adata[:, adata.var["highly_variable"]].copy()
scvi.model.SCVI.setup_anndata(adata_scvi, layer="counts", batch_key="batch")
model_scvi = scvi.model.SCVI(adata_scvi)
max_epochs_scvi = int(np.min([round((20000 / adata.n_obs) * 400), 400]))
model_scvi.train(max_epochs=max_epochs_scvi, accelerator="mps")
adata.obsm["X_scVI"] = model_scvi.get_latent_representation()
```

Output:
```text
Training:   0%|          | 0/400 [00:00<?, ?it/s]
```

```python
sc.pp.neighbors(adata, use_rep="X_scVI")
sc.tl.umap(adata)
```

```python
sc.pl.umap(adata, color=["condition", "batch", "cell_label"], ncols=3, wspace=0.25)
```

Here we can see much better mixing between batches and cell labels form much more uniform clusters.

> **Will batch correction remove biological differences between conditions?**
> 
> This really boils down to good experimental design.
> In an ideal set-up replicates from the same condition will be processed in different batches.
> This allows to estimate technical differences more accurately and possibly also incorporate the batch as a confounder in the linear model for differential abundance analysis (see below), to further minimize false positives.
> When, like in this example, batches are confounded with the biological condition of interest, we have to recognize that while we might be minimizing false positives, the rate of false negatives might also increase.
> The analyst can decide which type of error is more detrimental depending on the dataset and purpose of the differential abundance analysis.

### Define neighbourhoods

Milo is a KNN-based model, where cell abundance is quantified on neighbourhoods of cells.
In Milo, a neighbourhood is defined as the group of cells connected by an edge to the same cell (*index cell*) in an undirected KNN graph.
While we could in principle have one neighbourhood for each cell in the graph, this would be inefficient and significantly increase the multiple testing burden.
Therefore Milo samples a refined set of cells as index cells for neighbourhoods, starting from a random sample of a fraction of cells.
The initial proportion can be specified using the `prop` argument in the `milo.make_nhoods` function.
As by default, we recommend using `prop=0.1` (10% of cells) and to reduce to 5% or 2% to increase scalability on large datasets (> 100k cells).

If no `neighbors_key` parameter is specified, Milo uses the neighbours from `.obsp`.
Therefore, ensure that `sc.pp.neighbors` was run on the correct representation, i.e. an integrated latent space if batch correction was required.

```python
milo.make_nhoods(mdata, prop=0.1)
```

Now the binary assignment of cells to neighbourhood is stored in `adata.obsm['nhoods']`.
Here we can see that, as expected, the number of neighbourhoods should be less or equal to the number of cells in the graph times the `prop` parameter.
In this case, less or equal than 984 neighbourhoods.

```python
adata.obsm["nhoods"]
```

Output:
```text
<Compressed Sparse Row sparse matrix of dtype 'float32'
	with 22343 stored elements and shape (9842, 857)>
```

At this point we need to check the median number of cells in each neighbourhood, to make sure the neighbourhoods contain enough cells to detect differences between samples.

```python
nhood_size = adata.obsm["nhoods"].toarray().sum(0)
plt.hist(nhood_size, bins=20)
plt.xlabel("# cells in neighbourhood")
plt.ylabel("# neighbouthoods");
```

```python
np.median(nhood_size)
```

Output:
```text
np.float32(25.0)
```

We expect the minimum number of cells to be equal to the k parameter used during graph construction (k=10 in this case).
To increase the statistical power for DA testing, we need a sufficient number of cells from all samples in the majority of the neighbourhoods.
We can use the following rule of thumb: to have a median of 3 cells from each sample in a neighbourhood, the number of cells in a neighbourhood should be at least 3 times the number of samples. In this case, we have data from 10 samples.
If we want to have on average 3 cells from each sample in a neighbourhood, the minimum number of cells should be 30.

Based on the plot above, we have a large number of neighbourhoods with less than 30 cells, which could lead to an underpowered test.
To solve this, we just need to recompute the KNN graph using `n_neighbors=30`.
To distinguish this KNN graph used for neighbourhood-level DA analysis from the graph used for UMAP building, we will store this as a distinct graph in `adata.obsp`.

```python
sc.pp.neighbors(adata, n_neighbors=30, use_rep="X_scVI", key_added="milo")
milo.make_nhoods(mdata, neighbors_key="milo", prop=0.1)
```

Let’s check that the distribution of neighbourhood sizes has shifted.

```python
nhood_size = adata.obsm["nhoods"].toarray().sum(0)
plt.hist(nhood_size, bins=20)
plt.xlabel("# cells in neighbourhood")
plt.ylabel("# neighbouthoods");
```

### Count cells in neighbourhoods

In the next step, Milo counts cells belonging to each of the samples (here identified by the `batch` column in `adata.obs`).

```python
milo.count_nhoods(mdata, sample_col="batch")
```

This stores a neighbourhood-level AnnData object, where `nhood_adata.X` stores the number of cells from each sample in each neighbourhood.

```python
mdata["milo"]
```

Output:
```text
AnnData object with n_obs × n_vars = 10 × 800
    var: 'index_cell', 'kth_distance'
    uns: 'sample_col'
```

We can verify that the average number of cells per sample times the number of samples roughly corresponds to the number of cells in a neighbourhood.

```python
mean_n_cells = mdata["milo"].X.toarray().mean(0)
plt.plot(nhood_size, mean_n_cells, ".")
plt.xlabel("# cells in nhood")
plt.ylabel("Mean # cells per sample in nhood");
```

### Run differential abundance test on neighbourhoods

```python
mdata.mod["rna"].obs["condition"]
```

Output:
```text
index
B1_AAACATACCACAAC_Control_Enterocyte.Progenitor           Control
B1_AAACGCACGAGGAC_Control_Stem                            Control
B1_AAACGCACTAGCCA_Control_Stem                            Control
B1_AAACGCACTGTCCC_Control_Stem                            Control
B1_AAACTTGACCACCT_Control_Enterocyte.Progenitor           Control
                                                          ...    
B10_TTTCACGACAAGCT_Salmonella_TA                       Salmonella
B10_TTTCAGTGAGGCGA_Salmonella_Enterocyte               Salmonella
B10_TTTCAGTGCGACAT_Salmonella_Stem                     Salmonella
B10_TTTCAGTGTGACCA_Salmonella_Endocrine                Salmonella
B10_TTTCAGTGTTCTCA_Salmonella_Enterocyte.Progenitor    Salmonella
Name: condition, Length: 9842, dtype: category
Categories (4, object): ['Control', 'Hpoly.Day3', 'Hpoly.Day10', 'Salmonella']
```

Milo can use edgeR or pydeseq2 to test if there are statistically significant differences between the number of cells from a condition of interest in each neighborhood.

Here we are interested in detecting in which neighbourhoods there is a significant increase or decrease of cells in response to infection.
Since the `condition` covariate stores many different types of infection, we need to specify which conditions we need to contrast in our differential abundance test (following a convention used in R, by default the last level of the covariate against the rest will be used, in this case Salmonella vs rest).
To specify the comparison, we use [the syntax used for GLMs in R](https://genomicsclass.github.io/book/pages/expressing_design_formula.html).

Let’s first test for differences associated with Salmonella infection.

```python
milo.da_nhoods(
    mdata,
    design="~condition",
    model_contrasts="conditionSalmonella-conditionControl",
    solver="pydeseq2",
)
```

Output:
```text
Using None as control genes, passed at DeseqDataSet initialization
Log2 fold change & Wald test p-value: condition Salmonella vs Control
     baseMean  log2FoldChange     lfcSE      stat    pvalue      padj
0    3.745092       -3.159541  1.685531 -1.874508  0.060860       NaN
1    6.848761       -1.875330  0.981719 -1.910251  0.056101  0.241288
2    6.845937       -0.670754  0.894698 -0.749698  0.453437  0.718952
3    5.096995       -2.713224  1.323136 -2.050601  0.040306  0.201376
4    4.137767        0.092905  0.940401  0.098793  0.921303       NaN
..        ...             ...       ...       ...       ...       ...
795  4.801276        0.305353  1.004862  0.303876  0.761222  0.878181
796  3.734235       -0.269244  1.079029 -0.249525  0.802955       NaN
797  7.292822        2.701689  1.094880  2.467567  0.013603  0.112962
798  3.870346       -3.866167  2.554222 -1.513638  0.130118       NaN
799  4.938727        0.788940  0.931172  0.847255  0.396853  0.684792

[800 rows x 6 columns]
```

Information about the sample design is stored in `mdata['milo'].obs`:

```python
mdata["milo"].obs
```

For each neighbourhood, we calculated a set of statistics (stored in `mdata["milo"].var`).
In particular:

- `logFC`: the log-fold change in abundance.
  If logFC > 0, the neighbourhood is enriched for cells from the condition of interest; if logFC < 0, it is depleted.
- `PValue`: stores the p-value for the test.
- `SpatialFDR`: stores the p-values adjusted for multiple testing (accounting for overlap between neighbourhoods).
  This is calculated adapting the weighted Benjamini-Hochberg (BH) correction introduced by Lun et al (Lun *et al.*, 2017 [16]), which accounts for the fact that because neighbourhoods are partially overlapping (i.e. one cell can belong to multiple neighbourhoods) the DA tests on different neighbourhoods are not completely independent.
  In practice, the BH correction is weighted by the reciprocal of each index cell’s k-th nearest-neighbour distance, which is used as a proxy for the amount of overlap with other neighbourhoods.
  High `kth_distance` indicates sparse regions with low neighbourhood overlap, whereas low values indicate dense regions with high overlap.
  You might notice that the SpatialFDR values very often lower or equal to the FDR values, calculated with a conventional BH correction.

```python
mdata["milo"].var
```

Before any exploration and interpretation of the results, we can visualize these statistics with a set of diagnostics plots to sanity check our statistical test:

```python
def plot_milo_diagnostics(mdata):
    alpha = 0.1  ## significance threshold

    with matplotlib.rc_context({"figure.figsize": [12, 12]}):
        ## Check P-value histogram
        plt.subplot(2, 2, 1)
        plt.hist(mdata["milo"].var["PValue"], bins=20)
        plt.xlabel("Uncorrected P-value")

        ## Visualize extent of multiple-testing correction
        plt.subplot(2, 2, 2)
        plt.scatter(
            mdata["milo"].var["PValue"],
            mdata["milo"].var["SpatialFDR"],
            s=3,
        )
        plt.xlabel("Uncorrected P-value")
        plt.ylabel("SpatialFDR")

        ## Visualize volcano plot
        plt.subplot(2, 2, 3)
        plt.scatter(
            mdata["milo"].var["logFC"],
            -np.log10(mdata["milo"].var["SpatialFDR"]),
            s=3,
        )
        plt.axhline(
            y=-np.log10(alpha),
            color="red",
            linewidth=1,
            label=f"{int(alpha * 100)} % SpatialFDR",
        )
        plt.legend()
        plt.xlabel("log-Fold Change")
        plt.ylabel("- log10(SpatialFDR)")
        plt.tight_layout()

        ## Visualize MA plot
        df = mdata["milo"].var
        emp_null = df[df["SpatialFDR"] >= alpha]["logFC"].mean()
        df["Sig"] = df["SpatialFDR"] < alpha

        plt.subplot(2, 2, 4)
        sns.scatterplot(data=df, x="logCPM", y="logFC", hue="Sig")
        plt.axhline(y=0, color="grey", linewidth=1)
        plt.axhline(y=emp_null, color="purple", linewidth=1)
        plt.legend(title=f"< {int(alpha * 100)} % SpatialFDR")
        plt.xlabel("Mean log-counts")
        plt.ylabel("log-Fold Change")
        plt.show()
```

```python
plot_milo_diagnostics(mdata)
```

1. The **P-value histogram** shows the distribution of p-values before multiple testing correction.
   By definition, we expect the p-values under the null hypothesis (> significance level) to be uniformly distributed, while the peak of p-values close to zero represents the significant results.
   This gives you an idea of how conservative your test is, and it might help to spot early some pathological cases.
   For example, if the distribution of p-values looks bimodal, with a second peak close to 1, this might indicate that you have a large number of neighbourhoods with no variance between replicates of one condition (e.g. all replicates from one condition have 0 cells) which might indicate a residual batch effect or that you need to increase the size of neighbourhoods.
   If the p-value histogram is left-skewed this might indicate a [confounding covariate](https://github.com/MarioniLab/miloR/issues/220#issuecomment-1140812805) that has not been accounted for in the model.
   For other pathological cases and possible interpretations see [this blogpost](http://varianceexplained.org/statistics/interpreting-pvalue-histogram/).
2. For each neighbourhood we plot the uncorrected **p-value vs. the p-value controlling for the Spatial FDR**.
   Here we expect the adjusted p-values to be larger (so points above the diagonal).
   If the FDR correction is especially severe (i.e. many values close to 1) this might indicate a pathological case.
   You might be testing on too many neighbourhoods (you can reduce `prop` in `milo.make_nhoods`) or there might be too much overlap between neighbourhoods (you might need to decrease *k* when constructing the KNN graph).
3. The **Volcano plot** gives us an idea of how many neighbourhoods show significant DA after multiple testing correction ( - log(SpatialFDR) > 1) and shows how many neighbourhoods are enriched or depleted of cells from the condition of interest.
4. The **MA plot** shows the dependency between average number of cells per sample and the log-fold change of the test.
   In a balanced scenario, we expect points to be concentrated around logFC = 0, otherwise the shift might indicate a strong imbalance in average number of cells between samples from different conditions.
   For more tips on how to interpret the MA plot see this [discussion](https://github.com/MarioniLab/miloR/issues/208).

After sanity check, we can visualize the DA results for each neighbourhood by the position of the index cell on the UMAP embedding, to qualitatively assess which cell types may be most affected by the infection.

```python
milo.build_nhood_graph(mdata)
with matplotlib.rc_context({"figure.figsize": [10, 10]}):
    milo.plot_nhood_graph(mdata, padj_threshold=0.1, min_size=5, plot_edges=False)
    sc.pl.umap(mdata["rna"], color="cell_label", legend_loc="on data")
```

This shows a set of neighbourhoods enriched upon Salmonella infection corresponding to mature enterocytes, and a depletion in a subset of stem cell neighbourhoods.
For interpretation of results, it’s often useful to annotate neighbourhoods by the cell type cluster that they overlap with.
Using the function `milo.annotate_nhoods` assigns a categorical label to neighbourhoods, based on the most frequent label among cells in each neighbourhood.

```python
milo.annotate_nhoods(mdata, anno_col="cell_label")

plt.hist(mdata["milo"].var["nhood_annotation_frac"], bins=30)
plt.xlabel("celltype fraction");
```

We can see that for the majority of neighbourhoods, almost all cells have the same cell type label.
We can rename neighbourhoods where less than 75% of the cells have the top label as “Mixed”.

```python
mdata["milo"].var["nhood_annotation"] = (
    mdata["milo"].var["nhood_annotation"].cat.add_categories("Mixed")
)
mdata["milo"].var.loc[
    mdata["milo"].var["nhood_annotation_frac"] < 0.75, "nhood_annotation"
] = "Mixed"
```

Now we can visualize the fold changes by cell type annotation.

```python
milo.plot_da_beeswarm(mdata)
plt.show()
```

> **What about the compositional effect?**
> 
> Comparing the Milo results to the scCODA results, here we identify a strong enrichment upon *Salmonella* infection in the Enterocytes, but also a depletion in a subset of Stem cells, similarly to what the original authors reported(Haber *et al.*, 2017 [1]). Although we don’t have a ground truth to verify whether the decrease in abundance of stem cells is real, it’s important to note that the GLM in Milo doesn’t explicitly model the compositional nature of cell abundances in neighborhoods, so in theory the results could be affected by compositional biases. In practice, performing a test on a large number of neighbourhoods alleviates this issue, since the effect in the opposite direction is distributed across thousands of neighborhoods rather than tens of cell types. Additionally, the test used in Milo uses the trimmed mean of M values normalization method (TMM normalization (Robinson & Oshlack, 2010 [17])) to estimate normalization factors robust to compositional differences across samples. In this particular example, residual compositional effects might be explained by (A) the relatively small number of neighborhoods (< 1000), (B) the very large effect size in Enterocyte neighbourhoods or (C) the very small number of replicates per condition.

### Test for continuous covariates

Of note, the GLM framework used by Milo allows to test for cell enrichment/depletion also for continuous covariates.
We demonstrate this by testing for differential abundance along the *Heligmosomoides polygyrus* infection time course.

```python
# subset
keep_cells = mdata["rna"].obs.condition != "Salmonella"
keep_batches = set(mdata["rna"].obs.query('condition != "Salmonella"')["batch"])

mdata_sub = md.MuData(
    {
        "rna": mdata.mod["rna"][keep_cells].copy(),
        "milo": mdata["milo"][mdata["milo"].obs["batch"].isin(keep_batches)].copy(),
    }
)

# turn into continuous variable
mdata_sub["rna"].obs["Hpoly_timecourse"] = (
    mdata_sub["rna"]
    .obs["condition"]
    .cat.reorder_categories(["Control", "Hpoly.Day3", "Hpoly.Day10"])
)
mdata_sub["rna"].obs["Hpoly_timecourse"] = (
    mdata_sub["rna"].obs["Hpoly_timecourse"].cat.codes
)

milo.da_nhoods(mdata_sub, design="~ Hpoly_timecourse")
```

Output:
```text
Using None as control genes, passed at DeseqDataSet initialization
Log2 fold change & Wald test p-value: Hpoly_timecourse 2 vs 0
     baseMean  log2FoldChange     lfcSE      stat    pvalue      padj
0    4.593803       -1.192141  1.049615 -1.135788  0.256045       NaN
1    7.984110       -0.448706  0.681342 -0.658562  0.510177  0.752625
2    7.397035        0.639130  0.788708  0.810350  0.417739  0.697690
3    6.107084        0.015603  0.827002  0.018867  0.984947  0.994001
4    3.601991       -2.823400  1.183860 -2.384911  0.017083       NaN
..        ...             ...       ...       ...       ...       ...
795  4.864727        0.644065  0.893795  0.720596  0.471158       NaN
796  3.624533       -1.123942  1.129684 -0.994917  0.319777       NaN
797  3.419577       -2.187171  1.543997 -1.416564  0.156610       NaN
798  4.823856        1.773826  0.891565  1.989563  0.046639       NaN
799  4.375605        0.625821  0.907988  0.689240  0.490672       NaN

[800 rows x 6 columns]
```

```python
plot_milo_diagnostics(mdata_sub)
```

```python
with matplotlib.rc_context({"figure.figsize": [10, 10]}):
    milo.plot_nhood_graph(mdata_sub, padj_threshold=0.1, min_size=5, plot_edges=False)
```

```python
milo.plot_da_beeswarm(mdata_sub)
plt.show()
```

We can verify that the test captures a change in cell numbers across the time course by plotting the number of cells per sample by condition in neighborhoods where significant enrichment or depletion was detected.

```python
print(mdata_sub["milo"].obs["Hpoly_timecourse"].dtype)
print(mdata_sub["milo"].obs["Hpoly_timecourse"].unique())
```

Output:
```text
int8
[0 1 2]
```

```python
entero_ixs = mdata_sub["milo"].var_names[
    (mdata_sub["milo"].var["SpatialFDR"] < 0.1)
    & (mdata_sub["milo"].var["logFC"] < 0)
    & (mdata_sub["milo"].var["nhood_annotation"] == "Enterocyte")
]

plt.title("Enterocyte")
milo.plot_nhood_counts_by_cond(
    mdata_sub, test_var="Hpoly_timecourse", subset_nhoods=entero_ixs
)
plt.show()

tuft_ixs = mdata_sub["milo"].var_names[
    (mdata_sub["milo"].var["SpatialFDR"] < 0.1)
    & (mdata_sub["milo"].var["logFC"] > 0)
    & (mdata_sub["milo"].var["nhood_annotation"] == "Tuft")
]
plt.title("Tuft cells")
milo.plot_nhood_counts_by_cond(
    mdata_sub, test_var="Hpoly_timecourse", subset_nhoods=tuft_ixs
)
plt.show()
```

Interestingly the DA test on the neighbourhoods detects an enrichment upon infection in Tuft cells.
We can characterize the difference between cell type subpopulations enriched upon infection by examining the mean gene expression profiles of cells in neighbourhoods.
For example, if we take the neighbourhoods of Goblet cells, we can see that neighbourhoods enriched upon infection display a higher expression of Retnlb, which is a gene implicated in anti-parasitic immunity (Haber *et al.*, 2017 [1]).
We can either use `annotate_nhoods_continuous` to add a certain continuous annotation from the cells to the neighbourhoods or use `add_nhood_expression` to add the mean expression for all genes.

```python
mdata_sub["rna"].layers["counts"] = mdata_sub["rna"].X.copy()
sc.pp.normalize_total(mdata_sub["rna"], target_sum=1e4)
sc.pp.log1p(mdata_sub["rna"])
mdata_sub["rna"].layers["logcounts"] = mdata_sub["rna"].X.copy()

# compute average Retnlb expression per neighbourhood
mdata_sub["rna"].obs["Retnlb_expression"] = (
    mdata_sub["rna"][:, "Retnlb"].layers["logcounts"].toarray().ravel()
)
milo.annotate_nhoods_continuous(mdata_sub, "Retnlb_expression")

# subset to Goblet cell neighbourhoods
nhood_df = mdata_sub["milo"].var.copy()
nhood_df = nhood_df[nhood_df["nhood_annotation"] == "Goblet"]

sns.scatterplot(data=nhood_df, x="logFC", y="nhood_Retnlb_expression")
plt.show()
```

Output:
```text
WARNING: adata.X seems to be already log-transformed.
```

### Accounting for confounding covariates

Several confounding factors might affect cell abundances and proportions other than our condition of interest.
For example, different set of samples might have been processed or sequenced in the same batch, or a set of samples could contain cells FAC-sorted using different markers to enrich a subset of populations of interest.
As long as these factors are not completely correlated with the condition of interest, we can include these covariates in the model used for differential abundance testing, to estimate differential abundance associated with the condition of interest, while minimizing differences explained by the confounding factors.
In Milo, we can express this type of test design using the syntax `~ confounder + condition`.

```python
# make dummy confounder for the sake of this example
nhood_adata = mdata["milo"].copy()
conf_dict = dict(
    zip(
        nhood_adata.obs_names,
        rng.choice(["group1", "group2"], nhood_adata.n_obs),
        strict=False,
    )
)
mdata["rna"].obs["dummy_confounder"] = [conf_dict[x] for x in mdata["rna"].obs["batch"]]

milo.da_nhoods(mdata, design="~ dummy_confounder+condition")
```

Output:
```text
Using None as control genes, passed at DeseqDataSet initialization
Log2 fold change & Wald test p-value: condition Salmonella vs Control
     baseMean  log2FoldChange     lfcSE      stat    pvalue      padj
0    3.745092       -3.150403  1.697074 -1.856373  0.063400       NaN
1    6.848761       -1.877745  1.008379 -1.862143  0.062583  0.277426
2    6.845937       -0.645550  0.920931 -0.700975  0.483318  0.730023
3    5.096995       -2.598859  1.318902 -1.970472  0.048784  0.246683
4    4.137767        0.052395  0.952371  0.055015  0.956126       NaN
..        ...             ...       ...       ...       ...       ...
795  4.801276        0.366985  1.040609  0.352664  0.724341  0.882194
796  3.734235       -0.258189  1.121981 -0.230119  0.818000       NaN
797  7.292822        2.661730  1.121615  2.373122  0.017638  0.152487
798  3.870346       -3.855027  2.569750 -1.500156  0.133574       NaN
799  4.938727        0.820740  0.961078  0.853979  0.393116  0.673754

[800 rows x 6 columns]
```

```python
mdata["milo"].var
```

## Questions

### Flipcards

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q7",
        "It is tricky to deduce compositional changes visually. Why?",
        "Interpreting compositional changes visually is challenging because shifts in cell type proportions may be subtle or confounded by the high dimensionality and variability inherent in single-cell data, making it difficult to discern significant differences without statistical analysis.",
        back_font_size=10,
    )
    flip_card(
        "q8",
        "Why is it necessary to interpret cell type abundances as proportions instead of absolute counts? What are the dangers of not doing so?",
        "Interpreting cell type abundances as proportions rather than absolute counts is essential because the total number of cells can vary between samples; failing to account for this can lead to misleading conclusions, as apparent changes in cell counts might simply reflect differences in sample sizes rather than true biological variations.",
        back_font_size=10,
    )
    flip_card(
        "q9",
        "When should you use cluster-based tools (e.g., scCODA, tascCODA) and when are non-cluster-based tools (e.g., Milo) appropriate?",
        "Tools that utilize cluster information (e.g., cell types), are appropriate when distinct clusters are identifiable, allowing for targeted analysis of known populations. Conversely, methods that do not rely on clustering are beneficial when data lacks clear separations, such as during continuous developmental processes, enabling the detection of subtle changes across a spectrum of cell states.",
        back_font_size=10,
    )
```

### Multiple-choice questions

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    multiple_choice_question(
        question_id="q1",
        question="What is a major challenge in single-cell compared to microbiome compositional analysis?",
        options=[
            "Too many cell types",
            "Too few replicates",
            "Proportions cannot be measured",
            "Only microbiome data is compositional",
        ],
        correct_answer="Too few replicates",
        explanations={
            "Too many cell types": "Cell type number is not the main issue.",
            "Proportions cannot be measured": "Single-cell data is inherently proportional.",
            "Only microbiome data is compositional": "Both are compositional.",
        },
    )

    multiple_choice_question(
        question_id="q2",
        question="If cell type A increases, what happens to unchanged B and C after subsampling?",
        options=[
            "Their counts stay the same",
            "Their counts also increase",
            "They appear to decrease",
            "They disappear completely",
        ],
        correct_answer="They appear to decrease",
        explanations={
            "Their counts stay the same": "A larger share for A reduces the apparent share of B and C.",
            "Their counts also increase": "An increase in A cannot increase others.",
            "They disappear completely": "The decrease is a sampling artefact.",
        },
    )

    multiple_choice_question(
        question_id="q3",
        question="Why can ignoring compositionality cause false positives?",
        options=[
            "Because Bayesian models are not robust",
            "Because induced correlations make unchanged cell types appear different",
            "Because univariate tests always overestimate effects",
            "Because PCA removes compositional information",
        ],
        correct_answer="Because induced correlations make unchanged cell types appear different",
        explanations={
            "Because Bayesian models are not robust": "The problem is incorrect testing, not Bayesian models.",
            "Because univariate tests always overestimate effects": "The issue is spurious correlations.",
            "Because PCA removes compositional information": "",
        },
    )

    multiple_choice_question(
        question_id="q4",
        question="What must the reference cell type satisfy in scCODA?",
        options=[
            "Be the most abundant cell type",
            "Show the largest fold change",
            "Remain stable across conditions",
            "Be absent in one condition",
        ],
        correct_answer="Remain stable across conditions",
        explanations={
            "Be the most abundant cell type": "Abundance is not important; stability is.",
            "Show the largest fold change": "Changing cell types are poor references.",
            "Be absent in one condition": "A reference should be present and stable.",
        },
    )

    multiple_choice_question(
        question_id="q5",
        question="Which experimental design is best for a single-cell compositional study?",
        options=[
            "Process each condition in a separate batch",
            "Use one replicate per condition",
            "Spread replicates across batches",
            "Remove low-count cell types",
        ],
        correct_answer="Spread replicates across batches",
        explanations={
            "Process each condition in a separate batch": "This confounds batch and condition.",
            "Use one replicate per condition": "One replicate cannot estimate variability.",
            "Remove low-count cell types": "Rare cell types should still be modeled.",
        },
    )
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Johannes Ostner
- Emma Dann
- Lukas Heumos
- Anastasia Litinetskaya
- Luis Heinzlmeier

### Reviewers

## References

1. Haber, A. L., Biton, M., Rogel, N., Herbst, R. H., Shekhar, K., Smillie, C., Burgin, G., Delorey, T. M., Howitt, M. R., Katz, Y., Tirosh, I., Beyaz, S., Dionne, D., Zhang, M., Raychowdhury, R., Garrett, W. S., Rozenblatt-Rosen, O., Shi, H. N., Yilmaz, O., … Regev, A. (2017). A single-cell survey of the small intestinal epithelium. *Nature*, *551*(7680), 333–339. https://doi.org/10.1038/nature24489
2. Aitchison, J. (1982). The Statistical Analysis of Compositional Data. *Journal of the Royal Statistical Society: Series B (Methodological)*, *44*(2), 139–160. https://doi.org/10.1111/j.2517-6161.1982.tb01195.x
3. Cao, Y., Lin, Y., Ormerod, J. T., Yang, P., Yang, J. Y. H., & Lo, K. K. (2019). scDC: single cell differential composition analysis. *BMC Bioinformatics*, *20*(19), 721. https://doi.org/10.1186/s12859-019-3211-9
4. Brill, B., Amir, A., & Heller, R. (2019). Testing for differential abundance in compositional counts data, with application to microbiome studies. *ArXiv*. http://arxiv.org/abs/1904.08937
5. Egozcue, J. J., Pawlowsky-Glahn, V., Mateu-Figueras, G., & Barceló-Vidal, C. (2003). Isometric Logratio Transformations for Compositional Data Analysis. *Math. Geol.*, *35*(3), 279–300. https://doi.org/10.1023/A:1023818214614
6. Gloor, G. B., Macklaim, J. M., Pawlowsky-Glahn, V., & Egozcue, J. J. (2017). Microbiome Datasets Are Compositional: And This Is Not Optional. *Front. Microbiol.*, *8*, 2224. https://doi.org/10.3389/fmicb.2017.02224
7. Lin, H., & Peddada, S. D. (2020). Analysis of compositions of microbiomes with bias correction. *Nat. Commun.*, *11*(1), 3514. https://doi.org/10.1038/s41467-020-17041-7
8. Fernandes, A. D., Reid, J. N., Macklaim, J. M., McMurrough, T. A., Edgell, D. R., & Gloor, G. B. (2014). Unifying the analysis of high-throughput sequencing datasets: characterizing RNA-seq, 16S rRNA gene sequencing and selective growth experiments by compositional data analysis. *Microbiome*, *2*, 15. https://doi.org/10.1186/2049-2618-2-15
9. Büttner, M., Ostner, J., Müller, C. L., Theis, F. J., & Schubert, B. (2021). scCODA is a Bayesian model for compositional single-cell data analysis. *Nature Communications*, *12*(1), 6876. https://doi.org/10.1038/s41467-021-27150-6
10. Ostner, J., Carcy, S., & Müller, C. L. (2021). tascCODA: Bayesian Tree-Aggregated Analysis of Compositional Amplicon and Single-Cell Data. *Frontiers in Genetics*, *12*. https://doi.org/10.3389/fgene.2021.766405
11. Morelli, L., Giansanti, V., & Cittaro, D. (2021). Nested Stochastic Block Models applied to the analysis of single cell data. *BMC Bioinformatics*, *22*(1), 576. https://doi.org/10.1186/s12859-021-04489-7
12. Salcher, S., Sturm, G., Horvath, L., Untergasser, G., Fotakis, G., Panizzolo, E., Martowicz, A., Pall, G., Gamerith, G., Sykora, M., Augustin, F., Schmitz, K., Finotello, F., Rieder, D., Sopper, S., Wolf, D., Pircher, A., & Trajanoski, Z. (2022). High-resolution single-cell atlas reveals diversity and plasticity of tissue-resident neutrophils in non-small cell lung cancer. *bioRxiv*. https://doi.org/10.1101/2022.05.09.491204
13. Zhao, J., Jaffe, A., Li, H., Lindenbaum, O., Sefik, E., Jackson, R., Cheng, X., Flavell, R. A., & Yuval Kluger. (2021). Detection of differentially abundant cell subpopulations in scRNA-seq data. *Proceedings of the National Academy of Sciences*, *118*(22), e2100293118. https://doi.org/10.1073/pnas.2100293118
14. Dann, E., Henderson, N. C., Teichmann, S. A., Morgan, M. D., & Marioni, J. C. (2022). Differential abundance testing on single-cell data using k-nearest neighbor graphs. *Nature Biotechnology*, *40*(2), 245–253. https://doi.org/10.1038/s41587-021-01033-z
15. Burkhardt, D. B., Stanley, J. S., Tong, A., Perdigoto, A. L., Gigante, S. A., Herold, K. C., Wolf, G., Giraldez, A. J., van Dijk, D., & Krishnaswamy, S. (2021). Quantifying the effect of experimental perturbations at single-cell resolution. *Nature Biotechnology*, *39*(5), 619–629. https://doi.org/10.1038/s41587-020-00803-5
16. Lun, A. T. L., Richard, A. C., & Marioni, J. C. (2017). Testing for Differential Abundance in Mass Cytometry Data. *Nature Methods*, *14*(7), 707–709. https://doi.org/10.1038/nmeth.4295
17. Robinson, M. D., & Oshlack, A. (2010). A Scaling Normalization Method for Differential Expression Analysis of RNA-seq Data. *Genome Biology*, *11*(3), R25. https://doi.org/10.1186/gb-2010-11-3-r25
