# Tsubata geographic reference review

Reviewed 17 October 2026 (Asia/Tokyo) for [#33](https://github.com/goncalvesjoao/open-akiya/issues/33). This records reference research, not a live listing pilot or approval to activate the source.

## Pinned candidate and provenance

The official [MLIT N03 2026 edition](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html) describes administrative polygons as of 1 January 2026, in JGD2011 geographic coordinates. It labels reuse CC BY 4.0 and identifies source reproduction approval `R 7JHf 351`. Provisional boundaries remain possible. This edition supersedes the 2023 candidate in the [initial investigation](first-live-source.md).

One [Ishikawa archive](https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2026/N03-20260101_17_GML.zip) was downloaded privately, with a 16 MB acquisition ceiling. No listing CSV, linked assets or catalog API was requested.

| Artifact                      |      Bytes | SHA-256                                                            |
| ----------------------------- | ---------: | ------------------------------------------------------------------ |
| `N03-20260101_17_GML.zip`     | 12,955,499 | `ab14f6819ec6eb683a71014c87d524de3f77acd4872f8008221278303ff8c641` |
| `KS-META-N03-20260101_17.xml` |          — | `f1fb8dfe87f4faa48d4e7f6ec263d319c006f30c3941be1d49ccf2de94de7cba` |
| `N03-20260101_17.geojson`     |          — | `348149cca7c04b9ac6d942229e894cc9922a74734e0ac6f06d994f1bca9376bc` |

The GeoJSON contains one feature with `N03_007=17361`, `N03_001=石川県`, `N03_003=河北郡`, `N03_004=津幡町`. This establishes the reference-side identity for the proposed crosswalk to CSV code `173614`; the CSV must still validate its own municipality code. No geometry has been copied into the repository, simplified, transformed or installed. No representative point has been derived or approved for display.

## Edition-specific blocker

The archive's CP932-encoded `KS-META-N03-20260101_17.xml`, lineage statement, says:

> 本製品を複製する場合には、国土地理院の長の承認を得なければならない。

The [general MLIT terms](https://nlftp.mlit.go.jp/ksj/other/agreement_01.html) require attribution, disclosure of processing and respect for other rights. [MLIT's FAQ](https://nlftp.mlit.go.jp/ksj/other/faq.html), Q3/Q4, allows software bundling under the applicable dataset conditions. Neither is evidence that this project holds the edition-specific reproduction approval. [GSI's procedure](https://www.gsi.go.jp/LAW/2930-index.html) distinguishes uses that require approval from exceptions; no applicable exception or approval for distributing this boundary has been established here. This is an unresolved project clearance, not a claim that every possible use requires an application.

Before installing real geometry, establish the applicable approval or documented exception for the intended distribution, or review an alternative official reference and its edition-specific conditions. Then retain attribution/license and processing notices, pin the distributed subset checksum, verify code crosswalk and intersection behavior, and derive a reproducible point on surface with algorithm/version and CRS provenance. Do not substitute a town-hall coordinate or a bounding circle as a real boundary.

## Current behavior and remaining acceptance

The default Tsubata adapter remains unsupported and makes no requests without reviewed geographic support. Tests explicitly inject fictional scope evidence. Supported nonintersecting selections make no export request; supported intersections may acquire only the single allowed town export within existing bounds. Fictional municipality groups exercise the existing saved-results contract, including a representative outside the selected circle and unknown home distances.

These tests do not validate real Tsubata intersections or representative-point provenance. #33's real-reference acceptance and #36's live-pilot gate remain incomplete. Access, temporal offer identity and residential eligibility remain separate activation gates. No source activation or operator outreach was performed.
