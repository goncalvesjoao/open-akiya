# Tsubata geographic reference review

Reviewed 17 October 2026 (Asia/Tokyo) for [#33](https://github.com/goncalvesjoao/open-akiya/issues/33). Reference setup is separate from live listing-source activation and the #36 pilot.

## Reference and private-use route

Use the official [MLIT N03 2026 edition](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html): administrative polygons as of 1 January 2026, JGD2011 geographic coordinates, CC BY 4.0, source reproduction approval `R 7JHf 351`. Provisional boundaries are possible. It supersedes the 2023 candidate in the [initial investigation](first-live-source.md).

The archive metadata says reproducing this product requires GSI approval. That restricts distributing the boundary with the repository or app; it does not establish that private local use is blocked. [GSI's Q&A](https://www.gsi.go.jp/LAW/2930-qa.html), Q1-1/Q1-2, describes private/limited internal use and the attribution-only internal-use exception. Q2-3 distinguishes public dissemination. The implementation uses an individually acquired local reference file, outside the repository/app package. No polygon or derived reference artifact is distributed. This is the project's scoped interpretation for local personal use, not general clearance for redistribution or public map hosting.

[MLIT terms](https://nlftp.mlit.go.jp/ksj/other/agreement_01.html) require attribution, disclosure of processing and respect for other rights. Keep source and processing notices with local derived output. Sharing the reference, publishing derived geometry or deploying for public use requires a separate applicable approval/exception review; the private-use route does not authorize those activities.

## Pinned edition and identity

One [Ishikawa archive](https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2026/N03-20260101_17_GML.zip) was downloaded privately with a 16 MB ceiling. No listing CSV, linked listing asset or catalog API was requested. The ZIP's metadata is CP932; the GeoJSON is UTF-8.

| Artifact                                     | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `N03-20260101_17_GML.zip` (12,955,499 bytes) | `ab14f6819ec6eb683a71014c87d524de3f77acd4872f8008221278303ff8c641` |
| `KS-META-N03-20260101_17.xml`                | `f1fb8dfe87f4faa48d4e7f6ec263d319c006f30c3941be1d49ccf2de94de7cba` |
| `N03-20260101_17.geojson`                    | `348149cca7c04b9ac6d942229e894cc9922a74734e0ac6f06d994f1bca9376bc` |

The GeoJSON contains one feature with `N03_007=17361`, `N03_001=石川県`, `N03_003=河北郡`, `N03_004=津幡町`. This establishes the reference identity for CSV code `173614`. The [official J-LIS directory](https://www.j-lis.go.jp/spd/code-address/tyuubu/cms_13814182.html) also lists `173614` for 津幡町 (page last updated 2020-01-01; not a new boundary edition). The CSV adapter independently requires that six-digit code; the check digit is not part of N03's five-digit administrative code. The weighted sum of the first five digits is 73, giving check digit 4. The pinned reference represents January 2026, not an assertion of continuous boundary currency. A version/hash mismatch must fail closed rather than accepting another boundary edition silently.

## Setup and behavior

The worker module `src/main/tsubata-geography.ts` loads the individually acquired pinned GeoJSON from a private local path, binds reference/query versions to its fingerprint and geometry algorithm, and uses the same geometry for discovery and municipality grouping. Missing or invalid references remain unsupported. Merely installing geographic support does not enable live collection.

No real boundary coordinates are committed in code or fixtures. Routine tests use authored synthetic polygons and source-shaped synthetic HTTP responses at the worker job API. Manual verification against the private official reference records results and provenance without redistributing the input. The municipality summary point represents the municipality, never a home; no in-circle home membership or distance can be inferred from coarse source addresses.

### Local setup

Download the linked ZIP directly from MLIT for your own local use, verify its archive checksum above, and extract `N03-20260101_17.geojson` into a private directory outside the checkout. Preserve the original file bytes; reformatting JSON changes its checksum. Do not add the archive, extracted files or derived marker coordinates to Git or the release package.

The worker-side composition is explicit:

```ts
const geography = loadTsubataGeography(privateReferencePath)
const runtime = new ImportRuntime(privateDatabasePath, 0, {
  ...geography.runtimeOptions,
  adapters: [tsubataAdapter(geography.adapterOptions)],
  // The existing bounded worker transport is supplied by the caller.
})
```

This is reference configuration for the existing job API, not a new IPC operation or source-activation flag. It does not itself install a live transport or change the desktop's default synthetic adapter. The #36 pilot must use the established transport, remaining source gates and explicit user initiation. Reuse the returned runtime and adapter options together so discovery and saved-result membership share the same boundary/version.

## Verified intersection and representative behavior

Algorithm `tsubata-spherical-edges-scanline-v1` tests center inclusion and distance to every outer/hole boundary edge. Great-circle edge distances use the shared mean-Earth radius of 6,371,000 m. Touches count as intersections, with 1 m conservative tolerance. Ray crossings and representative computation use the supplied longitude/latitude values; no datum transformation or survey precision is claimed. The supported Japanese reference neither crosses the antimeridian nor approaches a pole.

The representative is the midpoint of the widest interior longitude interval over scanlines midway between distinct ring-vertex latitude bands, considering all polygons and excluding holes. This deterministic algorithm needs no arbitrary town-hall coordinate. Provenance includes edition, input checksum, algorithm, CRS convention, license, source and processing notice. A new reference or algorithm changes the reference/query version and prevents old coverage from silently representing new semantics.

Private manual verification loaded the pinned file and used synthetic CSV responses through the real worker job API. A circle centered inside the municipality and a circle centered outside but overlapping its edge each made one charged export request and returned one municipality-only group. Two nonintersecting circles each made zero requests and returned no listings. No live listing transport was used. Independent Shapely 2.2.0/pyproj 3.8.0 checks agreed on those selections; Shapely also verified the locally derived representative lies on the actual polygon surface. Coordinates and input geometry remain private, outside Git. Evidence is retained at `/tmp/issue33-real-geography-result.log` and `/tmp/issue33-private-representative.json`; routine tests need neither file nor network access.
