# Single-cell ATAC sequencing

Source: https://www.sc-best-practices.org/chromatin-accessibility/introduction  
Authors: Christopher Lance, Laura Martens, Lukas Heumos

**🧠 Key takeaways**

- Chromatin accessibility reflects the combined regulatory state of a cell and is an orthogonal layer of information on cell identity to gene expression.
- scATAC-seq data are sparse and have no predefined features, so fragments are counted in peaks or genomic tiles.
Counts should be kept instead of binarized, and fragments or insertions should be counted instead of reads.
- SnapATAC2 was among the most accurate and the fastest scATAC-seq frameworks in a recent benchmark.

## Motivation

Every cell of an organism carries the same genome, yet cells differ in which genes they express.
Gene expression is controlled by DNA methylation, histone modifications and the binding of transcription factors, and [chromatin](../glossary.md#term-chromatin) accessibility reflects the combined regulatory state that results from them.
Accessibility is therefore an orthogonal layer of information on cell identity, and it points to the regulatory elements and transcription factors that control gene expression.

![Accessibility regulation](https://www.sc-best-practices.org/build/mechanisms_overview-a0768c85a6eb5d40ed9002319481ce1d.png)

*Figure 1: Overview of mechanisms influencing chromatin accessibility. Created with [BioRender.com](http://BioRender.com).*

Accessibility is shaped at several scales, from the attachment of chromatin to the nuclear periphery (Narwade *et al.*, 2019 [1]; Buchwalter *et al.*, 2019 [2]) over chromatin remodelers and histone modifications to transcription factors that displace nucleosomes and the methylation of [CpG](../glossary.md#term-cpg) sites.
For a review of how these mechanisms regulate the genome, we refer to Isbel *et al.* (2022) [3].

## Experimental assay

The Assay for Transposase-Accessible Chromatin with sequencing (ATAC-seq) uses the Tn5 transposase, which inserts sequencing adapters into accessible chromatin and thereby cuts it into fragments.
Only fragments flanked by two different adapters are amplified, sequenced paired-end and aligned to the genome.
In single-cell protocols such as 10x scATAC-seq, the transposition is performed on isolated nuclei in bulk before each nucleus is barcoded in a droplet.
The 10x Multiome assay additionally barcodes the RNA of each nucleus, which measures chromatin accessibility and gene expression in the same cells.
Nuclei are profiled instead of whole cells, so the RNA part of Multiome data measures nuclear transcripts.

## Data characteristics

Accessibility is measured across the whole genome, including non-coding regions, so there are no predefined features like genes in scRNA-seq.
Fragments are counted either in regions of high accessibility, called peaks, or in fixed-width tiles across the genome, which do not require peaks to be called first and cluster cells equally well (Luo *et al.*, 2024 [4]).

A diploid cell has only two copies of each position, and only 1-10% of accessible regions are detected per cell, which makes the data very sparse (Chen *et al.*, 2019 [5]).
Many methods therefore binarize counts, but treating counts quantitatively improves model fit, clustering, cell type identification and batch integration (Martens *et al.*, 2024 [6]).
Counting reads counts a fragment twice if both of its ends fall into a region but once otherwise, so fragments or pairs of insertions should be counted instead (Martens *et al.*, 2024 [6]; Miao & Kim, 2024 [7]).

## Analysis workflow

The main frameworks for scATAC-seq analysis are ArchR (Granja *et al.*, 2021 [8]) and Signac (Stuart *et al.*, 2021 [9]) in R, and SnapATAC2 (Zhang *et al.*, 2024 [10]) in Python.
In a benchmark of these pipelines, SnapATAC2 was among the best at separating cell types, particularly in datasets with complex cell type structures, and it was the fastest, which makes it our choice for this section (Luo *et al.*, 2024 [4]).
Multimodal data such as Multiome can be stored as MuData objects and analyzed with muon (Bredikhin *et al.*, 2022 [11]), as introduced in the [chapter on multimodal data structures](../introduction/advanced-data-structures-and-frameworks.md).

The following chapters analyze the chromatin accessibility of about 10,000 PBMCs measured with the 10x Multiome assay, from [quality control](../chromatin-accessibility/quality-control.md) over [dimensionality reduction and clustering](../chromatin-accessibility/dimensionality-reduction-clustering.md) and [peak calling and motif analysis](../chromatin-accessibility/peaks-motifs.md) to [gene regulatory networks](../chromatin-accessibility/gene-regulatory-networks-atac.md) that combine accessibility and expression.

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Christopher Lance
- Laura Martens

### Reviewers

- Lukas Heumos

## References

1. Narwade, N., Patel, S., Alam, A., Chattopadhyay, S., Mittal, S., & Kulkarni, A. (2019). Mapping of scaffold/matrix attachment regions in human genome: a data mining exercise. *Nucleic Acids Research*, *47*(14), 7247–7261. https://doi.org/10.1093/nar/gkz562
2. Buchwalter, A., Kaneshiro, J. M., & Hetzer, M. W. (2019). Coaching from the sidelines: the nuclear periphery in genome regulation. *Nature Reviews Genetics*, *20*(1), 39–50. https://doi.org/10.1038/s41576-018-0063-5
3. Isbel, L., Grand, R. S., & Schübeler, D. (2022). Generating specificity in genome regulation through transcription factor sensitivity to chromatin. *Nature Reviews. Genetics*, *23*(12), 728–740. https://doi.org/10.1038/s41576-022-00512-6
4. Luo, S., Germain, P.-L., Robinson, M. D., & von Meyenn, F. (2024). Benchmarking computational methods for single-cell chromatin data analysis. *Genome Biology*, *25*(1), 225. https://doi.org/10.1186/s13059-024-03356-x
5. Chen, H., Lareau, C., Andreani, T., Vinyard, M. E., Garcia, S. P., Clement, K., Andrade-Navarro, M. A., Buenrostro, J. D., & Pinello, L. (2019). Assessment of computational methods for the analysis of single-cell ATAC-seq data. *Genome Biology*, *20*(1), 241. https://doi.org/10.1186/s13059-019-1854-5
6. Martens, L. D., Fischer, D. S., Yépez, V. A., Theis, F. J., & Gagneur, J. (2024). Modeling fragment counts improves single-cell ATAC-seq analysis. *Nature Methods*, *21*(1), 28–31. https://doi.org/10.1038/s41592-023-02112-6
7. Miao, Z., & Kim, J. (2024). Uniform quantification of single-nucleus ATAC-seq data with Paired-Insertion Counting (PIC) and a model-based insertion rate estimator. *Nature Methods*, *21*(1), 32–36. https://doi.org/10.1038/s41592-023-02103-7
8. Granja, J. M., Corces, M. R., Pierce, S. E., Bagdatli, S. T., Choudhry, H., Chang, H. Y., & Greenleaf, W. J. (2021). ArchR is a scalable software package for integrative single-cell chromatin accessibility analysis. *Nature Genetics*, *53*(3), 403–411. https://doi.org/10.1038/s41588-021-00790-6
9. Stuart, T., Srivastava, A., Madad, S., Lareau, C. A., & Satija, R. (2021). Single-cell chromatin state analysis with Signac. *Nature Methods*, *18*(11), 1333–1341. https://doi.org/10.1038/s41592-021-01282-5
10. Zhang, K., Zemke, N. R., Armand, E. J., & Ren, B. (2024). A fast, scalable and versatile tool for analysis of single-cell omics data. *Nature Methods*, *21*(2), 217–227. https://doi.org/10.1038/s41592-023-02139-9
11. Bredikhin, D., Kats, I., & Stegle, O. (2022). MUON: multimodal omics analysis framework. *Genome Biology*, *23*(1), 42. https://doi.org/10.1186/s13059-021-02577-8
