# Outlook

Source: https://www.sc-best-practices.org/outlook  
Authors: Lukas Heumos, Anna Schaar, single-cell best practices consortium

Single-cell analysis has moved from a niche technology to a routine part of biology and medicine.
Datasets now span hundreds of millions of cells, models are pretrained on all of them, and software agents are starting to run analyses on their own.
None of this makes careful analysis less important; it raises the cost of getting it wrong.

## Benchmarking

New tools appear faster than anyone can evaluate them by hand.
Living benchmarks such as [Open Problems in Single-Cell Analysis](https://openproblems.bio/) (Luecken *et al.*, 2025 [1]) compare methods on shared datasets and metrics, and we will keep updating our recommendations as their results change.
Benchmarks are only as good as their metrics, so agreeing on what defines a good result for each task remains an open problem.

## Foundation models and virtual cells

Models pretrained on tens of millions of cells promise general cell representations that transfer to annotation, integration, and perturbation prediction.
The long-term goal is a virtual cell that predicts how any cell responds to any perturbation (Bunne *et al.*, 2024 [2]).
So far, careful evaluations show that these models often do not beat simple baselines, both for zero-shot embeddings (Kedzierska *et al.*, 2025 [3]) and for perturbation effect prediction (Ahlmann-Eltze *et al.*, 2025 [4]).
Until that changes, any foundation model should be compared against a simple baseline on the data at hand.

## Agentic analysis

Large language model agents can now plan an analysis, write the code, and run it (Huang *et al.*, 2025 [5]).
This lowers the barrier to single-cell analysis, but it does not remove the need to know what a good analysis looks like.
An agent can pick an unsuitable normalization, leak information between training and test data, or over-interpret clusters just as confidently as a person can, only faster.
We expect best practices like the ones in this book to become the reference that agents follow and that people use to check their output.

## Scale

Perturbation atlases such as Tahoe-100M (Zhang *et al.*, 2025 [6]) profile more than 100 million cells in a single study.
At this scale, CPU-based analysis becomes the bottleneck, and GPU-accelerated tools such as [rapids-singlecell](introduction/rapids-singlecell.md) (Dicks *et al.*, 2026 [7]) are becoming the default.
Jointly reanalyzing existing datasets at this scale could also uncover biology that individual studies missed.

## Spatial and multimodal data

Spatial transcriptomics now measures thousands of genes at subcellular resolution, placing cell states back into their tissue context.
Measuring every modality in every cell remains infeasible, so methods that predict missing modalities and integrate unpaired data will stay important.
Single-cell proteomics (Brunner *et al.*, 2022 [8]) adds the layer closest to cellular function, and its analysis tools will mature as high-quality datasets become routine.

## From cells to patients

Single-cell studies increasingly profile cohorts of hundreds of donors, which turns cell-level findings into patient-level questions.
Answering them requires linking single-cell data to clinical records such as diagnoses, laboratory values, and outcomes.
Electronic health records (EHRs) come with their own pitfalls, including missing values, inconsistent coding, and confounding by treatment.
Frameworks such as ehrapy (Heumos *et al.*, 2024 [9]) bring the AnnData-based analysis patterns of this book to EHR data, so that both data types can be analyzed in the same ecosystem.

## References

1. Luecken, M. D., Gigante, S., Burkhardt, D. B., Cannoodt, R., Strobl, D. C., Markov, N. S., Zappia, L., Palla, G., Lewis, W., Dimitrov, D., Vinyard, M. E., Magruder, D. S., Mueller, M. F., Andersson, A., Dann, E., Qin, Q., Otto, D. J., Klein, M., Botvinnik, O. B., … Krishnaswamy, S. (2025). Defining and Benchmarking Open Problems in Single-Cell Analysis. *Nature Biotechnology*, *43*(7), 1035–1040. https://doi.org/10.1038/s41587-025-02694-w
2. Bunne, C., Roohani, Y., Rosen, Y., & others. (2024). How to build the virtual cell with artificial intelligence: Priorities and opportunities. *Cell*, *187*(25), 7045–7063. https://doi.org/10.1016/j.cell.2024.11.015
3. Kedzierska, K. Z., Crawford, L., Amini, A. P., & Lu, A. X. (2025). Zero-shot evaluation reveals limitations of single-cell foundation models. *Genome Biology*, *26*(1), 101. https://doi.org/10.1186/s13059-025-03574-x
4. Ahlmann-Eltze, C., Huber, W., & Anders, S. (2025). Deep-learning-based gene perturbation effect prediction does not yet outperform simple linear baselines. *Nature Methods*, *22*(8), 1657–1661. https://doi.org/10.1038/s41592-025-02772-6
5. Huang, K., Zhang, S., Wang, H., & others. (2025). Biomni: A General-Purpose Biomedical AI Agent. *bioRxiv*. https://doi.org/10.1101/2025.05.30.656746
6. Zhang, J., Ubas, A. A., de Borja, R., & others. (2025). Tahoe-100M: A Giga-Scale Single-Cell Perturbation Atlas for Context-Dependent Gene Function and Cellular Modeling. *bioRxiv*. https://doi.org/10.1101/2025.02.20.639398
7. Dicks, S., Heumos, L., May, L., Jimenez, S., Angerer, P., Gold, I., Virshup, I., Fischer, F., Gill, M., Boerries, M., Nolet, C. J., Chen, T. J., & Theis, F. J. (2026). GPU-accelerated single-cell analysis at scale with rapids-singlecell. *arXiv Preprint arXiv:2603.02402*. https://doi.org/10.48550/arXiv.2603.02402
8. Brunner, A.-D., Thielert, M., Vasilopoulou, C., Ammar, C., Coscia, F., Mund, A., Hoerning, O. B., Bache, N., Apalategui, A., Lubeck, M., Richter, S., Fischer, D. S., Raether, O., Park, M. A., Meier, F., Theis, F. J., & Mann, M. (2022). Ultra-high sensitivity mass spectrometry quantifies single-cell proteome changes upon perturbation. *Molecular Systems Biology*, *18*(3), e10798. https://doi.org/10.15252/msb.202110798
9. Heumos, L., Ehmele, P., Treis, T., & others. (2024). An open-source framework for end-to-end analysis of electronic health record data. *Nature Medicine*, *30*(11), 3369–3380. https://doi.org/10.1038/s41591-024-03214-0
