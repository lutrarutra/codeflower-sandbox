# Single-cell RNA sequencing

Source: https://www.sc-best-practices.org/introduction/scrna-seq  
Authors: Lukas Heumos, Luis Heinzlmeier, Yuexin Chen

**🧠 Key takeaways**

- Sequencing evolved from **Sanger sequencing** to **high-throughput NGS** to **long-read real-time sequencing**, which is also called first-, second-, and third-generation sequencing.
- ScRNA-Seq allows for the analysis of gene expression **at the individual cell level**, uncovering cellular heterogeneity and rare cell types that are often masked in bulk RNA-Seq.
- In scRNA-Seq, transcript quantification converts the raw data into a table of estimated transcript counts per cell.
**Full-length** protocols capture entire transcripts.
**Tag-based** protocols sequence either the transcripts’ 3’ or 5’ ends.
- Transcription takes place in **stochastic bursts** and leads to a total of **100,000 to 1,000,000 mRNA** molecules in a typical mammalian cell.
- We categorize scRNA-seq techniques into two broad classes based on cell isolation into **droplets** (aqueous bubbles) or **physical compartments** (e.g. wells).

This chapter briefly introduces the most widely used single-cell ribonucleic acid ([RNA](../glossary.md#term-rna)) sequencing assays and associated basic molecular biology concepts.
[Multimodal](../glossary.md#term-modalities) or spatial assays are not covered here but are introduced in the respective advanced chapters.
All [sequencing](../glossary.md#term-sequencing) assays have individual strengths and limitations, which must be known by data analysts to be aware of possible biases in the data.

## The building block of life

Life, as we know it, is the characteristic that distinguishes living from dead or inanimate entities.
Most definitions of the term life share a common entity - [cells](../glossary.md#term-cell).
Cells form open systems which maintain homeostasis, have a metabolism, grow, adapt to their environment, reproduce, respond to stimuli, and organize themselves.
Therefore, cells are the fundamental building blocks of life, and they were first discovered in 1665 by the British scientist Robert Hooke.
Hooke investigated a thin slice of cork with a very rudimentary microscope and, to his surprise, noticed that the slice appeared to resemble a honeycomb.
He named these tiny units “cells”.

![Robert Hook cell](https://www.sc-best-practices.org/build/hooke_cork-603e5e96724d9edbb39064ce5db84ca4.jpg)

*Figure 1: Robert Hooke’s drawing of cork cells. Image obtained from Micrographia.*

In 1839, Matthias Jakob Schleiden and Theodor Schwann first described Cell Theory, stating that all living organisms are made up of cells.
Since the early definition of Cell Theory, researchers have discovered that all cells have almost the same chemical composition and exhibit a dynamic flow of information passing the genetic code from one cell to another in the form of deoxyribonucleic acid ([DNA](../glossary.md#term-dna)).
Two general types of cells exist: eukaryotes and prokaryotes.
Eukaryotic cells contain a nucleus, where the nuclear membrane encapsulates the chromosomes; while prokaryotic cells only have a nucleoid region but no nucleus.
The nucleus hosts the cells’ genomic DNA, which is why they are called eukaryotes: *Nucleus* is Latin for kernel or seed.
The DNA replication machinery reads the hereditary information that is stored in the DNA in the nucleus to replicate themselves and keep the life cycle going.
The eukaryotic DNA is divided into several linear bundles called chromosomes, which are separated by the microtubular spindle during nuclear division.
Understanding the hereditary information hidden in DNA is key to understanding many evolutionary and disease-related processes.

Sequencing is the process of deciphering the order of DNA nucleotides.
It is primarily used to unveil the genetic information that is carried by a specific DNA segment, a complete genome, or even a complex microbiome.
DNA sequencing allows researchers to identify a gene’s location, function, and regulation. For example, it uncovers genetic features such as open reading frames (ORF), the protein-coding sequences between start & stop codons, or [CpG](../glossary.md#term-cpg) islands, which indicate [promoter](../glossary.md#term-promoter) regions.
Another widespread application area is evolutionary analysis, where homologous DNA sequences from different organisms are compared.
DNA sequencing can additionally be applied for the associations between mutations and diseases or sometimes even disease resistance, deeming it one of the most valuable applications.

## A brief history of sequencing

### First-generation sequencing

Although DNA was already first isolated in 1869 by Friedrich Miescher, it took the scientific community more than 100 years to develop high-throughput sequencing technologies.
In 1953, Watson, Crick, and Franklin discovered the structure of DNA, and in 1965, Robert Holley sequenced the first tRNA.
Seven years later, in 1972, Walter Fiers was the first to sequence a complete gene (the coat protein of bacteriophage MS2) using RNases to digest the virus RNA, isolate oligonucleotides and finally separate them with electrophoresis and chromatography (Jou *et al.*, 1972 [1]).
In parallel, Frederick Sanger developed a DNA sequencing method using radiolabeled, partially digested fragments termed “chain termination method”, which is more commonly known as “Sanger Sequencing”.
Although Sanger Sequencing is still used today, it has suffered from several shortcomings, including lack of automation and being time-consuming.
In 1987, Leroy Hood and Michael Hunkapiller developed the ABI 370, an instrument that automates the Sanger Sequencing process.
Its most crucial innovative accomplishment was the automatic labeling of DNA fragments with fluorescent dyes instead of radioactive molecules.
This change not only made the method safer to perform but also allowed computers to analyze the acquired data (Hood *et al.*, 1987 [2]).

**👍 Strengths**

- Sanger sequencing is simple and affordable.
- If done correctly, the error rate is very low (<0.001%).

**👎 Limitations**

- Sanger methods can only sequence short pieces of DNA of about 300 to 1000 base pairs.
- The quality of a Sanger sequence is often poor in the first 15 to 40 bases because this is where the primers bind.
- Sequencing degrades after 700 to 900 bases.
- If the sequenced DNA fragment has been cloned, some of the cloning vector sequence (a DNA carrier for copying, storing, and amplifying genes) may find its way into the final sequence.
- Sanger sequencing is more expensive than second or third-generation sequencing per sequenced base.

### Second-generation sequencing

Nine years later, in 1996, Mostafa Ronaghi, Mathias Uhlen, and Pȧl Nyŕen revolutionized DNA sequencing by developing pyrosequencing, marking the beginning of second-generation sequencing.
Second-generation sequencing, also known as next-generation sequencing (NGS), was primarily made possible by further automation in the lab, the usage of computers, and the miniaturization of reactions.
Pyrosequencing measures luminescence that is generated by pyrophosphate synthesis during sequencing.
This process is also commonly known as “sequencing-by-synthesis”.
Two years later, Shankar Balasubramanian and David Klenerman developed and adapted the sequencing-by-synthesis process for a new method that utilizes fluorescent dyes at the company Solexa.
Solexa’s technology also forms the basis of Illumina’s sequencers, which dominate today’s market.
The Roche 454 sequencer, developed in 2005, was the first sequencer to fully automate the pyrosequencing process in a single, automated machine.
Life Technologies introduced several other platforms, including SOLiD in 2007 (a “sequencing-by-ligation” system) and Ion Torrent in 2011 (detecting hydrogen ions during the synthesis of new DNA).
In general, sequencing-by-synthesis involves adding single nucleotides to a growing DNA strand and detecting each addition.
At the same time, sequencing-by-ligation relies on detecting the joining of short DNA probes to the fragment to determine the sequence.

**👍 Strengths**

- Second-generation sequencing is often the cheapest option concerning required chemicals.
- Sparse material can still be used as input.
- High sensitivity to detect low-frequency variants and comprehensive genome coverage.
- High capacity with sample multiplexing.
- Ability to sequence thousands of genes simultaneously.

**👎 Limitations**

- The sequencing machines are expensive and often must be shared with colleagues.
- Second-generation sequencers are big, stationary machines that are not designed for fieldwork.
- Generally, second-generation sequencing results in many short sequencing fragments (reads) that are hard to use for novel genomes.
- The quality of the sequencing result depends on the reference genome.

### Third-generation sequencing

The third generation of sequencing, nowadays also known as next-generation sequencing, has brought two innovations to the market.
First, long-read sequencing, which enables the detection of nucleotide fragments that are much longer than those generated by second-generation sequencing.
The typical Illumina short-read sequencers generate fragments ranging from 75 to 300 base pairs, depending on the model.
With third-generation sequencing, sequencers can read tens of thousands of base pairs.
This is especially important for the assembly of novel genomes without an available reference genome.
Second, the ability to sequence in real-time is another major advancement in third-generation sequencing.
Combined with portable sequencers, which are small in size and do not require further complex machines for the chemistry, sequencing is now “field-ready” and can be used even far away from laboratory facilities to collect samples.

> **A note on sequencing length**
> 
> - 1 base pair (bp)
> - 1 kilo base pair (kb) = 1,000 bp
> - 1 mega base pair (Mb) = 1,000,000 bp
> - 1 giga base pair (Gb) = 1,000,000,000 bp

Pacific Biosciences (PacBio) introduced zero-mode waveguide sequencing in 2010, which uses so-called nanoholes containing a single DNA polymerase.
This allows the incorporation of any single nucleotide to be directly observed by detectors attached below the nanoholes.
Each type of nucleotide is labeled with a specific fluorescent dye that emits fluorescent signals during the incorporation process, which are subsequently measured as sequence readout.
Reads obtained from PacBio sequencers are usually 8 to 15 kb, with possibilities for up to 70 kb.

Oxford Nanopore Technologies first introduced the portable MinION device in 2012. The MinION and its successors, GridION and PromethION product line, are sequencers for DNA/RNA capable of producing reads of more than 2 Mb.
Typically, nanopore single-cell libraries produce cDNA transcripts of lengths usually 900 bp to 2.7 kb.
Notably, the MinION sequencing device is small enough to fit in the palm of a hand.
The idea of Oxford Nanopore sequencers is to detect changes in the electrical current as nucleic acids migrate through protein nanopores (Jain *et al.*, 2016 [3]).

**👍 Strengths**

- Long reads will allow for the assembly of large novel genomes.
- Sequencers are portable, making them ideal for fieldwork.
- Possibility to directly detect epigenetic modifications of DNA and RNA sequences.
- Speed! Third-generation sequencers are fast.

**👎 Limitations**

- Some third-generation sequencers exhibit higher error rates than second-generation sequencers (Roche’s new sequencing by expansion technology, for example, attempts to solve this problem (Jain *et al.*, 2016 [3])
  (Roche, 2025 [4])).
- The reagents are generally more expensive than second-generation sequencing.

> **Comparison of sequencing technologies across generations**
> 
> *Table 1: Performance comparison of common sequencing techniques sorted for maximum read length. We obtained the numbers for Sanger sequencing from individual sources ([a](https://assets.thermofisher.com/TFS-Assets/GSD/brochures/sanger-sequencing-workflow-brochure.pdf), [b](https://www.sciencedirect.com/science/article/abs/pii/B9780128154991000132), [c](https://www.base4.co.uk/cost-comparison-of-dna-sequencing-technologies/#:~:text=$500%20per%20megabase.), [d](https://www.thermofisher.com/de/de/home/life-science/cloning/cloning-learning-center/invitrogen-school-of-molecular-biology/next-generation-sequencing/dna-sequencing-history.html#:~:text=Although%20DNA%20sequencers%20using%20Sanger,base%20pairs)), while all other methods were obtained from Logsdon *et al.* (2020) [5].*
> 
> | Name | Max read length (kb) | Accuracy (%) | Cost ($/Gb) | Throughput (Mb/year) | Generation |
> |---|---|---|---|---|---|
> | Illumina NextSeq 550 | 0.15 | >99.9 | >47,782 | 50-63 | 2 |
> | Illumina NovaSeq 6000 | 0.25 | >99.9 | 10-35 | >1,194,545 | 2 |
> | Sanger sequencing (e.g. ThermoFisher) | 1<sup>b</sup> | 99.99<sup>a</sup> | 500,000<sup>c</sup> | 0.73<sup>d</sup> | 1 |
> | PacBio (Sequel II, HiFi) | >20 | >99 | 43–86 | 10,220 | 3 |
> | PacBio (Sequel II, CLR) | >200 | 87–92 | 13-26 | 93,440 | 3 |
> | Nanopore (PromethION) | >1,000 | 87–98 | 21-42 | 3,153,600 | 3 |
> | Nanopore (MinION/GridION) | >1,500 | 87–98 | 50-2,000 | 913-109,500 | 3 |

## Overview of the NGS process

Even though a variety of NGS technologies exist, the general steps to sequence DNA (and therefore reverse transcribed RNA) are largely the same.
The differences lie primarily in the chemistry of the respective sequencing technologies.

1. **Sample and library preparation**: As a first step, a so-called [library](../glossary.md#term-library) is prepared by fragmenting the DNA samples and ligating them with [adapter molecules](../glossary.md#term-adapter-sequences).
   These adapters participate in the hybridization of the library fragments to the matrix and form a priming site.
2. **Amplification and sequencing**: In the second step, the library gets converted into single-strand molecules.
   During an amplification step (such as a polymerase chain reaction), clusters of DNA molecules are created.
   All of the clusters perform individual reactions during a single sequencing run.
3. **Data output and analysis**: The output of a sequencing experiment depends on the sequencing technology and chemistry.
   Some sequencers generate fluorescence signals, which are stored in specific output files.
   Others may generate electric signals, which are stored in corresponding file formats.
   Generally, the amount of generated data, the raw data, is huge.
   Such data requires complex and computationally heavy processing.
   This is further discussed in the raw data processing chapter.

## RNA sequencing

So far, we have only introduced sequencing with the unmentioned assumption that the DNA is being sequenced.
However, knowing the DNA sequence of an organism and the positions of its regulatory elements tells us very little about a cell’s dynamic and real-time processes.
RNA sequencing (RNA-Seq) allows scientists to obtain snapshots of cells, tissues, or organisms at the time of sequencing in the form of expression profiles of genes.
This information can be used to detect changes in disease states in response to therapeutics, environmental factors, genotypes, and other experimental conditions.

RNA-Seq largely follows the DNA sequencing protocols but includes a reverse transcription step where [complementary DNA (cDNA)](../glossary.md#term-complementary-dna-cdna) is synthesized from the RNA template.
Modern RNA sequencing allows for an unbiased sampling of transcripts in contrast to, for example, microarray-based assays or quantitative reverse transcription PCR, which require probe design to specifically target the regions of interest.
Microarray-based assays use probes, complementary sequences, to detect specific sequences (e.g. genes) of interest.
Quantitative reverse transcription PCR measures the amount of target RNA by monitoring the amplification of a complementary DNA (cDNA) molecule during PCR.

The obtained gene expression profiles further enable the detection of gene isoforms, gene fusions, single nucleotide variants, and many other interesting properties.
Modern RNA sequencing is not limited by prior knowledge and allows for the capture of both known and novel features.
This results in rich data sets that can be used for exploratory data analysis.

## Single-cell RNA sequencing

### Bulk sequencing vs single-cell RNA sequencing

RNA-Seq can be mainly conducted in two ways: Either by sequencing the mixed RNA from the source of interest across cells ([bulk sequencing](../glossary.md#term-bulk-rna-sequencing)) or by sequencing the transcriptomes of the cells individually (single-cell sequencing).
Mixing the RNA of all cells is, in most cases, cheaper and easier than experimentally complex single-cell RNA-Seq (scRNA-Seq)
Bulk RNA-Seq results in cell-averaged expression profiles, which are generally easier to analyze, but also hide some of the complexity, such as cell expression profile heterogeneity, which may help answer the question of interest.
Some drugs or perturbations may affect only specific [cell types](../glossary.md#term-cell-type) or interactions between cell types.
For example, in oncology, it is possible to have rare drug-resistant tumor cells causing relapse, which is difficult to identify by simple bulk RNA-Seq, even on cultured cells.

To uncover such relationships, examining gene expression on a single-cell level is vital.
ScRNA-Seq does, however, come with several caveats.
First, single-cell experiments are generally more expensive and more difficult to properly conduct.
Second, the [downstream analysis](../glossary.md#term-downstream-analysis) becomes more complex due to the increased resolution, and it is easier to draw false conclusions.

A single-cell experiment generally follows similar steps as a bulk RNA-Seq experiment (see above) but requires several adaptations.
Like bulk sequencing, single-cell sequencing requires lysis, reverse transcription, amplification, and eventual sequencing.
In addition, single-cell sequencing requires cell isolation and a physical separation into smaller reaction chambers or another form of cell labeling to be able to map the obtained transcriptomes back to the cells of origin later on.
Hence, these are also the steps where most single-cell assays differ: single-cell isolation, transcript amplification, and sequencing, depending on the sequencing machine.
But before we can start explaining the intricacies of single-cell RNA sequencing, it’s essential to understand the biological and technical challenges that arise when measuring [mRNA](../glossary.md#term-messenger-rna-mrna) at such a fine resolution.

### Quantifying gene expression

![Quantifying gene expression from transcriptional bursts to protein production](https://www.sc-best-practices.org/build/quantifying_gene_exp-5027f7febe7711c205f54cf3d4493fab.png)

*Figure 2: Quantifying gene expression from transcriptional bursts to protein production.
These values are approximations intended to give a general impression and may vary depending on the context or in the future.*

#### Measuring “messengers”

At the core of scRNA-Seq lies a fundamental question: What **exactly** are we trying to measure?
In RNA-seq experiments, our focus is on quantifying messenger RNA (mRNA) within individual cells.
This molecule is “an unstable intermediate that carries information from genes to ribosomes for protein synthesis” as Brenner, Jacob and Meselson described it in 1961 and thus coined the term “messenger” (Brenner *et al.*, 1961 [6]).
Therefore, mRNA serves as the crucial link between DNA and protein production.
Yet, mRNA makes up only a small fraction of a cell’s total RNA.
Roughly 3–7% of RNA mass is mRNA, while the overwhelming majority is non-coding RNA: 80–90% ribosomal RNA (rRNA), 10–15% transfer RNA (tRNA), and ~1% other non-coding species (Palazzo & Lee, 2015 [7]) ([overview of non-coding RNA](https://www.bio-rad.com/de-de/applications-technologies/coding-non-coding-rna?ID=Q1070M70KWE7)).
Estimates suggest there are between 100,000 to 1,000,000 mRNA molecules in a typical mammalian cell, covering up to ~50% of all genes (Velculescu *et al.*, 1999 [8]; Islam *et al.*, 2014 [9]).
This means that a notable number of genes are not transcribed at all in any given cell — a reflection of the cell’s specific identity and function.
However, technical limitations in current scRNA-seq technologies further complicate measurement.
For example, popular platforms like 10X Genomics capture only up to 65% of cells per run and recover just ~14% of each cell’s mRNA (AlJanahi *et al.*, 2018 [10]).
These constraints make it especially challenging to detect weakly expressed genes.

Understanding the gene expression through these numerical lenses reveals not only the biological complexity but also the limitations of our tools (see the Quantifying gene expression figure).
To appreciate this more deeply, let’s walk step by step from gene to protein.

#### From Gene to Protein

Our journey begins with a gene, a defined region in the DNA that acts as a template for mRNA synthesis.
While the number of genes can vary slightly between individuals (~70 genes), the average human genome contains roughly 22,000 genes (Pertea & Salzberg, 2010 [11]).
Gene transcription is far from continuous.
Instead, it occurs in stochastic bursts — short, irregular periods of activity during which a gene might suddenly produce multiple mRNA transcripts before returning to silence (Suter *et al.*, 2011 [12]).
This is also the reason why we model mRNA transcription with a negative binomial distribution.
This distribution is ideal because it models event counts (mRNA) while capturing overdispersion (variance exceeding the mean) caused by transcriptional bursts (Ren & Kuan, 2020 [13]; Love, 2015 [14]).

> **Why a negative binomial?**
> 
> Counting events over a fixed interval usually calls for a Poisson distribution, but a Poisson has a single parameter, which forces its variance to equal its mean.
> Bursting breaks that assumption: a cell caught mid burst carries far more transcripts of a gene than a cell caught between bursts, so the counts spread out more than a Poisson permits.
> 
> The negative binomial is what a Poisson becomes when its rate is itself allowed to vary from cell to cell, following a gamma distribution.
> It keeps the count interpretation and gains a second parameter, the dispersion, which absorbs that extra spread.
> 
> Take a gene producing 5 counts per cell on average.
> Under a Poisson the variance is 5 as well, and virtually every cell would land between 0 and 11 counts.
> Measured in real cells, the same gene routinely gives zeros alongside cells carrying 30 counts or more, because bursting left the underlying rate high in some cells and near zero in others.
> The dispersion is what lets the model treat both as ordinary observations rather than calling the 30 an outlier.

The initial RNA transcript, known as pre-mRNA, then undergoes alternative splicing, a process that allows different regions (called introns and exons) of the transcript to be joined in multiple ways.
This means that a single gene can give rise to multiple distinct mRNA isoforms.
On average, each human gene produces about 3.4 mRNA isoforms (Lee & Rio, 2015 [15]).
While all human genes have at least two alternative isoforms, some push the limits of complexity.
The human basonuclin 2 gene, for instance, has the potential to generate up to 90,000 mRNA isoforms, resulting in over 2,000 different proteins (Vanhoutteghem & Djian, 2007 [16]).
In some cases, however, alternative splicing could also lead to a non-functioning enzyme and an induced disease state.
Finally, this “mature” mRNA is translated into proteins.
Here, too, the numbers vary dramatically.
In mammals, the median protein-to-mRNA ratio is estimated to be around 10,000 proteins per mRNA (Li *et al.*, 2014 [17]).
However, this can range from just a few hundred to nearly a million proteins per transcript, depending on the gene, cell type and many other factors (Edfors *et al.*, 2016 [18]).
Ultimately, this process results in approximately one billion proteins within a single human cell (Milo, 2013 [19]).

Understanding these layers — from transcriptional bursts and alternative splicing to protein translation — highlights how gene expression is not just a static pathway, but a dynamic and probabilistic system.
Measuring it at single-cell resolution offers profound insights, but also reveals the challenges and limits of our current technologies.

### Transcript quantification

Transcript quantification is the process of converting the raw data into a table of estimated transcript counts per gene per sample (for bulk sequencing) or per cell (for single-cell sequencing).
More details on this computational process will be described in the [next chapter](../introduction/raw-data-processing.md).

There are two major approaches to transcript quantification: full-length and tag-based.
Full-length protocols try to cover the whole transcript uniformly with sequencing reads, whereas tag-based protocols only capture the 5’ or 3’ ends.
The transcript quantification method has strong implications on the captured genes, and analysts must therefore be aware of the used quantification process.
Full-length sequencing is restricted to plate-based protocols (see below), and the library preparation is comparable to bulk RNA-seq sequencing approaches.
An even coverage of transcripts is not always achieved with full-length protocols, and therefore specific regions across the gene body may still be biased.
A major advantage of full-length protocols is that they allow for the detection of splice variants.

Tag-based protocols only sequence either the transcripts’ 3’ or 5’ end.
This comes at the cost of not (necessarily) covering the full gene length, making it difficult to unambiguously align reads to a transcript and distinguishing between different isoforms (Archer *et al.*, 2016 [20]).
However, it allows for the usage of unique molecular identifiers ([UMIs](../glossary.md#term-unique-molecular-identifier-umi)), which are useful to resolve biases in the transcript amplification process.

The transcript amplification process is a critical step in any RNA-seq sequencing run to ensure that the transcripts are abundant enough for quality control and sequencing.
During this process, which is typically conducted with polymerase chain reaction ([PCR](../glossary.md#term-pcr)), copies are made from identical fragments of the original molecule.
Since the copies and the original molecules are indistinguishable, determining the original number of molecules in samples becomes challenging.
UMIs are a common solution for quantifying original, non-duplicated molecules.

UMIs serve as molecular [barcodes](../glossary.md#term-barcode) and are sometimes called random barcodes.
These ‘barcodes’ consist of short random nucleotide sequences that are added to every molecule in the sample as a unique tag.
UMIs must be added during library generation before the amplification step.
Accurately identifying PCR duplicates is important for downstream analysis to rule out - or be aware of [amplification biases](../glossary.md#term-amplification-bias) (Aird *et al.*, 2011 [21]).

Amplification bias is a term for the RNA/cDNA sequences that are preferentially amplified and will therefore be sequenced more often, resulting in higher counts.
It can harm any gene expression analysis because the not-very-active genes may suddenly appear to be highly expressed.
This is especially true for sequences that are amplified at a later stage of the PCR step, where the error rate may already be comparably higher than earlier PCR stages.
Although it is computationally possible to detect and remove such sequences by filtering out reads with identical alignment coordinates, it is generally advised to always design the experiment with UMIs, if possible.
Using UMIs further allows for normalizing gene counts without a loss of accuracy (Kivioja *et al.*, 2012 [22]).

### Single-cell sequencing protocols

Numerous protocols exist for sequencing the transcriptomes of individual cells.
However, the terminology can often be ambiguous, especially for those new to the field.
To clarify, we categorize these techniques into two broad classes based on how cells are isolated:

- **Separation in droplets**: These methods encapsulate individual cells into tiny droplets within an emulsion, enabling high-throughput processing.
- **Separation in physical compartments**: These techniques isolate cells into distinct physical compartments, often referred to as wells.

Each approach differs in the ability to recover transcripts, the number of sequenced cells, and many other aspects.
In the following subsections, we will briefly discuss how they work, their strengths and weaknesses, and possible biases that data analysts should be aware of regarding the respective protocols.

#### Separation in Droplets

##### Most common protocols

The most widely used protocols are **inDrop** (Klein *et al.*, 2015 [23]), **Drop-seq** (Macosko *et al.*, 2015 [24]) and the commercially available **10x Genomics Chromium** (Zheng *et al.*, 2017 [25]).
These protocols use microfluids to trap cells in tiny, watery bubbles known as droplets.
Each droplet forms a separate space containing only one cell and the required chemicals (beads).
The mentioned protocols can generate droplets thousands of times per second.
This massively parallel process generates very high numbers of droplets for a relatively low cost.

> **Droplets by vortexing**
> 
> The PIP-seq protocol offers a simplified alternative to traditional microfluidic methods for generating monodispersed water-in-oil droplets.
> Unlike complex microfluidic devices that require specialized equipment and expertise, PIP-seq achieves droplet formation through simple vortexing of the solution.
> This method can be easily scaled by increasing the container volume without being constrained by emulsion time, a common limitation of microfluidics (Clark *et al.*, 2023 [26]).
> 
> However, despite its simplicity, independent [benchmarks](../glossary.md#term-benchmark) indicate that PIP-seq still has limitations compared to well-established methods.
> For instance, PIP-seq achieved approximately 1,500 gene counts, whereas the best 10x Genomics Chromium kit showed around 4,000 gene counts (De Simone *et al.*, 2025 [27]).
> These findings highlight a trade-off between ease of use and performance in the current version of the PIP-seq protocol.

Although all three protocols differ in detail, nanoliter-sized droplets containing encapsulated cells are always designed to capture beads and cells simultaneously.
The encapsulation process is conducted with specialized microbeads with on-bead primers containing a PCR handle, a cell barcode, and a 4-8b base pairs-long UMI and a poly-T tail (or in the case of a 5’ kit, there will be a poly-T primer).
Upon lysis, the cell’s mRNA is instantaneously released and captured by the barcoded oligonucleotides that are attached to the beads.
Next, the droplets are collected and broken to release single-cell transcriptomes attached to microparticles (STAMPs).
This is followed by PCR and reverse transcription to capture and amplify the transcripts.
Finally, tagmentation takes place where the transcripts are randomly cut and sequencing adaptors get attached.
This process results in sequencing libraries that are ready for sequencing, as described above.
In droplet-based protocols, only about 10% of cell transcripts are recovered (Islam *et al.*, 2014 [9]).
Notably, this low sequencing is sufficient for a robust identification of cell types.

All three methods result in characteristic biases.
The material of the used beads differs between the protocols.
[Drop-seq](../glossary.md#term-drop-seq) uses brittle resin for the bead.
Therefore, the beads are encapsulated with a [Poisson distribution](../glossary.md#term-poisson-distribution), whereas the [InDrop](../glossary.md#term-indrop) and 10X Genomics beads are deformable resulting in bead occupancies of over 80% (Zhang *et al.*, 2019 [28]).

Moreover, capture efficiency is likely influenced by the use of surface-tethered primers in Drop-Seq.
InDrop uses primers that are released with photocleavage, and 10X genomics dissolves the beads.
This disparity also affects the location of the reverse transcription process.
In Drop-seq, reverse transcription occurs after the beads are released from the droplets, while reverse transcription takes place inside the droplets for the InDrop and 10X genomics protocols (Zhang *et al.*, 2019 [28]).

A comparison from Zhang et al. in 2019 uncovered that inDrop and Drop-seq are outperformed by 10X Genomics with respect to bead quality, as the cell barcodes in the former two systems contained obvious mismatches.
Moreover, the proportion of reads originating from valid barcodes was 75% for 10X Genomics, compared to only 25% for InDrop and 30% for Drop-seq.

Similar advantages regarding sensitivity were demonstrated for 10X Genomics.
During their comparison, 10X Genomics captured about 17000 transcripts from 3000 genes on average, compared to 8000 transcripts from 2500 genes for Drop-seq and 2700 transcripts from 1250 genes for InDrop.
Technical noise was the lowest for 10X Genomics, followed by Drop-seq and InDrop (Zhang *et al.*, 2019 [28]).

The actual generated data demonstrated large protocol biases.
10X Genomics favored the capture and amplification of shorter genes and genes with higher GC content, while Drop-seq, in comparison, preferred genes with lower GC content.
Although 10X Genomics was shown to outperform the other protocols in various aspects, it is also about twice as expensive per cell.
Moreover, except the beads, Drop-seq is open-source and the protocol can more easily be adapted if required.
InDrop is completely open-source, where even the beads can be manufactured and modified in labs.
Hence, InDrop is the most flexible of the three protocols.

**👍 Strengths**

- Allows for the cost-efficient sequencing of cells in large quantities to identify the overall composition of a tissue and characterize rare cell types.
- UMIs can be incorporated.

**👎 Limitations**

- Low detection rates of transcripts compared to other methods.
- Captures only 3’ ends (or 5’ ends, depending on kit) and not full transcripts.

##### Nanopore sequencing meets droplet technology

Long-read single-cell sequencing approaches rarely use UMI (Singh *et al.*, 2019 [29]) or do not perform UMI correction (Gupta *et al.*, 2018 [30]) and therefore misassign some reads to novel UMIs.
Due to the higher sequencing error rate of long-read sequencers, this causes serious issues (Lebrigand *et al.*, 2020 [31]).
Lebrigand et al. introduced ScNaUmi-seq (Single-cell Nanopore sequencing with UMIs), combining Nanopore sequencing with cell barcode and UMI assignment.
The barcode assignment is guided with Illumina data by comparing the cell bar code sequences found in the Nanopore reads with those recovered from the Illumina reads for the same region or gene (Lebrigand *et al.*, 2020 [31]).
However, this effectively requires two single-cell libraries.
ScCOLOR-seq computationally identifies barcodes without errors using nucleotide pair complementary across the full length of the barcode.
These barcodes are then used as guides to correct the remaining erroneous barcodes (Philpott *et al.*, 2021 [32]).
A modified UMI-tools directional network-based method corrects for UMI sequence duplication.

**👍 Strengths**

- Recovers splicing and sequence heterogeneity information

**👎 Limitations**

- Nanopore reagents are expensive.
- High cell barcode recovery error rates.
- Depending on the protocol, barcode assignment is guided with Illumina data requiring two sequencing assays.

#### Separation in physical compartments

##### Plate-based protocols

Typically, plate-based protocols physically separate the cells into microwell plates.
The first step entails cell sorting by, for example, fluorescent-activated cell sorting (FACS), where cells are sorted according to specific cell surface markers; or by micro pipetting.
The selected cells are then placed into individual wells containing cell lysis buffers.
A reverse transcription is then carried out in these wells.
This allows several hundred cells to be analyzed in a single experiment with 5000 to 10000 captured genes each.

Plate-based sequencing protocols include but are not limited to, SMART-seq2, MARS-seq, QUARTZ-seq, and SRCB-seq.
Generally speaking, the protocols differ in their multiplexing ability.
For example, MARS-seq allows for three barcode levels, namely molecular, cellular, and plate-level tags, for robust multiplexing capabilities.
SMART-seq2, on the contrary, does not allow for early multiplexing, limiting cell numbers.
A systematic comparison of protocols by Mereu et al. in 2020 revealed that QUARTZ-seq2 can capture more genes than SMART-seq2, MARS-seq, or SRCB-seq per cell (Mereu *et al.*, 2020 [33]).
This means QUARTZ-seq2 can capture cell-type specific marker genes well, allowing for confident cell-type annotation.

**👍 Strengths**

- Recovers many genes per cell, allowing for a deep characterization.
- It is possible to gather information before the library preparation, e.g., through FACS sorting to associate information such as cell size and the intensity of any used labels with good coordinates.
- Allows for full-length transcript recovery.

**👎 Limitations**

- The scale of plate-based experiments is limited by the lower throughput of their individual processing units.
- Fragmentation step eliminates strand-specific information (Hrdlickova *et al.*, 2017 [34]).
- Depending on the protocol, plate-based protocols might be labor-intensive with many required pipetting steps, leading to potential technical noise and [batch effects](../glossary.md#term-batch-effect).

##### Fluidigm C1

The commercial Fluidigm C1 system is a microfluidic chip that loads and separates cells into small reaction chambers in an automated manner.
The CEL-seq2 and SMART-seq (version 1) protocols use the Fluidigm C1 chips in their workflow, allowing the RNA extraction and library preparation steps to be conducted together, thereby decreasing the required manual labor.
However, the Fluidigm C1 requires rather homogeneous cell mixtures since the cells will reach different locations on the microfluidic chip based on their size, which could introduce potential location bias.
Full-length sequencing is possible since the amplification step is carried out in individual wells, effectively reducing the 3’ bias of many other single-cell RNA-seq sequencing protocols.
The protocol is generally also more expensive and is therefore primarily useful for an extensive examination of a specific cell population.

**👍 Strengths**

- Allows for full-length transcript coverage.
- Splicing variants and T/B cell receptor repertoire diversity can be recovered.

**👎 Limitations**

- Only allows for the sequencing of up to 800 cells (Fluidigm, 2022 [35]).
- More expensive per cell than other protocols.
- Only about 10% of the extracted cells are captured, which makes this protocol unsuitable for rare cell types or low input.
- The used arrays only capture specific cell sizes, which may bias the captured transcripts.

#### Summary

In summary, we strongly recommend that wet lab and dry lab scientists select the sequencing protocol based on the aim of the study.
Is a deep characterization of a specific cell type population desired?
In this case, one of the plate-based methods may be more suitable.
On the contrary, droplet-based assays will capture heterogeneous mixtures better, allowing for a broader characterization of the sequenced cells.
Moreover, if the budget is a limiting factor, the protocol of choice should be more cost-effective and robust.
When analyzing the data, be aware of the sequencing assay-specific biases.
For an extensive comparison of all single-cell sequencing protocols, we recommend the “Benchmarking single-cell RNA-sequencing protocols for cell atlas projects” paper by Mereu et al. (Mereu *et al.*, 2020 [33]).

### Single-cell vs single-nuclei

So far, we have only been discussing single-cell assays, but it is also possible to sequence only the nuclei of the cells.
Single-cell profiling does not always provide an unbiased view of cell types for specific tissues or organs, such as, for example, the brain.
During the tissue dissociation process, some cell types are more vulnerable and therefore difficult to capture. For example, fast-spiking parvalbumin-positive interneurons and subcortically projecting glutamatergic neurons were observed in lower proportions than expected in mouse neocortex (Tasic *et al.*, 2018 [36]).
On the contrary, non-neuronal cells survive dissociation better than neurons and are overrepresented in single-cell suspensions in the adult human neocortex (Darmanis *et al.*, 2015 [37]).
Moreover, single-cell sequencing highly relies on fresh tissue, making it difficult to use tissue biobanks.
On the other hand, the nuclei are more resistant to mechanical force and can be safely isolated from frozen tissue without the use of tissue dissociation enzymes (Krishnaswami *et al.*, 2016 [38]).
Both options have varying applicability across tissues and sample types, and the resulting biases and uncertainties are still not fully uncovered.
It has been shown already that nuclei accurately reflect all transcriptional patterns of cells (Ding *et al.*, 2020 [39]).
The choice of single-cell versus single-nuclei in the experimental design is mostly driven by the type of tissue sample.
Data analysis, however, should be aware of the fact that dissociation ability will have a strong effect on the potentially observable cell types.
Therefore, we strongly encourage discussions between wet lab and dry lab scientists concerning the experimental design.

> **See Also**
> 
> To get a more elaborate understanding of the experimental assays, we recommend the following papers:
> 
> - Comparative Analysis of Single-Cell RNA Sequencing Methods (Ziegenhain *et al.*, 2017 [40])
> - Power analysis of single-cell RNA-sequencing experiments (Svensson *et al.*, 2017 [41])
> - Single-nucleus and single-cell transcriptomes compared in matched cortical cell types (Bakken *et al.*, 2018 [42])
> - Guidelines for the experimental design of single-cell RNA sequencing studies (Lafzi *et al.*, 2018 [43])
> - Benchmarking single-cell RNA-sequencing protocols for cell atlas projects (Mereu *et al.*, 2020 [33])
> - Direct Comparative Analyses of 10X Genomics Chromium and Smart-seq2 (Wang *et al.*, 2021 [44])
> 
> Videos for laboratory methods:
> 
> - [Microarray-based assays](https://www.youtube.com/watch?v=NgRfc6atXQ8)
> - [Quantitative reverse transcription PCR](https://www.youtube.com/watch?v=XH6vIBLwC2M)
> 
> Others:
> 
> - [Biological numbers](https://bionumbers.hms.harvard.edu/search.aspx)

### Questions

#### Flipcards

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    flip_card(
        "q5",
        "What are the two main categories we introduced for scRNA-seq protocols?",
        "Separation in droplets and separation in physical compartments.",
    )

    flip_card(
        "q6",
        "What is the main advantage of droplet-based protocols?",
        "High throughput",
    )

    flip_card(
        "q7",
        "What characterizes second-generation sequencing?",
        "High-throughput, short-read sequencing technologies, like Illumina and Ion Torrent.",
    )

    flip_card(
        "q8",
        "What is the key advantage of third-generation sequencing?",
        "Long-read sequencing without amplification, as seen in Nanopore and PacBio.",
    )
```

#### Multiple choice questions

```python
%run ../../scripts/quiz.py

with quiz_tabs():
    multiple_choice_question(
        "q1",
        "What is the primary purpose of scRNA-seq?",
        [
            "To sequence the genome of a single cell",
            "To measure gene expression in individual cells",
            "To capture DNA methylation patterns",
            "To determine cell surface markers",
        ],
        "To measure gene expression in individual cells",
        {},
    )

    multiple_choice_question(
        "q2",
        "What is reverse transcription in the context of scRNA-seq?",
        [
            "Converting cDNA to mRNA",
            "Sequencing the DNA",
            "Converting mRNA to cDNA",
            "Labeling cell surface markers",
        ],
        "Converting mRNA to cDNA",
        {},
    )

    multiple_choice_question(
        "q3",
        "What is the main difference between single-cell and single-nuclei sequencing?",
        [
            "Single-cell captures whole cells, while single-nuclei captures only nuclei",
            "Single-nuclei sequencing has higher throughput",
            "Single-cell is more accurate",
            "Single-nuclei sequencing is cheaper",
        ],
        "Single-cell captures whole cells, while single-nuclei captures only nuclei",
        {},
    )

    multiple_choice_question(
        "q4",
        "Which of the following best describes PIP-seq?",
        [
            "A protocol using microfluidics",
            "A plate-based protocol",
            "A simplified droplet-based method using vortexing",
            "A long-read sequencing method",
        ],
        "A simplified droplet-based method using vortexing",
        {},
    )
```

## Contributors

We gratefully acknowledge the contributions of:

### Authors

- Lukas Heumos
- Luis Heinzlmeier

### Reviewers

- Yuexin Chen

## References

1. Jou, W. M., Haegeman, G., Ysebaert, M., & Fiers, W. (1972). Nucleotide Sequence of the Gene Coding for the Bacteriophage MS2 Coat Protein. *Nature*, *237*(5350), 82–88. https://doi.org/10.1038/237082a0
2. Hood, L. E., Hunkapiller, M. W., & Smith, L. M. (1987). Automated DNA sequencing and analysis of the human genome. *Genomics*, *1*(3), 201–212. https://doi.org/10.1016/0888-7543(87)90046-2
3. Jain, M., Olsen, H. E., Paten, B., & Akeson, M. (2016). The Oxford Nanopore MinION: delivery of nanopore sequencing to the genomics community. *Genome Biology*, *17*(1), 239. https://doi.org/10.1186/s13059-016-1103-0
4. Roche. (2025). *Sequencing by expansion (SBX) technology*. https://sequencing.roche.com/global/en/article-listing/sequencing-platform-technologies.html
5. Logsdon, G. A., Vollger, M. R., & Eichler, E. E. (2020). Long-read human genome sequencing and its applications. *Nature Reviews Genetics*, *21*(10), 597–614. https://doi.org/10.1038/s41576-020-0236-x
6. Brenner, S., Jacob, F., & Meselson, M. (1961). An unstable intermediate carrying information from genes to ribosomes for protein synthesis. *Nature*, *190*, 576–581. https://doi.org/10.1038/190576a0
7. Palazzo, A. F., & Lee, E. S. (2015). Non-coding RNA: what is functional and what is junk? *Frontiers in Genetics*, *6*, 2. https://doi.org/10.3389/fgene.2015.00002
8. Velculescu, V. E., Madden, S. L., Zhang, L., Lash, A. E., Yu, J., Rago, C., Lal, A., Wang, C. J., Beaudry, G. A., Ciriello, K. M., & others. (1999). Analysis of human transcriptomes. *Nature Genetics*, *23*(4), 387–388. https://doi.org/10.1038/70487
9. Islam, S., Zeisel, A., Joost, S., La Manno, G., Zajac, P., Kasper, M., Lönnerberg, P., & Linnarsson, S. (2014). Quantitative single-cell RNA-seq with unique molecular identifiers. *Nature Methods*, *11*(2), 163–166. https://doi.org/10.1038/nmeth.2772
10. AlJanahi, A. A., Danielsen, M., & Dunbar, C. E. (2018). An introduction to the analysis of single-cell RNA-sequencing data. *Molecular Therapy Methods & Clinical Development*, *10*, 189–196. https://doi.org/10.1016/j.omtm.2018.07.003
11. Pertea, M., & Salzberg, S. L. (2010). Between a chicken and a grape: estimating the number of human genes. *Genome Biology*, *11*, 1–7. https://doi.org/10.1186/gb-2010-11-5-206
12. Suter, D. M., Molina, N., Gatfield, D., Schneider, K., Schibler, U., & Naef, F. (2011). Mammalian genes are transcribed with widely different bursting kinetics. *Science*, *332*(6028), 472–474. https://doi.org/10.1126/science.1198817
13. Ren, X., & Kuan, P.-F. (2020). Negative binomial additive model for RNA-Seq data analysis. *BMC Bioinformatics*, *21*, 1–15.
14. Love, M. (2015). *Deseq2: RNA-seq and Negative binomial distribution*. https://support.bioconductor.org/p/74572/
15. Lee, Y., & Rio, D. C. (2015). Mechanisms and regulation of alternative pre-mRNA splicing. *Annual Review of Biochemistry*, *84*(1), 291–323. https://doi.org/10.1146/annurev-biochem-060614-034316
16. Vanhoutteghem, A., & Djian, P. (2007). The human basonuclin 2 gene has the potential to generate nearly 90,000 mRNA isoforms encoding over 2000 different proteins. *Genomics*, *89*(1), 44–58. https://doi.org/10.1016/j.ygeno.2006.07.006
17. Li, J. J., Bickel, P. J., & Biggin, M. D. (2014). System wide analyses have underestimated protein abundances and the importance of transcription in mammals. *PeerJ*, *2*, e270. https://doi.org/10.7717/peerj.270
18. Edfors, F., Danielsson, F., Hallström, B. M., Käll, L., Lundberg, E., Pontén, F., Forsström, B., & Uhlén, M. (2016). Gene-specific correlation of RNA and protein levels in human cells and tissues. *Molecular Systems Biology*, *12*(10), 883.
19. Milo, R. (2013). What is the total number of protein molecules per cell volume? A call to rethink some published values. *Bioessays*, *35*(12), 1050–1055. https://doi.org/10.1002/bies.201300066
20. Archer, N., Walsh, M. D., Shahrezaei, V., & Hebenstreit, D. (2016). Modeling Enzyme Processivity Reveals that RNA-Seq Libraries Are Biased in Characteristic and Correctable Ways. *Cell Systems*, *3*(5), 467-479.e12. https://doi.org/10.1016/j.cels.2016.10.012
21. Aird, D., Ross, M. G., Chen, W.-S., Danielsson, M., Fennell, T., Russ, C., Jaffe, D. B., Nusbaum, C., & Gnirke, A. (2011). Analyzing and minimizing PCR amplification bias in Illumina sequencing libraries. *Genome Biology*, *12*(2), R18. https://doi.org/10.1186/gb-2011-12-2-r18
22. Kivioja, T., Vähärautio, A., Karlsson, K., Bonke, M., Enge, M., Linnarsson, S., & Taipale, J. (2012). Counting absolute numbers of molecules using unique molecular identifiers. *Nature Methods*, *9*(1), 72–74. https://doi.org/10.1038/nmeth.1778
23. Klein, A. M., Mazutis, L., Akartuna, I., Tallapragada, N., Veres, A., Li, V., Peshkin, L., Weitz, D. A., & Kirschner, M. W. (2015). Droplet barcoding for single-cell transcriptomics applied to embryonic stem cells. *Cell*, *161*(5), 1187–1201. https://doi.org/10.1016/j.cell.2015.04.044
24. Macosko, E. Z., Basu, A., Satija, R., Nemesh, J., Shekhar, K., Goldman, M., Tirosh, I., Bialas, A. R., Kamitaki, N., Martersteck, E. M., Trombetta, J. J., Weitz, D. A., Sanes, J. R., Shalek, A. K., Regev, A., & McCarroll, S. A. (2015). Highly Parallel Genome-wide Expression Profiling of Individual Cells Using Nanoliter Droplets. *Cell*, *161*(5), 1202–1214. https://doi.org/10.1016/j.cell.2015.05.002
25. Zheng, G. X. Y., Terry, J. M., Belgrader, P., Ryvkin, P., Bent, Z. W., Wilson, R., Ziraldo, S. B., Wheeler, T. D., McDermott, G. P., Zhu, J., Gregory, M. T., Shuga, J., Montesclaros, L., Underwood, J. G., Masquelier, D. A., Nishimura, S. Y., Schnall-Levin, M., Wyatt, P. W., Hindson, C. M., … Bielas, J. H. (2017). Massively parallel digital transcriptional profiling of single cells. *Nature Communications*, *8*(1), 14049. https://doi.org/10.1038/ncomms14049
26. Clark, I. C., Fontanez, K. M., Meltzer, R. H., Xue, Y., Hayford, C., May-Zhang, A., D’Amato, C., Osman, A., Zhang, J. Q., Hettige, P., & others. (2023). Microfluidics-free single-cell genomics with templated emulsification. *Nature Biotechnology*, *41*(11), 1557–1566. https://doi.org/10.1038/s41587-023-01685-z
27. De Simone, M., Hoover, J., Lau, J., Bennett, H. M., Wu, B., Chen, C., Menon, H., Au-Yeung, A., Lear, S., Vaidya, S., & others. (2025). A comprehensive analysis framework for evaluating commercial single-cell RNA sequencing technologies. *Nucleic Acids Research*, *53*(2), gkae1186. https://doi.org/10.1093/nar/gkae1186
28. Zhang, X., Li, T., Liu, F., Chen, Y., Yao, J., Li, Z., Huang, Y., & Wang, J. (2019). Comparative Analysis of Droplet-Based Ultra-High-Throughput Single-Cell RNA-Seq Systems. *Molecular Cell*, *73*(1), 130-142.e5. https://doi.org/10.1016/j.molcel.2018.10.020
29. Singh, M., Al-Eryani, G., Carswell, S., Ferguson, J. M., Blackburn, J., Barton, K., Roden, D., Luciani, F., Giang Phan, T., Junankar, S., Jackson, K., Goodnow, C. C., Smith, M. A., & Swarbrick, A. (2019). High-throughput targeted long-read single cell sequencing reveals the clonal and transcriptional landscape of lymphocytes. *Nature Communications*, *10*(1), 3120. https://doi.org/10.1038/s41467-019-11049-4
30. Gupta, I., Collier, P. G., Haase, B., Mahfouz, A., Joglekar, A., Floyd, T., Koopmans, F., Barres, B., Smit, A. B., Sloan, S. A., Luo, W., Fedrigo, O., Ross, M. E., & Tilgner, H. U. (2018). Single-cell isoform RNA sequencing characterizes isoforms in thousands of cerebellar cells. *Nature Biotechnology*, *36*(12), 1197–1202. https://doi.org/10.1038/nbt.4259
31. Lebrigand, K., Magnone, V., Barbry, P., & Waldmann, R. (2020). High throughput error corrected Nanopore single cell transcriptome sequencing. *Nature Communications*, *11*(1), 4025. https://doi.org/10.1038/s41467-020-17800-6
32. Philpott, M., Watson, J., Thakurta, A., Brown, T., Oppermann, U., & Cribbs, A. P. (2021). Nanopore sequencing of single-cell transcriptomes with scCOLOR-seq. *Nature Biotechnology*, *39*(12), 1517–1520. https://doi.org/10.1038/s41587-021-00965-w
33. Mereu, E., Lafzi, A., Moutinho, C., Ziegenhain, C., McCarthy, D. J., Álvarez Varela, A., Batlle, E., Sagar, Grün, D., Lau, J. K., Boutet, S. C., Sanada, C., Ooi, A., Jones, R. C., Kaihara, K., Brampton, C., Talaga, Y., Sasagawa, Y., Tanaka, K., … Heyn, H. (2020). Benchmarking single-cell RNA-sequencing protocols for cell atlas projects. *Nature Biotechnology*, *38*(6), 747–755. https://doi.org/10.1038/s41587-020-0469-4
34. Hrdlickova, R., Toloue, M., & Tian, B. (2017). RNA-Seq methods for transcriptome analysis. *WIREs RNA*, *8*(1), e1364. https://doi.org/10.1002/wrna.1364
35. Fluidigm. (2022). *Single-Cell Analysis with Microfluidics*. https://www.fluidigm.com/area-of-interest/single-cell-analysis/single-cell-analysis-with-microfluidics
36. Tasic, B., Yao, Z., Graybuck, L. T., Smith, K. A., Nguyen, T. N., Bertagnolli, D., Goldy, J., Garren, E., Economo, M. N., Viswanathan, S., Penn, O., Bakken, T., Menon, V., Miller, J., Fong, O., Hirokawa, K. E., Lathia, K., Rimorin, C., Tieu, M., … Zeng, H. (2018). Shared and distinct transcriptomic cell types across neocortical areas. *Nature*, *563*(7729), 72–78. https://doi.org/10.1038/s41586-018-0654-5
37. Darmanis, S., Sloan, S. A., Zhang, Y., Enge, M., Caneda, C., Shuer, L. M., Gephart, M. G. H., Barres, B. A., & Stephen R. Quake. (2015). A survey of human brain transcriptome diversity at the single cell level. *Proceedings of the National Academy of Sciences*, *112*(23), 7285–7290. https://doi.org/10.1073/pnas.1507125112
38. Krishnaswami, S. R., Grindberg, R. V., Novotny, M., Venepally, P., Lacar, B., Bhutani, K., Linker, S. B., Pham, S., Erwin, J. A., Miller, J. A., Hodge, R., McCarthy, J. K., Kelder, M., McCorrison, J., Aevermann, B. D., Fuertes, F. D., Scheuermann, R. H., Lee, J., Lein, E. S., … Lasken, R. S. (2016). Using single nuclei for RNA-seq to capture the transcriptome of postmortem neurons. *Nature Protocols*, *11*(3), 499–524. https://doi.org/10.1038/nprot.2016.015
39. Ding, J., Adiconis, X., Simmons, S. K., Kowalczyk, M. S., Hession, C. C., Marjanovic, N. D., Hughes, T. K., Wadsworth, M. H., Burks, T., Nguyen, L. T., Kwon, J. Y. H., Barak, B., Ge, W., Kedaigle, A. J., Carroll, S., Li, S., Hacohen, N., Rozenblatt-Rosen, O., Shalek, A. K., … Levin, J. Z. (2020). Systematic comparison of single-cell and single-nucleus RNA-sequencing methods. *Nature Biotechnology*, *38*(6), 737–746. https://doi.org/10.1038/s41587-020-0465-8
40. Ziegenhain, C., Vieth, B., Parekh, S., Reinius, B., Guillaumet-Adkins, A., Smets, M., Leonhardt, H., Heyn, H., Hellmann, I., & Enard, W. (2017). Comparative analysis of single-cell RNA sequencing methods. *Mol Cell*, *65*(4), 631-643.e4. https://doi.org/10.1016/j.molcel.2017.01.023
41. Svensson, V., Natarajan, K. N., Ly, L.-H., Miragaia, R. J., Labalette, C., Macaulay, I. C., Cvejic, A., & Teichmann, S. A. (2017). Power analysis of single-cell RNA-sequencing experiments. *Nature Methods*, *14*(4), 381–387. https://doi.org/10.1038/nmeth.4220
42. Bakken, T. E., Hodge, R. D., Miller, J. A., Yao, Z., Nguyen, T. N., Aevermann, B., Barkan, E., Bertagnolli, D., Casper, T., Dee, N., Garren, E., Goldy, J., Graybuck, L. T., Kroll, M., Lasken, R. S., Lathia, K., Parry, S., Rimorin, C., Scheuermann, R. H., … Tasic, B. (2018). Single-nucleus and single-cell transcriptomes compared in matched cortical cell types. *PLOS ONE*, *13*(12), 1–24. https://doi.org/10.1371/journal.pone.0209648
43. Lafzi, A., Moutinho, C., Picelli, S., & Heyn, H. (2018). Tutorial: guidelines for the experimental design of single-cell RNA sequencing studies. *Nature Protocols*, *13*(12), 2742–2757. https://doi.org/10.1038/s41596-018-0073-y
44. Wang, X., He, Y., Zhang, Q., Ren, X., & Zhang, Z. (2021). Direct Comparative Analyses of 10X Genomics Chromium and Smart-seq2. *Genomics, Proteomics & Bioinformatics*, *19*(2), 253–266. https://doi.org/10.1016/j.gpb.2020.02.005
