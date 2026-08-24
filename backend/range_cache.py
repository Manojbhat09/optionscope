# backend/range_cache.py
"""Coverage-tracking cache for "give me rows for entity X between [start, end]"
data — the shape the options-orders fetch actually has. This is the single
implementation of the coverage-check logic that used to be hand-rolled (and
buggy — see the "any overlap" vs "fully covered" bug this replaces) inside
get_rh_options_app.py.

A cache entry tracks the date range it actually covers plus when it was last
synced, so a lookup can tell the caller not just "hit or miss" but exactly
what to do about a partial hit:
  - request fully inside the cached range and still fresh -> serve from cache,
    no network call at all.
  - cached range's start is later than the request -> no way to cheaply
    extend backwards (the upstream API has no way to fetch an isolated older
    slice), caller must do a full fetch from `start`.
  - cached range's start already covers the request but the cache is stale
    -> caller only needs to sync forward from the cached end, not refetch
    everything. This is what makes repeat "fetch data" calls fast.
"""

import time


class Lookup:
    __slots__ = ('rows', 'covers_request', 'stale', 'sync_from')

    def __init__(self, rows, covers_request, stale, sync_from):
        self.rows = rows                    # cached rows, or None if nothing cached at all
        self.covers_request = covers_request  # True -> serve straight from `rows`, no fetch needed
        self.stale = stale                  # True -> cached upper bound can't be trusted as-is
        self.sync_from = sync_from          # date to fetch from to bring the cache up to date


class RangeCoverageCache:
    def __init__(self, store, refresh_ttl_seconds=None):
        self.store = store
        self.refresh_ttl_seconds = refresh_ttl_seconds

    def lookup(self, key, start, end):
        entry = self.store.get(key)
        if not entry:
            return Lookup(rows=None, covers_request=False, stale=True, sync_from=start)

        covered_start = entry['covered_start']
        covered_end = entry['covered_end']
        synced_at = entry['synced_at']

        lower_covered = start >= covered_start
        if not lower_covered:
            # Cache doesn't reach back far enough. The upstream API (Robinhood)
            # only supports "from start_date to now", not an isolated slice,
            # so there's no cheap way to backfill just the missing gap —
            # caller has to do a full fetch from `start`.
            return Lookup(rows=entry['rows'], covers_request=False, stale=True, sync_from=start)

        age = time.time() - synced_at
        stale = self.refresh_ttl_seconds is not None and age > self.refresh_ttl_seconds
        upper_covered = (not stale) and end <= covered_end

        return Lookup(
            rows=entry['rows'],
            covers_request=lower_covered and upper_covered,
            stale=stale,
            sync_from=covered_end,
        )

    def put(self, key, rows, covered_start, covered_end, merge_with_existing=True, dedupe_key=None):
        """Store `rows`, extending any existing cached coverage rather than
        replacing it. `dedupe_key(row) -> hashable` identifies the same
        logical row across old and new data (required whenever the new fetch
        may overlap what's already cached — an incremental sync always does,
        since it re-covers the last-known end date to catch updates)."""
        entry = self.store.get(key) if merge_with_existing else None
        if entry:
            covered_start = min(covered_start, entry['covered_start'])
            covered_end = max(covered_end, entry['covered_end'])
            if dedupe_key:
                merged = {dedupe_key(row): row for row in entry['rows']}
                merged.update({dedupe_key(row): row for row in rows})  # new rows win on conflict
                rows = list(merged.values())
            else:
                rows = entry['rows'] + rows

        self.store.set(key, {
            'covered_start': covered_start,
            'covered_end': covered_end,
            'synced_at': time.time(),
            'rows': rows,
        })

    def delete(self, key):
        self.store.delete(key)
