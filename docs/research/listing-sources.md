# Listing source research

Research date: 15 October 2026. Source access and reuse findings support the [live-source specification](../specs/live-area-source-integration.md); they do not establish enabled adapters or complete inventory.

## Sources to start with

| Priority | Bank                                       | URL                                                                   | Role                                                                                                        |
| -------- | ------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1        | At Home 全国版 空き家・空き地バンク        | https://www.akiya-athome.jp/                                          | National search across participating municipal banks.                                                       |
| 1        | LIFULL HOME’S 空き家バンク                 | https://www.homes.co.jp/akiyabank/                                    | Second national operator; integrate separately and reconcile overlapping properties.                        |
| 2        | Individual municipal and prefectural banks | Discover through the national banks and municipal government websites | Fill measured geographic gaps, prioritizing sources with documented open-data downloads or permitted feeds. |

[MLIT identifies At Home and LIFULL as the two national-bank operators](https://www.mlit.go.jp/totikensangyo/const/sosei_const_tk3_000131.html). These are the best initial candidates for broad coverage, but that does **not** establish that they contain most available akiya in Japan. Vacant homes, homes marketed for sale, and bank registrations are different populations. Measure coverage by municipality; do not advertise completeness.

[MLIT’s integration project explicitly reports duplicates between the two operators](https://www.mlit.go.jp/links/use-cases/4733.html). Adding their listing counts would overstate unique coverage. Both banks also cover vacant land; the initial import should select residential buildings and keep sale and rental offers distinct.

Before enabling each adapter, record its documented access method, terms URL, robots rules, permitted fields, attribution, image rights, rate limit, and review date. Prefer an operator-provided API, partner feed, or licensed export. Public browsing is not permission to bulk collect or republish descriptions and images. An undocumented endpoint used by a website is not a supported integration API. If collection or reuse is prohibited or unclear, leave that source disabled and pursue a permitted feed or municipal open data. No operator outreach is part of this plan’s execution.

Specific access findings:

- [At Home’s terms, articles 4 and 8](https://www.akiya-athome.jp/contents/index/?page=kiyaku) restrict special access beyond ordinary browser use, excessive load, unapproved commercial use, and unauthorized content use.
- [LIFULL HOME’S terms, articles 6 and 16](https://www.homes.co.jp/kiyaku/) restrict unauthorized content reuse and commercial activities. Confirm the proposed collection, storage, and public display rights separately.
- [At Home’s documented municipal API connection](https://www.athome.co.jp/corporate/news/release/services/akiya-bank-202304/) sends municipal data into At Home; it does not establish a nationwide public read API.
- No documented public nationwide read API, bulk export, RSS feed, or open redistribution license was located for either operator in this research. A private partnership option may exist. At Home offers an [official consultation route](https://www.akiya-athome.jp/contents/87); verify LIFULL’s current contact route when pursuing access.
