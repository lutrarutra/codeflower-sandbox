---
name: codeflower-sketch
description: Draw schematic scientific figures (study designs, workflows, pathways, graphical abstracts, overview figures) as editable SVG with icons from the user's icon gallery (Servier Medical Art, SciDraw). Use whenever the user asks for an illustration, schematic, sketch, graphical abstract or an icon, or wants to find, import or credit icons. Not for data plots: use matplotlib for those.
---

# Schematic figures with codeflower-sketch

You draw the figure as one SVG file, with icons from the user's gallery, and iterate on it with the
user. The user sees it in a tab beside the chat, can select elements in it, and sends feedback about
them. `codeflower-sketch` manages the gallery and checks, renders and credits figures; run
`codeflower-sketch COMMAND --help` for the details.

The gallery is the user's own (`$CODEFLOWER_ICONS`) and shared by all their projects. It holds only
files the user downloaded and attached in the chat. **Never download icons yourself**: Servier's
terms forbid automated downloads. `codeflower-sketch sources` has the sites, licenses and credit
rules. Read it the first time icons come up, and explain them briefly to the user.

## The workflow

1. **Plan with the user** before drawing anything. Agree on:
   - the one message of the figure, and its audience (paper, talk, poster);
   - the parts (organisms, cells, molecules, instruments, steps) and how they relate: order,
     arrows, grouping;
   - the size: a journal column is about 85 mm wide, a full page about 175 mm.
2. **Sketch the layout first.** Write `figures/NAME.svg` in grayscale, with labelled boxes where
   icons will go. Show it with `codeflower-show figures/NAME.svg --message "…"`. Iterate until the
   layout is right; it is cheaper than moving icons around later.
3. **Find the icons.** Run `codeflower-sketch find TERM…` for each part (try synonyms:
   "mouse", "rodent"; "neuron", "nerve cell"). `codeflower-sketch gallery TERM` writes a contact
   sheet you can show to let the user choose.
4. **When an icon is missing,** help the user get it:
   - Say what to look for, and give the search links `find` printed: Servier Medical Art for anatomy,
     cells, organs and lab items; SciDraw for animals, neuroscience and lab setups, mostly SVG.
   - Ask the user to download the file and **attach it in the chat** (the paperclip, or drag and
     drop). It arrives as a file in `uploads/`.
   - Import it:
     - Servier: `codeflower-sketch import uploads/FILE --source servier` (a PNG, a .pptx kit, or the
       zip of all kits).
     - SciDraw: needs the credit, so ask the user for the authors, license and DOI shown on the
       drawing's page: `codeflower-sketch import uploads/FILE --source scidraw --authors "…" --license "CC BY 4.0" --doi …`.
   - Then offer to delete the upload; the gallery keeps its own copy.
5. **When nothing fits,** ask the user before generating anything, and offer what is possible here:
   - Codex: your built-in image tool, then import the result with
     `codeflower-sketch import FILE --source generated --model … --provider OpenAI --prompt "…"`;
   - `codeflower-sketch generate "PROMPT" --name NAME`, when the user configured an image provider
     (it exits with status 3 and explains how to configure one otherwise);
   - drawing a simple vector icon yourself in the SVG;
   - a labelled placeholder, to fill in later.
   Generated icons are recorded with their model and prompt; remind the user that journals may
   restrict AI-generated images. When no one can answer (an unattended task), never generate: use a
   placeholder, and list the missing icons in your summary.
6. **Compose the figure** in the same file.
   - Insert each icon with `codeflower-sketch place REF --x X --y Y --width W` and paste its
     output. The output is a `<g>` with the icon inlined and the `data-cf-icon` attribute the credits
     need: keep that attribute.
   - Give every element the user may want to point at (each icon, label, arrow, panel) a stable,
     readable `id` and a `data-label`: `<g id="mouse" data-label="Mouse">`. Feedback refers to these
     ids.
   - Make it real, editable SVG:
     - `viewBox` on the root, sized in mm (`width="85mm"`);
     - text as `<text>` with `font-family="Arial, Helvetica, sans-serif"` (rendered with Liberation
       Sans, which has Arial's metrics), at least 6 pt at final size;
     - arrows as paths with markers;
     - no `<foreignObject>`, nothing referenced from outside the file.
   - Use a colorblind-safe palette, and keep one style across the icons.
   - When you recolor, crop or otherwise change an icon, add `data-cf-adapted="true"` to its group.
7. **Iterate.**
   - Overwrite the same file: the user's tab reloads by itself.
   - The user can open the figure over the whole tab, click elements or drag over areas, and comment
     on each. Their feedback arrives as `Feedback on figures/NAME.svg …` with numbered comments like
     `1. On #mouse (Mouse): …` or `2. On the area at x 20–80, y 25–75 (SVG coordinates; …): …`,
     then any general comment.
   - Address every comment. Change exactly the named elements, or what lies in the area (in the
     SVG's own coordinates, so compare them with your `x`/`y` and transforms), and keep their ids.
     Look at the result (render a PNG and open it), then say per comment what you changed.
8. **Finish.**
   - `codeflower-sketch check figures/NAME.svg`: fix every problem it lists.
   - `codeflower-sketch render figures/NAME.svg`: writes the PDF for the journal and a 300-dpi PNG.
     Look at the PNG.
   - `codeflower-sketch credits figures/NAME.svg`: prints the credit line for the figure legend and
     writes `figures/NAME.credits.md`. Give the user the credit line. **A figure with gallery icons
     is not finished without it.**

## In a report

Reports built with storyteller should show the study design or workflow as a schematic made with
this skill. Embed the finished SVG with
`r.figure("figures/NAME.svg", caption="… Icons: CREDIT LINE", key="design")`, with the line from
`credits` in the caption. The element ids survive embedding, so the user can open the figure from
the report and comment on its parts; that feedback starts with
`Feedback on figure N ("…", part …) in reports/….html`. Edit `figures/NAME.svg` and embed it again
under the same key.

## Good to know

- `render` is the only renderer you need: `rsvg-convert` and the fonts are in the image. If it says
  the image is too old, tell the user (a newer sandbox image fixes it) rather than installing
  another renderer.

- `find` searches titles, categories and tags. Names from Servier's slide kits come from the slides'
  text, so try a broader term when a specific one fails.
- `place` prefixes the ids inside an inlined SVG icon with the group's id, so several icons can share
  a figure.
- PNG icons are embedded at their own resolution. Prefer SVG when both exist, and do not enlarge a
  small PNG much.
