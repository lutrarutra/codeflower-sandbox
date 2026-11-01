---
name: single-cell-best-practices
description: The complete "Single-cell best practices" book (sc-best-practices.org, Theis lab) as reference files, with each chapter's bibliography. Use when analyzing or advising on single-cell or spatial omics data - scRNA-seq, scATAC-seq, CITE-seq, immune repertoire (TCR/BCR), spatial transcriptomics, multimodal - including raw data processing, QC, doublets, ambient RNA, normalization, feature selection, dimensionality reduction, clustering, cell type annotation, data integration and batch correction, pseudotime, RNA velocity, lineage tracing, differential expression (pseudobulk), compositional analysis, gene set enrichment, perturbation modeling, gene regulatory networks, cell-cell communication, deconvolution, AnnData/MuData/SpatialData, scanpy, scvi-tools, squidpy, muon, scirpy, rapids-singlecell, and R interoperability. Also for citing the literature behind a recommendation.
---

# Single-cell best practices

This skill holds the full text of the online book [Single-cell best practices](https://www.sc-best-practices.org/)
(Heumos, Schaar et al., *Nature Reviews Genetics* 2023, https://doi.org/10.1038/s41576-023-00586-w),
converted to Markdown: one file per chapter under `references/`, each with its code, figure links and
bibliography.

## How to use it

- Find the chapter in the index below and read that file. Do not load several large chapters at once:
  grep across `references/` for a tool, function or term first (for example
  `grep -rn "scDblFinder" references/`), then read the parts that matter.
- Base recommendations on what the chapter says, and cite it. Each in-text citation looks like
  `(Zappia & Theis, 2021 [1])`, where `[1]` is the number in that file's `## References` list at the
  end. The numbers are per chapter. When citing, give the full reference with its DOI or URL, plus
  the chapter's `Source:` URL.
- Each chapter begins with its key takeaways (repeated below) and a conda `environment.yml`
  listing the exact package versions its code was run with.
- Code cells are as in the book. Text outputs are kept, cut to 25 lines. Plots and HTML tables are
  left out; figures are links to images on sc-best-practices.org.
- Links between files are relative. Terms link to `references/glossary.md`.

## Data and notebooks

The book's datasets and notebooks are stored in the public lamindb instance
[theislab/sc-best-practices](https://lamin.ai/theislab/sc-best-practices). The chapters load data from it:

```python
# pip install lamindb
import lamindb as ln

ln.Artifact.connect("theislab/sc-best-practices").df()  # list up to 100 stored datasets
af = ln.Artifact.connect("theislab/sc-best-practices").get(key="key_of_dataset", is_latest=True)
obj = af.load()
```

Notebooks are listed on the [Transforms page](https://lamin.ai/theislab/sc-best-practices/transforms)
and are downloaded with `lamin load <notebook url>`.

## Index


### Introduction

- [Prior art](references/introduction/prior-art.md) (6k chars, 5 refs)
- [Fundamental data structures and frameworks](references/introduction/fundamental-data-structures-and-frameworks.md) (33k chars, 12 refs)
  - Three major ecosystems exist for single-cell analysis: R-based Bioconductor and Seurat, and Python-based scverse.
  - While all ecosystems are widely used, scverse is preferred for scalability (handling 500k+ cells) and strong interoperability with Python’s data and machine learning tools.
  - AnnData is the core data structure of scverse. It stores the count matrix in `.X` (cells × genes), with cell and gene annotations in `.obs` and `.var`.
  - AnnData is designed for memory efficiency. It supports sparse matrices, backed reading of large files, and view-based subsetting that avoids allocating new memory unless explicitly copied with `.copy()`.
  - Scanpy is the primary analysis framework built on AnnData. It provides a modular API (`sc.pp` for preprocessing, `sc.tl` for tools, `sc.pl` for plotting) covering the full workflow from basic quality control to dimensionality reduction and the many advanced analyses explored in later chapters.
- [Multimodal data structures](references/introduction/advanced-data-structures-and-frameworks.md) (25k chars, 5 refs)
  - Modern single-cell experiments often measure multiple modalities (e.g., RNA, ATAC, proteins) at the same time. While AnnData is designed for unimodal data, multimodal experiments require containers such as MuData that organize multiple datasets together.
  - A MuData object stores several AnnData objects (one per modality) while sharing global annotations for cells and features. This structure allows both modality-specific analyses and joint multimodal computations within the same dataset.
  - The framework muon extends the analysis ecosystem by providing preprocessing and analysis tools for modalities beyond RNA, such as ATAC or protein data. It also includes methods that integrate information across multiple modalities.
- [Single-cell RNA sequencing](references/introduction/scrna-seq.md) (58k chars, 44 refs)
  - Sequencing evolved from **Sanger sequencing** to **high-throughput NGS** to **long-read real-time sequencing**, which is also called first-, second-, and third-generation sequencing.
  - ScRNA-Seq allows for the analysis of gene expression **at the individual cell level**, uncovering cellular heterogeneity and rare cell types that are often masked in bulk RNA-Seq.
  - In scRNA-Seq, transcript quantification converts the raw data into a table of estimated transcript counts per cell. **Full-length** protocols capture entire transcripts. **Tag-based** protocols sequence either the transcripts’ 3’ or 5’ ends.
  - Transcription takes place in **stochastic bursts** and leads to a total of **100,000 to 1,000,000 mRNA** molecules in a typical mammalian cell.
  - We categorize scRNA-seq techniques into two broad classes based on cell isolation into **droplets** (aqueous bubbles) or **physical compartments** (e.g. wells).
- [Raw data processing](references/introduction/raw-data-processing.md) (99k chars, 49 refs)
  - Accurate raw data processing transforms FASTQ files into a count matrix, enabling reliable single-cell sequencing analyses through read alignment, barcode correction, and UMI counting.

### Preprocessing and visualization

- [Quality Control](references/preprocessing-visualization/quality-control.md) (41k chars, 7 refs)
  - Filtering of poor-quality cells should be based on median absolute deviations with lenient cutoffs to avoid bias against smaller subpopulations.
  - Feature-based filtering does not show benefits for downstream tasks.
  - Doublets can be efficiently detected with tools like scDblFinder.
  - Doublet detection methods should not be run on aggregated scRNA-seq data representing multiple batches.
- [Normalization](references/preprocessing-visualization/normalization.md) (20k chars, 5 refs)
  - Normalization techniques like the shifted logarithm, scran, and analytic Pearson residuals are essential for adjusting single-cell RNA-seq data to account for technical variability and improve downstream analysis.
- [Feature selection](references/preprocessing-visualization/feature-selection.md) (13k chars, 2 refs)
  - Feature selection in single-cell RNA-seq data focuses on identifying the most informative genes by using methods like deviance, which avoids biases from arbitrary normalization choices.
- [Dimensionality Reduction](references/preprocessing-visualization/dimensionality-reduction.md) (20k chars, 7 refs)
  - PCA is a linear dimensionality reduction technique that creates uncorrelated principal components ranked by variance, making it interpretable and efficient but less suitable for visualizing highly non-linear scRNA-seq data.
  - UMAP is a non-linear method that constructs and optimizes graph representations to preserve the local data structure, making it highly effective for visualization and clustering of single-cell data.
  - Cluster sizes and distances between clusters in t-SNE and UMAP plots carry little meaning, and their arrangement changes with the initialization.

### Identifying cellular structure

- [Clustering](references/cellular-structure/clustering.md) (14k chars, 7 refs)
  - Use Leiden community detection on a single-cell KNN graph.
  - Sub-clustering with different resolution parameters allows the user to focus on more detailed substructures in the dataset to potentially identify finer cell states.
- [Annotation](references/cellular-structure/annotation.md) (66k chars, 26 refs)
  - Cell annotation is the process of labeling groups of cells based on known or unknown cellular phenotypes, which is crucial for understanding the cellular composition of your data.
  - Manual annotation relies on known marker genes and clustering, but it can be subjective and labor-intensive.
  - Automated annotation methods, such as CellTypist and scArches-based reference mapping (using cellmapper for label transfer), offer faster and more scalable alternatives, but their accuracy depends on the quality of the reference data and the similarity between the reference and the query dataset.
- [Data integration](references/cellular-structure/integration.md) (85k chars, 30 refs)
  - Visualize your data before attempting to correct for batch effects to assess the extent of the issue. Batch effect correction is not always required and it might mask the biological variation of interest.
  - If cell labels are available and biological variation is the most important, the usage of methods that can use these labels (such as scANVI) is advised.
  - Consider running several integration methods on your dataset and evaluating them with the **scIB** metrics to use the integration that is most robust for your use case.

### Inferring trajectories

- [Pseudotemporal ordering](references/trajectories/pseudotemporal.md) (23k chars, 29 refs)
  - Trajectory inference methods require the start of the biological process to be known (approximately).
  - The nature of the biological process defines which TI algorithms can be used. `dynguidelines` helps selecting the appropriate TI method.
- [RNA velocity](references/trajectories/rna-velocity.md) (23k chars, 18 refs)
  - To infer RNA velocity, the time scale of the developmental process under investigation must be comparable to the half-life of RNA molecules. This requirement is, for example, met in pancreatic endocrinogenesis but not in long term diseases such as Alzheimer’s or Parkinson’s disease. Similarly, RNA velocity analysis is not applicable to steady-state systems such as peripheral blood mononuclear cells lacking any transitions between (mature) cell types.
  - RNA velocity can only be inferred robustly and reliantly if the underlying model assumptions (approximately) hold true. To check the assumptions, the phase portraits can be studied to verify that they exhibit the expected almond shape. If a gene includes multiple, pronounced kinetics, RNA velocity analysis should be applied with caution and the data possibly subsetted to individual lineages.
  - Classically, the high-dimensional RNA velocity vectors have been visualized by projecting them onto a low-dimensional representation of the data. This approach for verifying hypotheses can be erronous and misleading as the projected velocity stream is highly dependent on (1) the number of included genes and (2) chosen plotting parameters. Additionally, the projection quality decreases at the boundary of the low dimensional embedding.
- [Lineage tracing](references/trajectories/lineage-tracing.md) (66k chars, 56 refs)
  - Remember, the **resolution of experimental data** is still limited. **Statistical analysis** and **assessment of the quality** of lineage information shall be performed in order to identify individuals for which lineage reconstruction can be applied. As demonstrated below there are dedicated tools which easily provide the relevant statistics.
  - Often it is difficult to presume **which algorithm** will perform best for reconstruction, and even algorithms with good performances might highlight different part of lineages. It is recommended that you **apply a few algorithms** for reconstruction for comparisons.
  - As with any analysis without a certain ground truth, any **conclusions must be carefully drawn**. First and foremost, it is always good practice to visualize lineages along with the indel heatmap to verify that no obvious reconstruction errors were made (see the section entitled “Reconstructing the lineage” for more tips on how to evaluate reconstruction accuracy by eye). Additionally, an effective strategy for drawing stronger conclusions is to compare downstream analyses on the same lineage inferred with different algorithms. Of course, as with most matters concerning computational conclusions, we often suggest that conclusions are validated in an experimental system.

### Dealing with conditions

- [Differential gene expression analysis](references/conditions/differential-gene-expression.md) (43k chars, 21 refs)
  - In scRNA-seq, there are two main approaches to identify differentially expressed genes: the sample-level view and the cell-level view. The sample-level approach has been shown to outperform the cell-level approach for scRNA-seq data.
  - In the sample-level view, a pseudobulk sample is created for each patient and cell type by aggregating counts (e.g., summing across cells). These pseudobulk profiles can then be analyzed using tools such as edgeR or DESeq2, which were originally developed for bulk RNA-seq data.
  - Explore your data before modeling. Performing PCA on pseudobulk samples can reveal major sources of variation that should be accounted for in your design matrix.
  - Remove lowly expressed genes separately for each cell type, as different cell populations express distinct gene sets.
  - If your dataset contains different subgroups, construct a design matrix that includes all relevant covariates. You can then define contrasts to test the specific comparisons of interest.
- [Compositional analysis](references/conditions/compositional.md) (69k chars, 17 refs)
  - Single-cell cell type proportions are compositional: increasing one cell type necessarily changes the relative abundances of the others. Ignoring this constraint can lead to spurious differential abundance signals.
  - If the primary interest lies in compositional changes among known cell-types or states, use scCODA or tascCODA to statistically evaluate changes in abundance.
  - KNN based methods like DA-Seq or MILO should be used if the data does not cluster distinctly, such as during developmental processes, if we are interested in differences in cell abundances that might appear in transitional states between cell types or in a specific subset of cells of a given cell type.
  - scCODA and tascCODA uses a reference cell type and estimates changes relative to that population. The reference cell type should remain stable across conditions.
  - A good experimental design simplifies downstream analysis. Use sufficient biological replicates and distribute samples from each condition across batches.
- [Gene set enrichment and pathway analysis](references/conditions/gsea-pathway.md) (56k chars, 44 refs)
  - Enrichment analysis needs three inputs (molecular readouts, prior knowledge, and an inference method) and can be run at the single-cell or population level.
  - Gene sets assume expression reflects protein activity. Footprints use signed, weighted genes reflecting downstream regulatory effects, making them closer to transcriptomics data.
  - Filter out gene sets with too few members, typically fewer than 10-15 genes, and normalize your data properly before running enrichment.
  - Competitive tests are generally preferred over self-contained tests, as they rely on a single gene-level statistic and are more stable across samples.
  - Enrichment results are more sensitive to the choice of gene sets than to the choice of statistical method, so try multiple resources and compare results for concordance.
- [Perturbation modeling](references/conditions/perturbation-modeling.md) (23k chars, 17 refs)
  - Pooled CRISPR screens with single-cell readouts measure the transcriptional effects of many genetic perturbations in one experiment, starting from the assignment of guides to cells.
  - Perturbations fail in many cells, so perturbed cells should be identified, for example with Mixscape, and differential expression should be tested on pseudobulks of replicates.
  - The E-distance and E-test quantify and test the effect of each perturbation, and clustering perturbations by their effects recovers complexes and pathways.

### Modeling mechanisms

- [Gene regulatory networks](references/mechanisms/gene-regulatory-networks.md) (15k chars, 9 refs)
  - Gene regulatory networks describe which transcription factors activate or repress which target genes, and the targets of a transcription factor form its regulon.
  - Networks inferred from expression alone recover few known interactions, so estimating transcription factor activities from a prior-knowledge network such as CollecTRI is the more robust default.
- [Cell-cell communication](references/mechanisms/cell-cell-communication.md) (35k chars, 26 refs)
  - Cell-cell communication (CCC) inference from single-cell transcriptomics data relies on the assumption that gene expression is a proxy for protein abundance and intercellular interactions.
  - Ligand-receptor inference methods and intracellular signaling models (e.g., NicheNet) are complementary approaches for understanding CCC.
  - The Ligand-receptor database and the measurements of different tools are key for the cell-cell communication inference

### Deconvolution

- [Bulk deconvolution](references/deconvolution/bulk-deconvolution.md) (32k chars, 23 refs)
  - Use unbiased reference data with no missing cell type.
  - Normalize the reference data using library size normalization.
  - Feature selection prior deconvolution improves the accuracy of the results particularly for linear deconvolution methods.
  - Deconvolution is a challenging task (see limitations and traps). Therefore, we recommend the users to try more than one deconvolution method and select one after assessing the results biologically.

### Chromatin accessibility (scATAC-seq)

- [Single-cell ATAC sequencing](references/chromatin-accessibility/introduction.md) (8k chars, 11 refs)
  - Chromatin accessibility reflects the combined regulatory state of a cell and is an orthogonal layer of information on cell identity to gene expression.
  - scATAC-seq data are sparse and have no predefined features, so fragments are counted in peaks or genomic tiles. Counts should be kept instead of binarized, and fragments or insertions should be counted instead of reads.
  - SnapATAC2 was among the most accurate and the fastest scATAC-seq frameworks in a recent benchmark.
- [Quality control](references/chromatin-accessibility/quality-control.md) (11k chars, 6 refs)
  - Quality control of scATAC-seq data starts from the fragment file, which records every fragment that the Tn5 transposase cut out of accessible chromatin in each cell.
  - The number of fragments and the TSS enrichment are the most informative quality metrics. Their thresholds depend on protocol and sequencing depth and should be chosen from their joint distribution.
  - Simulation-based doublet detection finds doublets of different cell types, and counting positions covered by more than two fragments finds the rest.
- [Dimensionality reduction and clustering](references/chromatin-accessibility/dimensionality-reduction-clustering.md) (9k chars, 4 refs)
  - Fragments are counted in fixed-width genomic tiles, which require no peak calling and cluster cells as well as peaks. Counts are kept instead of binarized.
  - Spectral embedding separates cell types better than LSI, whose components remain correlated with the number of fragments per cell.
  - Gene activity scores estimated from the accessibility of genes help to annotate clusters, but every cell type should be supported by several markers.
- [Peak calling and motif analysis](references/chromatin-accessibility/peaks-motifs.md) (9k chars, 5 refs)
  - Peaks are called separately for each cell type and merged into one set of fixed-width peaks, so that rare cell types contribute their own peaks.
  - Cell type-specific peaks can be selected quickly by comparing pooled accessibility, whereas significance requires a statistical test.
  - Motifs enriched in the specific peaks of a cell type point to the transcription factors that regulate it.
- [Gene regulatory networks](references/chromatin-accessibility/gene-regulatory-networks-atac.md) (12k chars, 6 refs)
  - Multiome data allow regions to be linked to genes and TFs to regions in the same cells, but the resulting networks are hypotheses that differ between methods.
  - Region-gene links combine genomic proximity with the correlation of accessibility and expression, and TF-region links require a binding motif.
  - Only a small fraction of inferred links is supported by prior knowledge, so networks need validation, ideally by perturbing the TFs.

### Spatial omics

- [Single-cell data resolved in space](references/spatial/introduction.md) (6k chars, 3 refs)
  - Spatially resolved genomics technologies enable the measurement of genome-scale omics data while preserving spatial context, offering multi-cell, single-cell, and sub-cellular resolution to address diverse biological questions.
- [Spatial data structures](references/spatial/data-structures.md) (17k chars, 2 refs)
  - Spatial omics technologies measure molecular data while preserving spatial context within tissues. The data structure SpatialData stores images, coordinates, geometries, and molecular measurements in a unified data structure.
  - Squidpy combines molecular profiles with spatial context, providing tools for both analysis and visualization. Built on Scanpy and AnnData, it retains modularity and scalability.
- [Neighborhood analysis](references/spatial/neighborhood.md) (12k chars, 3 refs)
  - Spatial statistics and neighborhood analysis can be a good first starting point for analyzing spatial omics data.
  - Analysis tools like Squidpy provide several spatial statistics that help to understand the neighborhood structure in spatial omics datasets.
- [Spatial domains](references/spatial/domains.md) (21k chars, 6 refs)
  - Spatial domains are clusters that both reflecting similarity of spots or cells in terms of gene expression as well as spatial proximity.
  - Methods for identifying spatial domains can also incorporate the histological information available through spatial omics technologies.
  - We presented how to identify spatial domains in Squidpy by combining the nearest neighbor graph and the spatial proximity graph, as well as the usage of SpaGCN.
- [Spatially variable genes](references/spatial/spatially-variable-genes.md) (13k chars, 9 refs)
  - Spatially variable genes (SVGs) are genes that show a significant spatial pattern.
  - Methods designed for this task vary in complexity and model assumptions.
  - We recommend using multiple methods to identify SVGs and assess the result by plotting the gene’s expression in space.
- [Spatial deconvolution](references/spatial/deconvolution.md) (34k chars, 7 refs)
  - Reference based deconvolution methods can be used for increasing the resolution of spot-based spatial transcriptomics data.
  - Cell2location outperformed other approaches for cell type deconvolution, but requires more computational resources.
  - Alternative models are SpatialDWLS and RCTD which perform best in terms of the overall accuracy score.
- [Imputation](references/spatial/imputation.md) (21k chars, 5 refs)
  - Targeted in-situ technologies (such as MERFISH, smFISH, or seqFISH+) are limited in their gene throughput and typically only capture a few hundreds of preselected genes.
  - Imputation methods aim to increase the resolution with respect to genes and generating whole transcriptome resolved spatially resolved data at single-cell resolution.
  - Tangram outperformed other imputation methods in in terms of different accuracy metrics and scalability.
  - Running a validation step on the shared features and their expression levels can help to assess whether the imputation algorithm worked well.

### Surface protein (CITE-seq)

- [Quality control](references/surface-protein/quality-control.md) (21k chars, 9 refs)
  - Single-cell surface protein measurements complement RNA-seq data, improving cell type identification and revealing treatment effects not visible at the transcript level. Quality control of the ADT (surface protein) data removes cells with too few or too protein counts.
- [Normalization](references/surface-protein/normalization.md) (16k chars, 3 refs)
  - ADT data in CITE-seq requires normalization methods like CLR or dsb to remove noise, with dsb removing ambient and technical noise by using information from empty droplets and isotype controls.
- [Doublet detection](references/surface-protein/doublet-detection.md) (7k chars, 1 refs)
  - Heterotypic doublets in ADT data can be identified and removed using mutually exclusive cell type markers (e.g., CD3, CD19, CD14), with cells expressing both markers likely representing doublets.
- [Dimensionality Reduction](references/surface-protein/dimensionality-reduction.md) (9k chars)
  - Use UMAP for ADT data visualization; PCA can help reduce dimensionality in large datasets with many surface proteins.
- [Batch correction](references/surface-protein/batch-correction.md) (7k chars, 3 refs)
  - Due to pronounced batch effects in ADT data, methods like Harmony, originally designed for transcriptomics data, are recommended for batch correction, as they effectively integrate samples and maintain cell type separation.
- [Annotation](references/surface-protein/annotation.md) (9k chars, 1 refs)
  - ADT data annotation improves cell identification, especially for immune cells, by complementing RNA data with surface protein markers.

### Adaptive immune receptor repertoire

- [Immune receptor profiling](references/air-repertoire/ir-profiling.md) (16k chars, 13 refs)
  - T and B cells recognize antigens with receptors whose diversity arises from V(D)J recombination, and the CDR3 at the junction of the gene segments is their most diverse part.
  - Droplet-based V(D)J libraries are assembled with Cell Ranger, and BCRs should be re-annotated with IgBLAST to reconstruct germline sequences.
  - Cells with more than two chains of a type or with both TCR and BCR chains are likely doublets, and the receptor type should agree with the transcriptomic cell type.
- [Clonotype analysis](references/air-repertoire/clonotype.md) (14k chars, 7 refs)
  - Clonotypes group cells that descend from the same lymphocyte, and their expansion reveals which cells responded to an antigen.
  - The number of clonotypes depends on the number of sampled cells, so repertoires are better compared by evenness, which varies strongly between donors.
  - B cell clonotypes are defined by similar junctions with the same V and J genes, since somatic hypermutation changes the receptors within a clone.
- [Specificity analysis](references/air-repertoire/specificity.md) (17k chars, 12 refs)
  - Specificity is determined mainly by the CDR3 sequences and V genes, and can be inferred from databases, sequence similarity or machine learning models.
  - TCRdist finds more database matches than exact matching, but the sequence definitions and gene names of both sides have to agree.
  - Many database matches are coincidental, which the paired gene expression reveals, and predictions for unseen epitopes are close to random.
- [Integrating AIR and transcriptomics](references/air-repertoire/multimodal-integration.md) (9k chars, 6 refs)
  - Paired receptor and gene expression data link the clonal history and specificity of cells to their state.
  - Clonotype modularity identifies clonotypes whose cells share a transcriptional state.
  - Joint embeddings of receptors and gene expression have not been independently benchmarked and should be used to generate hypotheses.

### Multimodal integration

- [Paired integration](references/multimodal-integration/paired-integration.md) (20k chars, 12 refs)
  - Paired integration combines modalities measured in the same cells into one representation, and no method is best for every dataset.
  - Integrated embeddings should be scored against the unimodal embeddings with metrics for cell type conservation and batch mixing.
  - WNN is a strong baseline for CITE-seq and Multiome data, and totalVI and MultiVI additionally model raw counts and batch effects.
- [Advanced integration](references/multimodal-integration/advanced-integration.md) (22k chars, 10 refs)
  - Unpaired, reference and mosaic integration combine modalities that were not measured in the same cells, and GLUE is the most accurate method for unpaired RNA and ATAC data.
  - Multimodal references let unimodal queries borrow the missing modality, but imputed values are only reliable for well-measured features.
  - MultiVI integrates datasets that share only some modalities, and results should be checked against held-out measurements.

### Introduction

- [Interoperability](references/introduction/interoperability.md) (41k chars)
  - Interoperabilty between languages allows analysts to take advantage of the strengths of different ecosystems.
  - On-disk interoperability uses standard file formats to transfer data and is typically more reliable.
  - In-memory interoperabilty transfers data directly between parallel sessions and is convenient for interactive analysis.
  - While interoperability is currently possible developers continue to improve the experience.
- [GPU-accelerated analysis](references/introduction/rapids-singlecell.md) (29k chars, 7 refs)
  - rapids-singlecell mirrors the scanpy API on the GPU, so most preprocessing and clustering pipelines can be ported by swapping `sc` for `rsc` and moving the AnnData with `rsc.get.anndata_to_GPU`.
  - Pick exactly one allocator strategy: a pool allocator if the data fits in VRAM, or managed (unified) memory if it does not. Mixing both fragments memory and erodes the speedup.
  - Move data back to host memory with `rsc.get.anndata_to_CPU` once a step no longer needs the GPU, free intermediate CuPy arrays, and call `cp.get_default_memory_pool().free_all_blocks()` to release VRAM you are no longer using.
  - For datasets that exceed a single GPU’s memory, combine `dask-cuda` with the `read_elem_lazy` AnnData reader to stream chunks through the GPU; expect occasional synchronization points (QC, HVG selection, scaling, PCA) that force evaluation.

### Front and back matter

- [Single-cell best practices](references/index.md) (10k chars, 3 refs)
- [Outlook](references/outlook.md) (6k chars, 9 refs)
- [Acknowledgements](references/acknowledgements.md) (1k chars)
- [Glossary](references/glossary.md) (20k chars)
- [Changelog](references/changelog.md) (21k chars)

## Source and license

Converted on 2026-11-01 from https://www.sc-best-practices.org/ (MyST page data, `myst.xref.json`).
Source repository: https://github.com/theislab/single-cell-best-practices, licensed under the
Apache License 2.0, Copyright 2021 Theislab. Chapter authors are named at the top of each file.
