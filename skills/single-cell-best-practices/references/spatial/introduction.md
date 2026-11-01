# Single-cell data resolved in space

Source: https://www.sc-best-practices.org/spatial/introduction  
Authors: Anna Schaar, Lukas Heumos

**🧠 Key takeaways**

- Spatially resolved genomics technologies enable the measurement of genome-scale omics data while preserving spatial context, offering multi-cell, single-cell, and sub-cellular resolution to address diverse biological questions.

## Motivation

Bulk and single-cell genomic technologies enabled us to characterize and understand cellular identities and their dependencies on genome scale. Up to this point, all single-cell technologies described in this work characterized dissociated cells that were removed from the sample of interest. However, by removing the spatial context of the cells and their molecules, one also loses the spatial context which is an essential component for many biological questions. Spatially resolved genomics resolve this issue by measuring both genome-scale omics and preserving the spatial information.

## Overview of spatial profiling measurements

Spatially resolved genomics can be measured with various technologies that quantify the transcriptome, proteome or chromatin accessibility. However, these technologies vary in terms of scale, resolution, sensitivity, multiplexing and applicability. As the landscape of spatially resolved genomics is developing fast and is expected to change massively in the next few years, we are introducing only three overall groups of spatial omics technologies based on their capturing resolution. Additional information can be obtained through the linked reviews and papers following this introduction. (Moffitt *et al.*, 2022 [1]) (Walker *et al.*, 2022 [2]) (Yue *et al.*, 2023 [3])

![Spatial Omics Resolutions Overview](https://www.sc-best-practices.org/build/introduction_1-773539d053fd40223b628bfed600af92.jpeg)

*Figure 1: Spatially resolved genomics data varies in resolution from multi-cell, single-cell to sub-cellular resolution.*

Broadly spoken, one can differentiate spatially resolved genomics into technologies that measure at multi-cell, single-cell and sub-cellular resolution. We will shortly motivate each of those scales and highlight their advantages and challenges and introduce the reader to a few technologies that fall into the respective category.

### Multi-cell resolution

Spatial omics data obtained at multi-cell resolution typically captures omics measurements among several cells. So, each datapoint contains information from a varying number of cells and also potentially different cell types. Multi-cell resolution data can be decomposed with deconvolution methods to obtain proportions of different cells or cell types per spot.

Multi-cell resolution data typically capture transcriptome-wide gene expression profiles at varying resolution. The obtained resolution for spot-based technologies varies between 55um (Visium) to 10 um (slide-seq). A widely known, commercially available and successful technology is Visium provided by 10x Genomics. We will showcase how to analyze and deconvolve Visium data in the tutorials.

### Single-cell resolution

Spatial omics data obtained at single-cell resolution either directly capture single cells at their exact position or capture spots on the scale of single-cell. Examples for spot-based methods are HDST, slide-seqV2 or stereo-seq. These methods capture the whole transcriptome but still have a low capture efficiency.

Targeted methods provide an alternative for measuring cells at their exact position. Common examples are MERFISH, seqFISH+, IMC or multiplexed IHC (e.g. cyCIF and CODEX). These technologies are usually expensive and only measure a limited features space. These methods do not capture spots at a predefined location or grid, but measure individual transcript or cellular locations.

### Sub-cellular resolution

Spatial omics data at sub-cellular resolution captures the position of individual RNA molecules. Those positions can either be captured through single-molecule imaging or via spatial barcoding with spot-sizes smaller than single-cells. By performing cell segmentation on sub-cellular data one can obtain single-cell resolution data where expression is aggregated to cell-wise measurements which than can be processed in spatially-aware analysis pipelines. We will show how to perform this analysis for a MERFISH dataset.

### Recommended reading

To get a more elaborate understanding of the differences between the spatial experimental assays we recommend the following papers:

- The emerging landscape of spatial profiling technologies (Moffitt *et al.*, 2022 [1])
- Deciphering tissue structure and function using spatial transcriptomics (Walker *et al.*, 2022 [2])
- A guidebook of spatial transcriptomic technologies, data resources and analysis approaches (Yue *et al.*, 2023 [3])

## Contributors

### Authors

- Anna Schaar

### Reviewers

- Lukas Heumos

## References

1. Moffitt, J. R., Lundberg, E., & Heyn, H. (2022). The emerging landscape of spatial profiling technologies. *Nature Reviews Genetics*, *23*(12), 741–759. https://doi.org/10.1038/s41576-022-00515-3
2. Walker, B. L., Cang, Z., Ren, H., Bourgain-Chang, E., & Nie, Q. (2022). Deciphering tissue structure and function using spatial transcriptomics. *Communications Biology*, *5*(1), 220. https://doi.org/10.1038/s42003-022-03175-5
3. Yue, L., Liu, F., Hu, J., Yang, P., Wang, Y., Dong, J., Shu, W., Huang, X., & Wang, S. (2023). A guidebook of spatial transcriptomic technologies, data resources and analysis approaches. *Computational and Structural Biotechnology Journal*, *21*, 940–955. https://doi.org/10.1016/j.csbj.2023.01.016
