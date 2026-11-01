# Prior art

Source: https://www.sc-best-practices.org/introduction/prior-art  
Authors: Lukas Heumos, Anna Schaar, single-cell best practices consortium

Single-cell analysis has evolved from a niche area of interest into a well-established field of study.
As a result, we are certainly not the first to produce a book on this subject, nor to provide guides and tutorials.
In the sections that follow, we review two notable and ongoing initiatives aimed at teaching single-cell analysis, highlighting both their similarities to and differences from this book.

## Bioconductor OSCA and OSTA books

Orchestrating Single-Cell Analysis with Bioconductor (Bioconductor OSCA) (Amezquita *et al.*, 2022 [1]), available online at [https://​bioconductor​.org​/books​/release​/OSCA/](https://bioconductor.org/books/release/OSCA/), is an online book designed to teach common workflows for analyzing of single-cell [RNA](../glossary.md#term-rna)-[Sequencing](../glossary.md#term-sequencing) (scRNA-seq) data using the R based Bioconductor ecosystem (Huber *et al.*, 2015 [2]).
An accompanying paper with the same title (Amezquita *et al.*, 2020 [3])provides an overview of single-cell analysis with Bioconductor, while the online book offers more in-depth coverage, featuring detailed explanations and extensive code examples.

The OSCA book is highly comprehensive in its treatment of basic scRNA-seq analysis, offering clear explanations and detailed workflow examples.
However, it does not extend to other single-cell omics, such as single-cell ATAC-seq (scATAC-seq).
Spatial transcriptomics is addressed separately in the complementary book Orchestrating Spatially-Resolved Transcriptomics Analysis with Bioconductor (Bioconductor OSTA), available at [https://​lmweber​.org​/OSTA/](https://lmweber.org/OSTA/).

As both books are tailored to the Bioconductor ecosystem, they exclusively use tools available within Bioconductor.
While these tools are highly effective, they may not always provide the most optimal solution for every analysis, as acknowledged by the books themselves.
Overall, the Bioconductor books are particularly well-suited for individuals with a foundational knowledge of R and a strong background in biology who wish to learn how to analyze single-cell and spatial transcriptomics data within the Bioconductor framework.

## Current best practices in single-cell RNA-seq analysis: a tutorial

Current Best Practices in Single-Cell [RNA](../glossary.md#term-rna)-Seq Analysis: A Tutorial (Luecken & Theis, 2019 [4]) by Malte Lücken and Fabian Theis introduces best practices for scRNA-seq analysis.
Its key contribution lies in not only reviewing potential analysis steps but also recommending best practices based on independent benchmarks.
When specific best-practice guidelines are unavailable, the authors provide general recommendations for analysis approaches.
The fundamental idea of focusing on independent benchmarks inspired our work substantially.
The paper is complemented by an [example analysis of mouse intestinal epithelium regions](https://github.com/theislab/single-cell-tutorial/) from Haber et al. (Haber *et al.*, 2017 [5]).

In comparison to Bioconductor OSCA, this paper and its associated analysis are not constrained by a specific tool ecosystem, offering a broader perspective on the range of topics covered.
However, the accompanying example analysis lacks beginner-friendliness and has become outdated.
Analogously to Bioconductor OSCA, Lücken & Theis do not address newer developments such as RNA velocity, spatial transcriptomics, or multi-omics.

Despite these limitations, we highly recommend this paper as a valuable introduction to the field and as a guide to initial best practices in scRNA-seq analysis.
The chapters in this book build on the latest best practices, offering an updated perspective on the field. Furthermore, the workflows in this book are explained in greater detail, providing readers with the background information necessary to effectively apply the methods.
We advise against relying on the example case study provided with the paper and instead encourage readers to explore the detailed chapters in this book for a more comprehensive and up to date understanding.

## References

1. Amezquita, R., Lun, A., Hicks, S., & Raphael, G. (2022). *Orchestrating Single-Cell Analysis with Bioconductor*. https://bioconductor.org/books/release/OSCA/
2. Huber, W., Carey, V. J., Gentleman, R., Anders, S., Carlson, M., Carvalho, B. S., Bravo, H. C., Davis, S., Gatto, L., Girke, T., Gottardo, R., Hahne, F., Hansen, K. D., Irizarry, R. A., Lawrence, M., Love, M. I., MacDonald, J., Obenchain, V., Oleś, A. K., … Morgan, M. (2015). Orchestrating high-throughput genomic analysis with Bioconductor. *Nature Methods*, *12*(2), 115–121. https://doi.org/10.1038/nmeth.3252
3. Amezquita, R. A., Lun, A. T. L., Becht, E., Carey, V. J., Carpp, L. N., Geistlinger, L., Marini, F., Rue-Albrecht, K., Risso, D., Soneson, C., Waldron, L., Pagès, H., Smith, M. L., Huber, W., Morgan, M., Gottardo, R., & Hicks, S. C. (2020). Orchestrating single-cell analysis with Bioconductor. *Nature Methods*, *17*(2), 137–145. https://doi.org/10.1038/s41592-019-0654-x
4. Luecken, M. D., & Theis, F. J. (2019). Current best practices in single-cell RNA-seq analysis: a tutorial. *Molecular Systems Biology*, *15*(6), e8746. https://doi.org/10.15252/msb.20188746
5. Haber, A. L., Biton, M., Rogel, N., Herbst, R. H., Shekhar, K., Smillie, C., Burgin, G., Delorey, T. M., Howitt, M. R., Katz, Y., Tirosh, I., Beyaz, S., Dionne, D., Zhang, M., Raychowdhury, R., Garrett, W. S., Rozenblatt-Rosen, O., Shi, H. N., Yilmaz, O., … Regev, A. (2017). A single-cell survey of the small intestinal epithelium. *Nature*, *551*(7680), 333–339. https://doi.org/10.1038/nature24489
