# Address and place search

Search places sends the submitted text to an operator-configured **self-hosted Nominatim** service. Nothing is sent while typing. Choose a returned match explicitly to move the selected circle; the accepted radius and Show unavailable setting are preserved. A location match is an area center, never evidence of listing availability or a precise house position. Map and coordinate controls work without search configuration or network access. Search never starts an import or infers missing listing locations.

## Free provider setup

Nominatim is open-source and needs no paid subscription or API key. Running it is optional and requires PostgreSQL/PostGIS, Nominatim and disk space for an OpenStreetMap extract; this is separate from Open Akiya's embedded listing database. Follow the official [installation instructions](https://nominatim.org/release-docs/latest/admin/Installation/) for your platform, then the [database import guide](https://nominatim.org/release-docs/latest/admin/Import/). Start with a small Japanese region extract, or import Japan for wider coverage. Use the default full import style, with forward-search indexes (do not use reverse-only). From your Nominatim project directory:

```sh
nominatim import --osm-file /absolute/path/to/japan-or-region.osm.pbf
nominatim admin --check-database
nominatim search --query 京都
nominatim serve
```

The final command starts the development HTTP frontend on port 8088 for local use (install the API frontend dependencies described in the import guide). For a durable remote service, follow Nominatim's linked deployment guide and use HTTPS. Start Open Akiya with the complete search endpoint:

```sh
OPEN_AKIYA_LOCATION_SEARCH_URL=http://127.0.0.1:8088/search npm run dev
# Or launch an installed application from an environment with the same variable:
OPEN_AKIYA_LOCATION_SEARCH_URL=http://127.0.0.1:8088/search /path/to/Open-Akiya.AppImage
```

Fully quit and restart Open Akiya after changing the variable; opening a second instance uses the existing process. With the provider running, try `京都` and `Kyoto`, submit Search places, and choose a match. Japanese names are retained. Latin-script matches depend on the names present in your imported OSM data; neither exhaustive addresses nor translations are promised. The request uses Nominatim's [documented search API](https://nominatim.org/release-docs/latest/api/Search/), Japan's `countrycodes=jp` filter, five matches at most, address details and preferred result languages `ja,en`. Display labels contain only the provider's context; missing detail is never invented.

## Transport, permissions and limits

The utility-process worker makes HTTP requests, using an identifying Open Akiya User-Agent. The sandboxed renderer only invokes the fixed `searchLocations` preload operation; it cannot choose an endpoint or read provider configuration. There are no credentials in the renderer, database or repository. Endpoints must be HTTPS, or HTTP on loopback for a local server. Usernames/passwords, query parameters, fragments and redirects are rejected. Secret-bearing services are not directly supported: use a trusted operator-controlled proxy that holds any credentials outside the app. Configure only a service you own and permit this app to use. A remote service receives your search text and IP address; do not submit confidential information. Provider errors never reveal endpoint URLs or raw response text.

The implementation allows one in-flight request and no more than one new request per second per running application. It caches up to 100 successful query responses in worker memory until app exit. A provider's 429 response is recoverable by retrying after its Retry-After interval (seconds or HTTP date); requests time out after eight seconds. Configure any stricter limits or aggregate multi-user limits at your own server/proxy. Search results are not persisted in SQLite. Endpoint changes require no software update.

The OSM Foundation's public Nominatim endpoint is **not enabled and is rejected by configuration validation**. Its [public service usage policy](https://operations.osmfoundation.org/policies/nominatim/) requires an aggregate application-wide maximum of one request per second, identification, attribution, service switching and restrictions on generated place-search integrations; independent desktop installations cannot ensure its aggregate limit. That policy explicitly does not govern self-hosted Nominatim. This implementation deliberately uses self-hosting rather than silently transferring load to that public service. It performs no autocomplete, bulk queries or periodic lookups.

## Attribution and verification

OpenStreetMap contributor attribution and an [ODbL/license link](https://www.openstreetmap.org/copyright) remain visible beside search, including after a match is selected. Provider-returned attribution is rendered as text alongside matches. Respect ODbL obligations if exporting or redistributing provider data; the app's MIT code license does not replace OSM licensing.

Tests never contact live geocoding or listing services. React tests control the public desktop search boundary, transport tests control HTTP responses, and the existing Electron selected-area journey uses a loopback provider to verify sandboxed IPC, keyboard selection, actual map/circle movement, retained radius, mobile layout and no import until the user explicitly starts one. A production Japan database was not installed or live-queried as part of automated validation.
