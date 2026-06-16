# Data license

> **This tool does not include, host, or redistribute any data.**
> `strahlenschutz-cli` is a *client*. It only accesses data served live by the
> **Bundesamt für Strahlenschutz (BfS)** via the IMIS WFS. That data is the BfS's
> and is governed by **their** terms, summarized below. The license of this CLI's
> own source code is a separate matter — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Bundesamt für Strahlenschutz (BfS) |
| **API / source** | `https://www.imis.bfs.de` (IMIS WFS) · portal: https://odlinfo.bfs.de/ |
| **Data license** | **Datenlizenz Deutschland – Namensnennung – Version 2.0 (`dl-de/by-2-0`)** (substantively equivalent to CC BY) |
| **License text** | https://www.govdata.de/dl-de/by-2-0 · BfS Geoportal: https://www.imis.bfs.de/geoportal/resources/sitepolicy.html |
| **Attribution** | **Required** (name the source + license + link). |
| **Commercial use** | Allowed (`dl-de/by-2-0`). |
| **Redistribution / modification** | Permitted under `dl-de/by-2-0` with attribution (but see caveat). |

## Attribution

```
Datenquelle: Bundesamt für Strahlenschutz (BfS), ODL-Info —
Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0),
https://www.govdata.de/dl-de/by-2-0
```

The WFS `GetCapabilities` reports `Fees=NONE` and `AccessConstraints=NONE`
(open, no key).

## Notes & caveats

- **Two framings exist on BfS sites.** The BfS **Geoportal** site policy explicitly
  applies `dl-de/by-2-0` (which permits modification with attribution). Older
  `odlinfo.bfs.de` wording uses classic § 62 UrhG language calling alteration of
  the data/title/copyright designation "grundsätzlich verboten". Treat
  `dl-de/by-2-0` as governing, but follow the no-alteration-of-source/title
  wording conservatively.
- Per-dataset specifics: *"Die konkreten Lizenzen entnehmen Sie bitte den
  beschreibenden Metadaten des jeweiligen Datensatzes."*
- BfS requests gamma dose-rate data be presented factually ("in sachlicher Art und
  Weise") in publications.

## Sources

- https://www.imis.bfs.de/geoportal/resources/sitepolicy.html — Geoportal site policy (`dl-de/by-2-0`)
- https://odlinfo.bfs.de/ODL/DE/service/downloadbereich/downloadbereich_node.html — BfS ODL terms / attribution wording
- https://www.govdata.de/dl-de/by-2-0 — license text

---

*Good-faith summary compiled 2026-06-16; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*
