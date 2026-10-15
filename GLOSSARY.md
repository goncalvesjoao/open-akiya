# Open Akiya

Open Akiya helps people explore vacant-home offers from akiya banks within an area they choose.

## Language

**Listing**:
A source's offer to sell or rent a property, with a reference back to that source. Separate sale and rental offers may concern the same property.
_Avoid_: House, property (when referring to the offer)

**Selected area**:
A geographic circle chosen by the user, defined by a center and a positive radius of at most 10 km.
_Avoid_: Viewport, municipality (as synonyms for the selected circle)

**Area import**:
A user-requested attempt to discover and refresh listings relevant to a selected area. It does not guarantee complete inventory or exact locations for every candidate.
_Avoid_: Nationwide crawl, nightly scan

**Uncertain-location listing**:
A listing whose published position or accuracy has not been verified. It may have a source-provided position suitable for an explicitly unverified pin, or only a known municipality suitable for a municipality summary pin.
_Avoid_: Unlocated house (when a municipality is known)

**Municipality summary pin**:
A distinct map marker representing listings with only a known municipality, with their count and a list of the offers. Its position represents the municipality rather than any individual house.
_Avoid_: House pin, property location

**Unverified listing pin**:
An individual marker at a source-provided position whose accuracy has not been verified. Its label communicates that the position, and potentially its distance from the selected center, is uncertain.
_Avoid_: Verified house location

**Discovery checkpoint**:
A verified date boundary reached by a completed discovery scan for a particular source and covered area. It supports finding new offers without treating the newest listing elsewhere as evidence that an area has already been checked.
_Avoid_: Database's newest date, last import time

**Listing refresh**:
A check of a known offer for changes to its details or availability. This is distinct from discovering offers not previously known.
_Avoid_: New-listing search

**Manual refresh**:
A user-requested area import that bypasses freshness-based cache reuse while retaining request limits and reuse of active work.
_Avoid_: Unlimited rescan

**Search continuation**:
A user-requested continuation of an incomplete area search from its saved progress. Results remain partial until the required discovery work completes.
_Avoid_: Automatic full rescan
