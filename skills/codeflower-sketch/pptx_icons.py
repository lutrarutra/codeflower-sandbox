"""Gallery icons as editable PowerPoint shapes in decks built with python-pptx.

    import sys
    sys.path.insert(0, "/opt/codeflower/skills/codeflower-sketch")
    from pptx_icons import add_icon

    meta = add_icon(slide, "servier/b-lymphocyte", Cm(2), Cm(5), Cm(6))

Only icons whose meta.json has "pptx" (Servier icons from slide kits) have shapes; insert the others with
slide.shapes.add_picture() as usual. Credit every icon you use: `codeflower-sketch credits` for figures, or
the line `codeflower-sketch pptx` prints for decks.
"""

import gzip
import json
import os
from pathlib import Path

from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.opc.package import Part
from pptx.oxml import parse_xml
from pptx.oxml.ns import qn

MEDIA_TYPES = {"emf": "image/x-emf", "wmf": "image/x-wmf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
               "svg": "image/svg+xml"}


def add_icon(slide, ref, left, top, width):
    """Adds the icon REF (e.g. "servier/b-lymphocyte") to a python-pptx slide as a group of shapes, `width` wide
    (EMU, or Cm()/Inches()) at (left, top). Returns the icon's meta.json, for its title and credit."""
    folder = Path(os.environ.get("CODEFLOWER_ICONS", Path.home() / ".codeflower" / "icons"), ref)
    meta = json.loads((folder / "meta.json").read_text())
    if not meta.get("pptx"):
        raise ValueError(f"{ref} has no PowerPoint shapes: insert {folder / meta['filename']} as a picture")
    data = (folder / meta["pptx"]).read_bytes()
    shape = parse_xml(gzip.decompress(data) if meta["pptx"].endswith(".gz") else data)
    # Pictures inside the drawing (EMF) become parts of this deck.
    for rid, name in meta.get("pptxMedia", {}).items():
        suffix = Path(name).suffix[1:].lower()
        part = Part(slide.part.package.next_image_partname(suffix), MEDIA_TYPES.get(suffix, "application/octet-stream"),
                    slide.part.package, (folder / name).read_bytes())
        new = slide.part.relate_to(part, RT.IMAGE)
        for node in shape.iter():
            if node.get(qn("r:embed")) == rid:
                node.set(qn("r:embed"), new)
    tree = slide.shapes._spTree
    next_id = max((int(e.get("id")) for e in tree.iter(qn("p:cNvPr"))), default=1) + 1
    for number, properties in enumerate(shape.iter(qn("p:cNvPr")), next_id):
        properties.set("id", str(number))
    # Named after the icon in PowerPoint's selection pane.
    shape.find(f"./*/{qn('p:cNvPr')}").set("name", meta.get("title") or ref)
    # Only the top-level size changes: a group's children scale with it.
    xfrm = shape.find(f"./*/{qn('a:xfrm')}")
    ext, off = xfrm.find(qn("a:ext")), xfrm.find(qn("a:off"))
    height = int(int(width) * int(ext.get("cy")) / max(int(ext.get("cx")), 1))
    off.set("x", str(int(left)))
    off.set("y", str(int(top)))
    ext.set("cx", str(int(width)))
    ext.set("cy", str(height))
    tree.insert_element_before(shape, "p:extLst")
    return meta
