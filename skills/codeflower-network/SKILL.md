---
name: codeflower-network
description: This sandbox's network is isolated to an allowlist. Use whenever a download, install (pip, uv, conda, npm, git clone), API call or web request fails or is about to be made, to find out which hosts are reachable and how to ask the user for more.
---

# Working in a network-isolated sandbox

The user started this sandbox with its network isolated, so their data cannot
leave it. The sandbox has no network of its own; the code flower app,
outside the sandbox, is its only way out and lets through only:

- your own service (the model API you run on), and
- the hosts in an allowlist file on the user's computer, which only the user can edit.

Everything goes through the proxy in `HTTPS_PROXY` (already set; pip, uv,
conda, git, curl and Node use it). There is no DNS and no other route out, so a
refused or unlisted host fails with errors like:

- `403 Forbidden` / `codeflower: pypi.org:443 is not on the allowlist (/path/to/file)`
- `Could not resolve host`, `Name or service not known`, `ProxyError`, `Tunnel connection failed: 403`

## What to do

1. Run `codeflower-network` to see the reachable hosts and the allowlist file's
   path on the user's computer. `codeflower-network check HOST` tests one host.
2. When a task needs a host that is not allowed, **stop and ask the user**. Say
   exactly which lines to add to which file, and why, for example:

   > Installing scanpy needs the Python package index. To allow it, add this
   > line to `/home/ana/.codeflower/projects/study42.allowed-hosts.txt`:
   > ```
   > @pypi
   > ```
   > Tell me when it is done; changes apply immediately, no restart needed.

3. After the user confirms, run `codeflower-network check HOST`, then retry.
4. If the user declines, work with what is reachable (packages already
   installed in the image or the project environment) and say what you could
   not do.

Never try to get around the proxy (other ports, other hosts serving the same
content, encoding data into allowed requests): the isolation is the user's
decision about their data.

## Hosts commonly needed

Ask only for what the task needs. Every allowed host is also a place data
could be sent to, so prefer hosts that only serve downloads, and mention it
when a host also accepts uploads (`@github`, `@huggingface`).

A line `@name` in the file allows every host of one service. `codeflower-network`
lists the presets with their hosts; prefer a preset to single hosts when one fits:

| Need | Line |
|---|---|
| pip / uv (PyPI) | `@pypi` |
| conda (conda-forge, bioconda) | `@conda` |
| R packages | `@cran`, `@bioconductor` |
| npm | `@npm` |
| Hugging Face models and datasets | `@huggingface` |
| GitHub downloads (`git clone`, release files, raw files) | `@github` |
| NCBI (E-utilities, Datasets, GEO, SRA) | `@ncbi` |
| Ensembl, UniProt, EMBL-EBI (ENA, Expression Atlas) | `@ensembl`, `@uniprot`, `@ebi` |

For anything else, ask for single hosts. Lines may use `*.example.org` for
every subdomain and `example.org:8443` for another port.
