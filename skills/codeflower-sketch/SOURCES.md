# Icon sources, licenses and credits

The user's icon gallery holds only files the user downloaded by hand and attached in the chat, and
icons generated at their request. Code flower ships no icons and downloads none: the sites below
forbid automated downloads, or ask that their images are not redistributed as a collection.

## Servier Medical Art

- Site: https://smart.servier.com
- License: every image is CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Commercial use
  and adapting (recoloring, cropping, combining) are allowed, with credit.
- Formats: PNG, or slide kits (.pptx) with many images each. No SVG.
- How to download:
  - one image: search at `https://smart.servier.com/?s=TERM`, open the image, download the PNG;
  - a kit: https://smart.servier.com/image-kits-by-category/ (each kit is a .pptx of a few MB);
  - all kits at once: the "Download all slide set" link on that page (a zip of about 170 MB).
- Import: `codeflower-sketch import FILE --source servier` (PNG, .pptx or the zip).
- Credit, as Servier asks (https://smart.servier.com/how-to-cite-servier-medical-art/):
  - "Image provided by Servier Medical Art (https://smart.servier.com), licensed under CC BY 4.0
    (https://creativecommons.org/licenses/by/4.0/)."
  - When the image was changed: "Image adapted from Servier Medical Art (…), licensed under CC BY 4.0
    (…)."
- Not for logos or branding. Do not offer the images as an image library or collection of their own
  (https://smart.servier.com/using-smart-images-what-you-can-do).
- The site's terms of use forbid bots and scrapers: never fetch anything from smart.servier.com
  yourself.

## SciDraw

- Site: https://scidraw.io. Each drawing is also deposited on Zenodo with a DOI
  (`https://zenodo.org/search?q=description%3A%22uploaded%20to%20scidraw.io%22`).
- License: set per drawing, almost always CC BY 4.0. Only CC BY and CC0 drawings can be imported.
- Formats: mostly SVG, some PNG.
- Download: the drawing's page on scidraw.io or its Zenodo record. Note its title, authors, license
  and DOI (or page URL) from the same page.
- Import:
  `codeflower-sketch import FILE --source scidraw --authors "…" --license "CC BY 4.0" --doi 10.5281/zenodo.…`
  (or `--url` when there is no DOI).
- Credit: `"TITLE" by AUTHORS, SciDraw, doi:DOI, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)`,
  starting with "Adapted from" when the drawing was changed. CC0 needs no credit, but giving it is
  good practice.

## The user's own icons

`codeflower-sketch import FILE --source own [--credit "…"] [--license …]`: drawings the user made or
holds the rights to. Ask for the credit line they want, if any.

## Generated icons

- With an image provider in the user's code flower `config.yaml` (`images:`), `codeflower-sketch
  generate` creates an icon and records the provider, model and prompt. Codex can also use its
  built-in image tool; import the result with
  `--source generated --model … --provider OpenAI --prompt "…"`.
- Generate only when the user agreed to it.
- Many journals restrict AI-generated images or require them to be declared. The credits name the
  model; remind the user to check the journal's policy.

## Crediting a figure

`codeflower-sketch credits FIGURE.svg` writes the credit line for the figure legend and
`FIGURE.credits.md` with every icon used. Put the line in the legend, or in the acknowledgements when
the journal prefers. Mark icons you changed with `data-cf-adapted="true"`, so their credit says
"adapted".
