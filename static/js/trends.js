// Trends section — Chart.js time series with moon-phase background bands.

(function () {

    // Species Deltas table: minimum trip count required in *each* window
    // (not combined) before a species gets a real Delta % — a combined
    // floor still let a 4-trip window divide by a 1-trip window and print
    // "+1741%" on real data during testing, so both sides must clear this
    // independently. Tunable; see FISH-002.
    const DELTA_MIN_TRIPS_PER_WINDOW = 2;

    const _tr = {
        reports: [],
        dates: [],
        allSpecies: [],
        allBoats: [],
        chart: null,
        speciesMS: null,
        boatsMS: null,
        mode: 'species',    // 'species' | 'boat'
        metric: 'total',    // 'total' | 'perAngler'
        smoothing: 0,       // 0 | 7 | 14
        rangeDays: 90,      // 30 | 90 | 365 | 0 (all)
        attribution: 'asReported', // 'asReported' | 'spread'
        aggregation: 'daily', // 'daily' | 'weekly' — one point per day, or one per 7-day bucket
        breakdown: {},      // breakdown[bucketKey][groupLabel][subLabel] = { count, trips: [{ tripDays, dayIndex, totalDays }] }
        bucketRanges: {},   // bucketRanges[bucketKey] = { start, end } — for the weekly tooltip title
        display: 'chart',      // 'chart' | 'table' — Species Deltas table toggle
        deltaWindow: 7,         // 7 | 14 | 30 — comparison window length in days
        deltaMetric: 'perAngler', // 'perAngler' | 'total' — independent of the chart's Metric
    };

    // Bars (not a connected line) only for the Total Trips metric — weekly
    // aggregation stays a line, just with fewer, further-apart points.
    // Shared by createChart() (picks chart type) and the segmented-control
    // handlers (decide whether to recreate the chart).
    function chartTypeIsBar() {
        return _tr.metric === 'totalTrips';
    }

    window.initTrendsSection = function (reports) {
        _tr.reports = reports;
        _tr.dates = [...new Set(reports.map(r => r.date))].filter(Boolean).sort();
        _tr.allSpecies = [...new Set(reports.map(r => r.species).filter(Boolean))].sort();
        _tr.allBoats   = [...new Set(reports.map(r => r.boat).filter(Boolean))].sort();

        const mount = document.getElementById('trendsSection');
        if (!mount) return;
        if (typeof Chart === 'undefined') {
            mount.innerHTML = '<div class="trends-empty">Chart library failed to load.</div>';
            return;
        }

        mount.innerHTML = `
            <div class="app-section">
                <div class="section-toolbar">
                    <div>
                        <div class="toolbar-title">Trends</div>
                        <div class="toolbar-sub">Daily fish counts over time, with moon-phase background bands.</div>
                    </div>
                </div>

                <div class="trends-body">
                    <div class="trends-control-row">
                        <label>Display</label>
                        <div id="tr-display"></div>
                    </div>

                    <div class="trends-panel" id="tr-chart-panel">
                        <div class="trends-panel-label">Chart options</div>
                        <div class="trends-control-row" id="tr-chart-controls-1">
                            <label>View</label>
                            <div id="tr-mode"></div>
                            <div id="tr-species-ms"></div>
                            <div id="tr-boats-ms" hidden></div>
                        </div>

                        <div class="trends-control-row" id="tr-chart-controls-2">
                            <label>Metric</label>
                            <div id="tr-metric"></div>
                            <label style="margin-left: var(--space-3);">Aggregation</label>
                            <div id="tr-aggregation"></div>
                            <label style="margin-left: var(--space-3);">Smoothing</label>
                            <div id="tr-smoothing"></div>
                            <label style="margin-left: var(--space-3);">Range</label>
                            <div id="tr-range"></div>
                        </div>

                        <div class="trends-control-row" id="tr-metric-hint-row" hidden>
                            <span class="trends-hint" id="tr-metric-hint">
                                Per angler/day = total catch ÷ (anglers × trip length in
                                legal-limit days) — e.g. a 3-day trip's anglers count 3× toward
                                the total, so the rate is directly comparable to California's daily
                                bag limit, not just raw catch per person. Matches the \u{1F3C6} shown
                                in this chart's tooltips and the Daily Reports tab's per-limit-day figure.
                            </span>
                        </div>
                    </div>

                    <div class="trends-panel" id="tr-table-panel" hidden>
                        <div class="trends-panel-label">Table options</div>
                        <div class="trends-control-row" id="tr-delta-controls">
                            <label>Window</label>
                            <div id="tr-delta-window"></div>
                            <label style="margin-left: var(--space-3);">Compare by</label>
                            <div id="tr-delta-metric"></div>
                            <span class="trends-hint">
                                Compares the most recent window to the one immediately before it.
                                "Total count" sums every boat's catch — a hot multi-day bite can run into
                                the thousands even with the bite unchanged per angler.
                            </span>
                        </div>
                    </div>

                    <div class="trends-control-row" id="tr-attribution-row">
                        <label>Attribution</label>
                        <div id="tr-attribution"></div>
                        <span class="trends-hint" id="tr-attribution-hint">
                            How multi-day trip catches are distributed across the calendar.
                        </span>
                    </div>

                    <div class="trends-chart-title" id="trends-chart-title"></div>

                    <div class="trends-chart-wrap" id="trends-chart-wrap">
                        <canvas id="trends-chart"></canvas>
                    </div>

                    <div class="trends-table-wrap" id="trends-table-wrap" hidden>
                        <table class="trends-delta-table" id="species-delta-table"></table>
                    </div>

                    <div class="trends-legend-note" id="trends-legend-note">
                        <span><span class="trends-legend-swatch new"></span>new moon (\u00B11 day)</span>
                        <span><span class="trends-legend-swatch full"></span>full moon (\u00B11 day)</span>
                        <span class="trends-click-hint">Tip: click/tap any day to update its Daily Report.</span>
                    </div>
                </div>
            </div>
        `;

        // Segmented controls
        _tr.displaySeg = UI.makeSegmented({
            container: document.getElementById('tr-display'),
            options: [
                { value: 'chart', label: 'Chart' },
                { value: 'table', label: 'Table' }
            ],
            selected: _tr.display,
            onChange: v => {
                _tr.display = v;
                applyDisplayUI();
                if (v === 'table') renderDeltaTable();
                else if (_tr.chart) _tr.chart.resize();
            }
        });

        UI.makeSegmented({
            container: document.getElementById('tr-delta-window'),
            options: [
                { value: '7',  label: '7d' },
                { value: '14', label: '14d' },
                { value: '30', label: '30d' }
            ],
            selected: String(_tr.deltaWindow),
            onChange: v => { _tr.deltaWindow = parseInt(v, 10) || 7; renderDeltaTable(); }
        });

        UI.makeSegmented({
            container: document.getElementById('tr-delta-metric'),
            options: [
                { value: 'perAngler', label: 'Per angler' },
                { value: 'total',     label: 'Total count' }
            ],
            selected: _tr.deltaMetric,
            onChange: v => { _tr.deltaMetric = v; renderDeltaTable(); }
        });

        UI.makeSegmented({
            container: document.getElementById('tr-mode'),
            options: [
                { value: 'species', label: 'By species' },
                { value: 'boat',    label: 'By boat' }
            ],
            selected: _tr.mode,
            onChange: v => { _tr.mode = v; onModeChange(); }
        });

        _tr.metricSeg = UI.makeSegmented({
            container: document.getElementById('tr-metric'),
            options: [
                { value: 'total',      label: 'Total fish' },
                { value: 'perAngler',  label: 'Per angler/day' },
                { value: 'totalTrips', label: 'Total trips' }
            ],
            selected: _tr.metric,
            onChange: v => {
                const wasBar = chartTypeIsBar();
                _tr.metric = v;
                if (wasBar !== chartTypeIsBar()) {
                    // Chart.js v4 requires a recreate to swap base type.
                    _tr.chart.destroy();
                    _tr.chart = null;
                    createChart();
                }
                applyMetricUI();
                redraw();
            }
        });

        UI.makeSegmented({
            container: document.getElementById('tr-aggregation'),
            options: [
                { value: 'daily',  label: 'Daily' },
                { value: 'weekly', label: 'Weekly' }
            ],
            selected: _tr.aggregation,
            onChange: v => {
                const wasBar = chartTypeIsBar();
                _tr.aggregation = v;
                if (wasBar !== chartTypeIsBar()) {
                    _tr.chart.destroy();
                    _tr.chart = null;
                    createChart();
                }
                applyMetricUI();
                redraw();
            }
        });

        UI.makeSegmented({
            container: document.getElementById('tr-smoothing'),
            options: [
                { value: '0',  label: 'None' },
                { value: '7',  label: '7-day' },
                { value: '14', label: '14-day' }
            ],
            selected: String(_tr.smoothing),
            onChange: v => { _tr.smoothing = parseInt(v, 10) || 0; redraw(); }
        });

        UI.makeSegmented({
            container: document.getElementById('tr-range'),
            options: [
                { value: '30',  label: '30d' },
                { value: '90',  label: '90d' },
                { value: '365', label: '1y' },
                { value: '0',   label: 'All' }
            ],
            selected: String(_tr.rangeDays),
            onChange: v => { _tr.rangeDays = parseInt(v, 10) || 0; redraw(); }
        });

        UI.makeSegmented({
            container: document.getElementById('tr-attribution'),
            options: [
                { value: 'asReported', label: 'As reported' },
                { value: 'spread',     label: 'Spread multi-day' }
            ],
            selected: _tr.attribution,
            onChange: v => {
                _tr.attribution = v;
                redraw();
                if (_tr.display === 'table') renderDeltaTable();
            }
        });

        // Multi-selects
        _tr.speciesMS = UI.makeMultiSelect({
            container: document.getElementById('tr-species-ms'),
            label: 'Species',
            items: speciesItems(),
            selected: defaultSpeciesSelection(),
            onChange: () => redraw()
        });

        _tr.boatsMS = UI.makeMultiSelect({
            container: document.getElementById('tr-boats-ms'),
            label: 'Boats',
            items: boatItems(),
            selected: new Set(),
            onChange: () => redraw()
        });

        createChart();
        applyMetricUI();
        applyDisplayUI();
        redraw();
    };

    // Called by the tab switcher when Trends becomes visible — forces a
    // resize so the chart doesn't render with stale canvas dimensions from
    // when its parent was hidden.
    window._trOnShow = function () {
        if (_tr.chart) _tr.chart.resize();
    };

    // --- Default selections ------------------------------------------------

    function speciesItems() {
        const totals = {};
        _tr.reports.forEach(r => {
            if (!r.species) return;
            totals[r.species] = (totals[r.species] || 0) + (r.count || 0);
        });
        return _tr.allSpecies
            .map(sp => ({ value: sp, label: sp, meta: (totals[sp] || 0).toLocaleString() }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    function boatItems() {
        const totals = {};
        _tr.reports.forEach(r => {
            if (!r.boat) return;
            totals[r.boat] = (totals[r.boat] || 0) + (r.count || 0);
        });
        return _tr.allBoats
            .map(b => ({ value: b, label: b, meta: (totals[b] || 0).toLocaleString() }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    function defaultSpeciesSelection() {
        const preferred = ['Bluefin Tuna', 'Yellowfin Tuna'];
        const available = new Set(_tr.allSpecies);
        const picks = preferred.filter(s => available.has(s));
        if (picks.length) return new Set(picks);
        // Fall back to top 2 by total count
        return new Set(speciesItems().slice(0, 2).map(i => i.value));
    }

    // Compact, readable rendering of a species/boat selection for the chart
    // title: name the items when there are few, summarize when there are many.
    function seriesLabelList(selected) {
        const arr = [...selected].sort();
        if (!arr.length) return 'No selection';
        if (arr.length <= 2) return arr.join(' & ');
        return `${arr[0]} +${arr.length - 1} more`;
    }

    // Summarizes the current chart configuration — what's plotted, how
    // it's measured, and over what window — as a plain-language title so
    // the reading of the chart doesn't depend on remembering what each
    // control is currently set to.
    function buildChartTitle() {
        const metricLabel = _tr.metric === 'totalTrips' ? 'Total trips'
            : _tr.metric === 'perAngler' ? 'Per angler/day'
            : 'Total fish';

        let dimLabel;
        if (_tr.metric === 'totalTrips') {
            const boats = _tr.boatsMS ? _tr.boatsMS.getSelected() : new Set();
            dimLabel = boats.size ? seriesLabelList(boats) : 'All boats';
        } else if (_tr.mode === 'species') {
            dimLabel = seriesLabelList(_tr.speciesMS.getSelected());
        } else {
            dimLabel = seriesLabelList(_tr.boatsMS.getSelected());
        }

        const aggLabel = _tr.aggregation === 'weekly' ? 'weekly' : 'daily';
        const rangeLabel = !_tr.rangeDays ? 'all time'
            : _tr.rangeDays === 30  ? 'last 30 days'
            : _tr.rangeDays === 90  ? 'last 90 days'
            : _tr.rangeDays === 365 ? 'last year'
            : `last ${_tr.rangeDays} days`;

        return `${dimLabel} — ${metricLabel}, ${aggLabel}, ${rangeLabel}`;
    }

    // --- Aggregation -------------------------------------------------------

    function visibleDates() {
        if (!_tr.dates.length) return [];
        if (!_tr.rangeDays) return _tr.dates;
        const end = _tr.dates[_tr.dates.length - 1];
        const endTs = Date.parse(end + 'T12:00:00Z');
        const startTs = endTs - _tr.rangeDays * 86400000;
        return _tr.dates.filter(d => Date.parse(d + 'T12:00:00Z') >= startTs);
    }

    // Groups visible dates into buckets: one date per bucket for 'daily'
    // (current behavior, unchanged), or non-overlapping 7-day buckets for
    // 'weekly', anchored to the most recent visible date and walking
    // backward — same anchoring the Species Deltas table uses for its
    // comparison windows, so "this week" means the same thing in both
    // places. A bucket's key is its most recent date (used as the chart's
    // x-axis label, so moon bands / tooltip title / click-to-jump-to-date
    // keep working unchanged). Returned oldest-first.
    function buildBuckets(dates, aggregation) {
        if (aggregation !== 'weekly' || !dates.length) {
            return dates.map(d => ({ key: d, dates: [d] }));
        }
        const buckets = [];
        const remaining = dates.slice();
        let cursor = Date.parse(remaining[remaining.length - 1] + 'T12:00:00Z');
        while (remaining.length) {
            const bucketStart = cursor - 6 * 86400000;
            const inBucket = [];
            while (remaining.length &&
                   Date.parse(remaining[remaining.length - 1] + 'T12:00:00Z') >= bucketStart) {
                inBucket.unshift(remaining.pop());
            }
            if (inBucket.length) {
                buckets.unshift({ key: inBucket[inBucket.length - 1], dates: inBucket });
            }
            cursor = bucketStart - 86400000;
        }
        return buckets;
    }

    // date -> the key of the bucket it belongs to, so per-record breakdown
    // accumulation (species/boat tooltip sub-lists) can be filed under the
    // right bucket regardless of aggregation.
    function bucketKeyMap(buckets) {
        const map = {};
        buckets.forEach(b => b.dates.forEach(d => { map[d] = b.key; }));
        return map;
    }

    // For each record, yield one or more (date, weight, tripInfo) entries depending
    // on the current attribution mode. tripInfo carries trip-duration context
    // used by the tooltip: { tripDays, dayIndex, totalDays }.
    function eachAllocation(r, cb) {
        const parsed = (typeof TripDuration !== 'undefined')
            ? TripDuration.parse(r.trip)
            : { tripDays: 1, windowDays: 1 };
        if (_tr.attribution === 'spread' && typeof TripDuration !== 'undefined') {
            TripDuration.allocate(r.date, r.trip).forEach(a => cb(a.date, a.weight, {
                tripDays: parsed.tripDays,
                dayIndex: a.dayIndex,
                totalDays: a.totalDays
            }));
        } else {
            cb(r.date, 1, { tripDays: parsed.tripDays, dayIndex: 1, totalDays: 1 });
        }
    }

    // Build the "(3-day trip)" or "(Day 1 of 3)" suffix shown in the tooltip
    // for a given bucket's trip list.
    function tripSuffix(trips) {
        if (!trips || !trips.length) return '';
        if (_tr.attribution === 'asReported') {
            const uniq = [...new Set(trips.map(t =>
                (typeof TripDuration !== 'undefined')
                    ? TripDuration.formatDays(t.tripDays)
                    : String(t.tripDays)
            ))];
            return `  (${uniq.map(d => `${d}-day trip`).join(' + ')})`;
        }
        // spread — always show, including Day 1 of 1
        const byTotal = {};
        trips.forEach(t => {
            (byTotal[t.totalDays] = byTotal[t.totalDays] || []).push(t.dayIndex);
        });
        const parts = Object.entries(byTotal).map(([total, days]) => {
            const dayList = [...new Set(days)].sort((a, b) => a - b);
            const label = dayList.length === 1
                ? `Day ${dayList[0]}`
                : `Days ${dayList.join(', ')}`;
            return `${label} of ${total}`;
        });
        return `  (${parts.join('; ')})`;
    }

    // A breakdown entry's total legal-limit-days: each contributing trip's
    // own tripDays rounded up to whole days (CA's daily bag limit applies
    // per calendar day a trip covers — a 3-day trip carries 3x the daily
    // allowance), summed across however many trips landed in this entry
    // (more than one when a bucket aggregates several trips, e.g. weekly).
    function entryLimitDays(info) {
        return info.trips.reduce(
            (sum, t) => sum + Math.max(1, Math.ceil(t.tripDays || 1)), 0) || 1;
    }

    // Whether a breakdown entry's catch hit the California daily bag limit,
    // for the 🏆 shown in Per Angler chart tooltips. Reuses SPECIES_DAILY_LIMIT
    // from dashboard.js (loaded after this file, but only read here at hover
    // time, long after all scripts have run — same defensive-global pattern
    // as TripDuration/moonPhase elsewhere in this file) and generalizes its
    // single-trip limitBar math in dashboard.js to a breakdown entry that may
    // aggregate several trips (weekly buckets).
    function hitBagLimit(species, info, limitDays) {
        if (typeof SPECIES_DAILY_LIMIT === 'undefined') return false;
        const limit = SPECIES_DAILY_LIMIT[species];
        if (limit == null || limit <= 0 || !info.anglers) return false;
        return info.count / (info.anglers * limitDays * limit) >= 1;
    }

    // Build one series per selected species: total (or per-angler/day) per
    // bucket across all boats. `buckets` come from buildBuckets() — one
    // date each for 'daily', up to 7 dates each for 'weekly'. Per-angler is
    // computed as a ratio of bucket sums (sum of count / sum of
    // angler-limit-days), not an average of daily ratios — same convention
    // the Species Deltas table uses for its window comparisons.
    //
    // Denominator is angler-LIMIT-DAYS, not raw anglers: `count` is a
    // trip's entire cumulative catch, so a 3-day trip's anglers need to
    // count 3x toward the total or the ratio reads as if the daily bag
    // limit had been blown 3x over when the trip was actually right at it.
    // Matches the Daily Reports tab's "per angler per limit-day" pill and
    // the 🏆 trophy shown in this chart's own tooltips.
    function seriesBySpecies(buckets) {
        const selected = _tr.speciesMS.getSelected();
        if (!selected.size) return [];

        const counts = {};             // counts[date][species] = count
        const anglerLimitDaySum = {};  // anglerLimitDaySum[date] = total angler-limit-days
        // Track which (tripKey, date) pairs we've already counted anglers for,
        // so anglers don't get inflated by multiple species rows on the same trip.
        const anglerSeen = {};
        const dateToBucketKey = bucketKeyMap(buckets);

        _tr.reports.forEach(r => {
            if (!r.date || !r.species || !selected.has(r.species)) return;
            const anglers = parseInt(r.anglers) || 0;
            const tripKey = `${r.date}|${r.boat}|${r.trip}`;
            const countAnglersOnThisRow = !anglerSeen[tripKey];
            if (countAnglersOnThisRow) anglerSeen[tripKey] = true;

            eachAllocation(r, (d, w, tripInfo) => {
                counts[d] = counts[d] || {};
                counts[d][r.species] = (counts[d][r.species] || 0) + (r.count || 0) * w;
                if (countAnglersOnThisRow) {
                    const limitDays = Math.max(1, Math.ceil(tripInfo.tripDays || 1));
                    anglerLimitDaySum[d] = (anglerLimitDaySum[d] || 0) + anglers * limitDays * w;
                }

                // Breakdown: for each species, track catch per boat (with
                // trip info for the tooltip), filed under the whole
                // bucket — not just whichever single date happens to be
                // the bucket's label — so a weekly bar's tooltip shows the
                // full week's mix, not one day of it.
                const boat = r.boat || 'Unknown';
                const bk = dateToBucketKey[d] || d;
                _tr.breakdown[bk] = _tr.breakdown[bk] || {};
                _tr.breakdown[bk][r.species] = _tr.breakdown[bk][r.species] || {};
                const bucket = _tr.breakdown[bk][r.species][boat] =
                    _tr.breakdown[bk][r.species][boat] || { count: 0, anglers: 0, trips: [] };
                bucket.count += (r.count || 0) * w;
                // Each row here is already one distinct trip for this exact
                // species (source data is one row per date/boat/trip/species),
                // so anglers can be summed directly — no dedup needed at this
                // granularity, unlike the coarser per-bucket anglerSum above.
                bucket.anglers += anglers * w;
                bucket.trips.push(tripInfo);
            });
        });

        return [...selected].sort().map(sp => ({
            label: sp,
            data: buckets.map(b => {
                let raw = 0, a = 0;
                b.dates.forEach(d => {
                    raw += (counts[d] && counts[d][sp]) || 0;
                    a += anglerLimitDaySum[d] || 0;
                });
                if (_tr.metric === 'perAngler') {
                    return a > 0 ? raw / a : null;
                }
                return raw || null;
            })
        }));
    }

    // Build a single series of unique trip counts per bucket. Optionally
    // filtered by the Boats multi-select (empty = all boats). Always uses
    // as-reported attribution (a trip "returns" on one specific date) —
    // dedup is scoped per calendar day, then summed across a bucket's
    // dates, so the same boat running the same trip type on two different
    // days within a week still correctly counts as two trips.
    function seriesTotalTrips(buckets) {
        const boatFilter = _tr.boatsMS ? _tr.boatsMS.getSelected() : new Set();
        const usingFilter = boatFilter.size > 0;

        // For each date, collect unique (boat|trip) keys and the underlying
        // trip metadata for the tooltip.
        const counts = {};      // counts[date] = Set<tripKey>
        const meta = {};        // meta[date] = { tripKey: { boat, trip, anglers } }

        _tr.reports.forEach(r => {
            if (!r.date || !r.boat) return;
            if (usingFilter && !boatFilter.has(r.boat)) return;
            const tripKey = `${r.boat}|${r.trip || ''}`;
            counts[r.date] = counts[r.date] || new Set();
            if (!counts[r.date].has(tripKey)) {
                counts[r.date].add(tripKey);
                meta[r.date] = meta[r.date] || {};
                meta[r.date][tripKey] = {
                    boat: r.boat,
                    trip: r.trip || '',
                    anglers: parseInt(r.anglers) || 0
                };
            }
        });

        // Populate breakdown with the tooltip-ready trip list per bucket
        // (union of every contributing date's trips).
        buckets.forEach(b => {
            _tr.breakdown[b.key] = _tr.breakdown[b.key] || {};
            const allTrips = [];
            b.dates.forEach(d => { if (meta[d]) allTrips.push(...Object.values(meta[d])); });
            _tr.breakdown[b.key].__trips = allTrips;
        });

        const label = usingFilter ? 'Total trips (filtered)' : 'Total trips';
        return [{
            label,
            data: buckets.map(b => {
                let sum = 0;
                b.dates.forEach(d => { sum += counts[d] ? counts[d].size : 0; });
                return sum;
            })
        }];
    }

    // Build one series per selected boat: total (or per-angler) per bucket
    // across all species. Mirrors seriesBySpecies() with roles swapped.
    // Mirrors seriesBySpecies() with roles swapped, including the same
    // angler-limit-days denominator for Per angler (see that function's
    // comment for why raw anglers would misrepresent multi-day trips).
    function seriesByBoat(buckets) {
        const selected = _tr.boatsMS.getSelected();
        if (!selected.size) return [];

        const counts = {};             // counts[date][boat]
        const anglerLimitDaySum = {};  // anglerLimitDaySum[date][boat]
        const anglerSeen = {};   // (tripKey) already counted for anglers?
        const dateToBucketKey = bucketKeyMap(buckets);

        _tr.reports.forEach(r => {
            if (!r.date || !r.boat || !selected.has(r.boat)) return;
            const anglers = parseInt(r.anglers) || 0;
            const tripKey = `${r.date}|${r.boat}|${r.trip}`;
            const countAnglersOnThisRow = !anglerSeen[tripKey];
            if (countAnglersOnThisRow) anglerSeen[tripKey] = true;

            eachAllocation(r, (d, w, tripInfo) => {
                counts[d] = counts[d] || {};
                counts[d][r.boat] = (counts[d][r.boat] || 0) + (r.count || 0) * w;
                if (countAnglersOnThisRow) {
                    const limitDays = Math.max(1, Math.ceil(tripInfo.tripDays || 1));
                    anglerLimitDaySum[d] = anglerLimitDaySum[d] || {};
                    anglerLimitDaySum[d][r.boat] = (anglerLimitDaySum[d][r.boat] || 0) + anglers * limitDays * w;
                }

                // Breakdown: for each boat, track catch per species (with
                // trip info for the tooltip), filed under the whole bucket.
                const sp = r.species || 'Unknown';
                const bk = dateToBucketKey[d] || d;
                _tr.breakdown[bk] = _tr.breakdown[bk] || {};
                _tr.breakdown[bk][r.boat] = _tr.breakdown[bk][r.boat] || {};
                const bucket = _tr.breakdown[bk][r.boat][sp] =
                    _tr.breakdown[bk][r.boat][sp] || { count: 0, anglers: 0, trips: [] };
                bucket.count += (r.count || 0) * w;
                bucket.anglers += anglers * w;
                bucket.trips.push(tripInfo);
            });
        });

        return [...selected].sort().map(boat => ({
            label: boat,
            data: buckets.map(b => {
                let raw = 0, a = 0;
                b.dates.forEach(d => {
                    raw += (counts[d] && counts[d][boat]) || 0;
                    a += (anglerLimitDaySum[d] && anglerLimitDaySum[d][boat]) || 0;
                });
                if (_tr.metric === 'perAngler') {
                    return a > 0 ? raw / a : null;
                }
                return raw || null;
            })
        }));
    }

    function rollingAverage(arr, window) {
        if (!window || window < 2) return arr;
        const out = new Array(arr.length).fill(null);
        let sum = 0, cnt = 0;
        const buf = [];
        for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            buf.push(v);
            if (v != null) { sum += v; cnt++; }
            if (buf.length > window) {
                const dropped = buf.shift();
                if (dropped != null) { sum -= dropped; cnt--; }
            }
            out[i] = (cnt > 0 && buf.length >= window) ? sum / cnt : null;
        }
        return out;
    }

    // --- Chart setup -------------------------------------------------------

    function createChart() {
        const root = getComputedStyle(document.documentElement);
        const palette = [1, 2, 3, 4, 5, 6, 7, 8]
            .map(n => root.getPropertyValue(`--chart-${n}`).trim() || '#555');
        const moonNewColor  = root.getPropertyValue('--moon-new').trim()  || 'rgba(100,100,120,0.12)';
        const moonFullColor = root.getPropertyValue('--moon-full').trim() || 'rgba(230,200,110,0.18)';

        const moonBands = {
            id: 'moonBands',
            beforeDatasetsDraw(chart) {
                const { ctx, chartArea, scales } = chart;
                const xScale = scales.x;
                if (!xScale || !chart.data.labels) return;
                const labels = chart.data.labels;
                ctx.save();
                labels.forEach((label, i) => {
                    const info = typeof daysToNearestNewOrFull === 'function'
                        ? daysToNearestNewOrFull(label)
                        : null;
                    if (!info || info.days > 1) return;
                    const x = xScale.getPixelForValue(i);
                    // Stripe width: span to the next label (or +1 day at the edge)
                    const nextX = (i + 1 < labels.length)
                        ? xScale.getPixelForValue(i + 1)
                        : x + (x - xScale.getPixelForValue(Math.max(0, i - 1)));
                    const w = Math.max(2, nextX - x);
                    ctx.fillStyle = info.kind === 'new' ? moonNewColor : moonFullColor;
                    ctx.fillRect(x - w / 2, chartArea.top, w, chartArea.bottom - chartArea.top);
                });
                ctx.restore();
            }
        };

        const canvas = document.getElementById('trends-chart');
        const isBar = chartTypeIsBar();
        _tr.chart = new Chart(canvas.getContext('2d'), {
            type: isBar ? 'bar' : 'line',
            data: { labels: [], datasets: [] },
            options: {
                maintainAspectRatio: false,
                responsive: true,
                events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
                interaction: isBar
                    ? { mode: 'index', axis: 'x', intersect: false }
                    : { mode: 'nearest', axis: 'x', intersect: false },
                onClick(evt, _els, chart) {
                    const points = chart.getElementsAtEventForMode(
                        evt, 'nearest', { intersect: false, axis: 'x' }, false);
                    if (!points.length) return;
                    const date = chart.data.labels[points[0].index];
                    if (date && typeof window._rtJumpToDate === 'function') {
                        window._rtJumpToDate(date);
                    }
                },
                onHover(evt, _els, chart) {
                    const points = chart.getElementsAtEventForMode(
                        evt, 'nearest', { intersect: false, axis: 'x' }, false);
                    chart.canvas.style.cursor = points.length ? 'pointer' : 'default';
                },
                scales: {
                    x: {
                        ticks: {
                            autoSkip: true,
                            maxTicksLimit: 10,
                            color: root.getPropertyValue('--fg-muted').trim() || '#666',
                            font: { size: 11 }
                        },
                        grid: { display: false }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: root.getPropertyValue('--fg-muted').trim() || '#666',
                            font: { size: 11 }
                        },
                        grid: { color: 'rgba(0,0,0,0.05)' }
                    }
                },
                plugins: {
                    legend: {
                        position: 'top',
                        align: 'end',
                        labels: { boxWidth: 10, boxHeight: 10, font: { size: 12 }, padding: 12 }
                    },
                    tooltip: {
                        callbacks: {
                            title(items) {
                                if (!items.length) return '';
                                const d = items[0].label;
                                const m = (typeof moonPhase === 'function') ? moonPhase(d) : null;
                                const range = _tr.bucketRanges[d];
                                let pretty;
                                if (range && range.start !== range.end) {
                                    const s = new Date(range.start + 'T12:00:00Z');
                                    const e = new Date(range.end + 'T12:00:00Z');
                                    const startStr = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                                    const endStr = e.toLocaleDateString('en-US',
                                        { month: 'short', day: 'numeric', year: 'numeric' });
                                    pretty = `Week of ${startStr} – ${endStr}`;
                                } else {
                                    pretty = new Date(d + 'T12:00:00Z').toLocaleDateString('en-US',
                                        { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                                }
                                return m ? `${pretty}  ${m.emoji} ${m.name} (${m.illumination}%)` : pretty;
                            },
                            label(ctx) {
                                const v = ctx.parsed.y;
                                const __date = ctx.chart.data.labels[ctx.dataIndex];
                                if (_tr.metric === 'totalTrips') {
                                    const lines = [`Trips: ${v == null ? 0 : Math.round(v)}`];
                                    const trips = (_tr.breakdown[__date] || {}).__trips || [];
                                    trips.slice()
                                        .sort((a, b) => (a.boat || '').localeCompare(b.boat || ''))
                                        .slice(0, 8)
                                        .forEach(t => {
                                            const anglers = t.anglers ? ` (${t.anglers} anglers)` : '';
                                            lines.push(`  ${t.boat} — ${t.trip || '—'}${anglers}`);
                                        });
                                    if (trips.length > 8) {
                                        lines.push(`  + ${trips.length - 8} more`);
                                    }
                                    return lines;
                                }
                                const fmt = v == null ? '\u2014'
                                    : _tr.metric === 'perAngler'
                                        ? v.toFixed(2) + ' / angler/day'
                                        : Math.round(v).toLocaleString();
                                const lines = [`${ctx.dataset.label}: ${fmt}`];
                                const date = ctx.chart.data.labels[ctx.dataIndex];
                                const sub = _tr.breakdown[date] &&
                                            _tr.breakdown[date][ctx.dataset.label];
                                if (sub) {
                                    Object.entries(sub)
                                        .sort((a, b) => b[1].count - a[1].count)
                                        .slice(0, 8)
                                        .forEach(([name, info]) => {
                                            const suffix = tripSuffix(info.trips);
                                            let line = `  ${name}: ${Math.round(info.count).toLocaleString()}${suffix}`;
                                            if (_tr.metric === 'perAngler') {
                                                // In species mode, name = boat and every sub-line
                                                // shares the outer dataset's species; in boat mode,
                                                // name IS the species (the sub-key varies per line).
                                                const species = _tr.mode === 'species' ? ctx.dataset.label : name;
                                                const limitDays = entryLimitDays(info);
                                                if (info.anglers > 0) {
                                                    line += ` (${(info.count / (info.anglers * limitDays)).toFixed(2)}/angler/day)`;
                                                }
                                                if (hitBagLimit(species, info, limitDays)) line += ' \u{1F3C6}';
                                            }
                                            lines.push(line);
                                        });
                                }
                                return lines;
                            }
                        }
                    }
                }
            },
            plugins: [moonBands]
        });

        _tr.palette = palette;
    }

    function redraw() {
        if (!_tr.chart) return;
        _tr.breakdown = {};
        const dates = visibleDates();
        const buckets = buildBuckets(dates, _tr.aggregation);

        _tr.bucketRanges = {};
        buckets.forEach(b => {
            _tr.bucketRanges[b.key] = { start: b.dates[0], end: b.dates[b.dates.length - 1] };
        });

        let raw;
        if (_tr.metric === 'totalTrips') {
            raw = seriesTotalTrips(buckets);
        } else {
            raw = _tr.mode === 'species' ? seriesBySpecies(buckets) : seriesByBoat(buckets);
        }

        const isBar = chartTypeIsBar();
        // Rolling-average smoothing only makes sense across daily points —
        // its control is hidden in weekly mode (applyMetricUI), but guard
        // here too in case a stale value from a prior daily session lingers
        // into a weekly redraw.
        const smoothingActive = _tr.smoothing && _tr.aggregation !== 'weekly';
        const datasets = raw.map((s, i) => {
            const color = _tr.palette[i % _tr.palette.length];
            if (isBar) {
                return {
                    label: s.label,
                    data: s.data,
                    backgroundColor: color,
                    borderColor: color,
                    borderWidth: 1,
                    borderRadius: 2,
                    barPercentage: 0.9,
                    categoryPercentage: 0.95
                };
            }
            const data = smoothingActive ? rollingAverage(s.data, _tr.smoothing) : s.data;
            return {
                label: s.label,
                data,
                borderColor: color,
                backgroundColor: color,
                borderWidth: 1.6,
                pointRadius: smoothingActive ? 0 : 2,
                pointHoverRadius: 4,
                tension: 0.25,
                spanGaps: true
            };
        });

        _tr.chart.data.labels = buckets.map(b => b.key);
        _tr.chart.data.datasets = datasets;
        const baseTitle = _tr.metric === 'totalTrips' ? 'Trips'
            : _tr.metric === 'perAngler' ? 'Fish per angler/day'
            : 'Fish count';
        // "(weekly total)" only makes sense for a literal sum (Total fish /
        // Total trips) — Per angler/day is a rate, so a weekly bucket
        // reports the same kind of number a daily one does, just averaged
        // over more trips.
        const weeklySuffix = _tr.aggregation === 'weekly' && _tr.metric !== 'perAngler' ? ' (weekly total)' : '';
        _tr.chart.options.scales.y.title = {
            display: true,
            text: `${baseTitle}${weeklySuffix}`,
            color: 'rgba(0,0,0,0.55)',
            font: { size: 11 }
        };
        _tr.chart.options.plugins.legend.display = _tr.metric !== 'totalTrips';
        _tr.chart.update('none');

        const titleEl = document.getElementById('trends-chart-title');
        if (titleEl) titleEl.textContent = buildChartTitle();
    }

    // Toggle visibility / disabled-ness of controls that don't apply to the
    // Total Trips metric (mode, species, smoothing, attribution).
    function applyMetricUI() {
        const isTrips = _tr.metric === 'totalTrips';
        const modeEl       = document.getElementById('tr-mode');
        const speciesEl    = document.getElementById('tr-species-ms');
        const boatsEl      = document.getElementById('tr-boats-ms');
        const smoothingEl  = document.getElementById('tr-smoothing');
        const attrEl       = document.getElementById('tr-attribution');
        const attrHintEl   = document.getElementById('tr-attribution-hint');
        const metricHintRow = document.getElementById('tr-metric-hint-row');

        // Helper: hide/show a control along with its preceding <label>.
        function setHidden(el, hidden) {
            if (!el) return;
            el.hidden = hidden;
            const prev = el.previousElementSibling;
            if (prev && prev.tagName === 'LABEL') prev.hidden = hidden;
        }

        // Explains the angler-limit-days denominator — only relevant when
        // Per angler/day is actually the metric being plotted.
        if (metricHintRow) metricHintRow.hidden = _tr.metric !== 'perAngler';

        if (isTrips) {
            setHidden(modeEl,      true);
            setHidden(speciesEl,   true);
            setHidden(boatsEl,     false);  // keep Boats as an optional filter
            setHidden(smoothingEl, true);
            setHidden(attrEl,      true);
            if (attrHintEl) attrHintEl.hidden = true;
            // NOTE: we don't mutate _tr.attribution here — seriesTotalTrips
            // ignores it anyway, and this preserves the user's choice when
            // they switch back to Total fish / Per angler.
        } else {
            setHidden(modeEl,      false);
            // Rolling-average smoothing doesn't mean anything on top of
            // already-weekly-bucketed points — hide it in that mode too.
            setHidden(smoothingEl, _tr.aggregation === 'weekly');
            setHidden(attrEl,      false);
            if (attrHintEl) attrHintEl.hidden = false;
            // Species vs Boats visibility follows mode.
            setHidden(speciesEl, _tr.mode !== 'species');
            setHidden(boatsEl,   _tr.mode !== 'boat');
        }
    }

    function onModeChange() {
        const speciesEl = document.getElementById('tr-species-ms');
        const boatsEl   = document.getElementById('tr-boats-ms');
        if (_tr.mode === 'species') {
            speciesEl.hidden = false;
            boatsEl.hidden = true;
        } else {
            speciesEl.hidden = true;
            boatsEl.hidden = false;
            // If the user hasn't picked any boats yet, seed with top 3
            if (_tr.boatsMS.getSelected().size === 0) {
                const top = boatItems().slice(0, 3).map(i => i.value);
                _tr.boatsMS.setSelected(top);
            }
        }
        redraw();
    }

    // --- Species Deltas table (Display: Table) ------------------------------
    //
    // A sortable, color-coded table of per-species catch deltas between the
    // most recent comparison window and the one immediately before it —
    // built to answer "is the tuna bite dying down?" at a glance, which is
    // hard to read off overlapping chart lines. See FISH-002.

    // Toggle visibility between the chart controls/canvas and the table
    // controls/table. Attribution stays visible in both modes — it's shared
    // state that affects both views' aggregation.
    function applyDisplayUI() {
        const isTable = _tr.display === 'table';
        const ids = ['tr-chart-panel', 'trends-chart-title', 'trends-chart-wrap', 'trends-legend-note'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.hidden = isTable;
        });
        const tablePanel = document.getElementById('tr-table-panel');
        const tableWrap = document.getElementById('trends-table-wrap');
        if (tablePanel) tablePanel.hidden = !isTable;
        if (tableWrap) tableWrap.hidden = !isTable;
    }

    // For each species, sum counts (and deduped angler totals, and unique
    // trip counts) into the current window and the immediately preceding
    // window of the same length. Reuses eachAllocation()/_tr.attribution —
    // the same per-day trip-allocation math seriesBySpecies() uses — rather
    // than reimplementing it.
    function computeSpeciesWindowStats(windowDays) {
        const dates = _tr.dates;
        const stats = {};
        if (!dates.length) return stats;

        const end = dates[dates.length - 1];
        const endTs = Date.parse(end + 'T12:00:00Z');
        const curStart = endTs - (windowDays - 1) * 86400000;
        const priorEnd = curStart - 86400000;
        const priorStart = priorEnd - (windowDays - 1) * 86400000;

        const currentSet = new Set();
        const priorSet = new Set();
        dates.forEach(d => {
            const t = Date.parse(d + 'T12:00:00Z');
            if (t >= curStart && t <= endTs) currentSet.add(d);
            else if (t >= priorStart && t <= priorEnd) priorSet.add(d);
        });

        // Dedup key so a trip spanning multiple species rows doesn't get its
        // anglers counted once per species per window (mirrors the
        // anglerSeen pattern in seriesBySpecies()).
        const anglerSeen = {};

        function bucket(species) {
            return stats[species] || (stats[species] = {
                curTotal: 0, curAnglers: 0, curTrips: new Set(),
                priorTotal: 0, priorAnglers: 0, priorTrips: new Set()
            });
        }

        _tr.reports.forEach(r => {
            if (!r.date || !r.species) return;
            const anglers = parseInt(r.anglers) || 0;
            const tripKey = `${r.boat}|${r.trip}|${r.date}`;

            eachAllocation(r, (d, w) => {
                const which = currentSet.has(d) ? 'cur' : priorSet.has(d) ? 'prior' : null;
                if (!which) return;

                const b = bucket(r.species);
                const amt = (r.count || 0) * w;
                if (which === 'cur') b.curTotal += amt; else b.priorTotal += amt;

                const dedupKey = `${which}|${r.species}|${tripKey}`;
                if (!anglerSeen[dedupKey]) {
                    anglerSeen[dedupKey] = true;
                    if (which === 'cur') b.curAnglers += anglers * w; else b.priorAnglers += anglers * w;
                }
                (which === 'cur' ? b.curTrips : b.priorTrips).add(tripKey);
            });
        });

        return stats;
    }

    // Build one row per species with both windows' values (raw + the
    // selected metric), the delta, and a guarded Delta % — null unless
    // *both* windows independently clear DELTA_MIN_TRIPS_PER_WINDOW (too
    // noisy to trust otherwise), or the species is flagged isNew (enough
    // current-window trips, zero prior-window catches).
    function speciesDeltaRows() {
        const stats = computeSpeciesWindowStats(_tr.deltaWindow);
        const usePerAngler = _tr.deltaMetric === 'perAngler';

        return Object.keys(stats).map(species => {
            const s = stats[species];
            const curVal = usePerAngler ? (s.curAnglers > 0 ? s.curTotal / s.curAnglers : 0) : s.curTotal;
            const priorVal = usePerAngler ? (s.priorAnglers > 0 ? s.priorTotal / s.priorAnglers : 0) : s.priorTotal;

            const curOK = s.curTrips.size >= DELTA_MIN_TRIPS_PER_WINDOW;
            const priorOK = s.priorTrips.size >= DELTA_MIN_TRIPS_PER_WINDOW;
            const isNew = curOK && s.priorTotal === 0;
            const pct = (curOK && priorOK && !isNew && priorVal > 0) ? (curVal / priorVal - 1) * 100 : null;

            return {
                species,
                curVal, priorVal,
                delta: curVal - priorVal,
                pct, isNew,
                curTrips: s.curTrips.size,
                priorTrips: s.priorTrips.size
            };
        });
    }

    // Default row order (before any header click): |Delta %| descending, so
    // big drop-offs surface alongside big gains instead of getting buried
    // under every positive move. "New" species count as the largest
    // possible move; rows without a computable Delta % sink to the bottom
    // without any special-case ranking.
    function magnitudeSortKey(row) {
        if (row.isNew) return Number.MAX_SAFE_INTEGER;
        return row.pct == null ? -1 : Math.abs(row.pct);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function fmtCount(v) { return Number.isFinite(v) ? Math.round(v).toLocaleString() : '—'; }
    function fmtRate(v)  { return Number.isFinite(v) ? v.toFixed(2) : '—'; }
    function fmtSignedCount(v) { const r = Math.round(v); return (r >= 0 ? '+' : '') + r.toLocaleString(); }
    function fmtSignedRate(v)  { return (v >= 0 ? '+' : '') + v.toFixed(2); }
    function fmtPct(v)         { return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
    function deltaClass(v)     { return v > 0 ? 'trends-up' : v < 0 ? 'trends-down' : ''; }

    // Missing-data sentinel (mirrors equity-horizon's Positions table
    // convention): sorts last descending / first ascending instead of
    // producing NaN when parsed as a float.
    const MISSING_SORT = '-1e18';

    function renderDeltaTable() {
        const table = document.getElementById('species-delta-table');
        if (!table) return;

        const rows = speciesDeltaRows();
        rows.sort((a, b) => magnitudeSortKey(b) - magnitudeSortKey(a));

        const usePerAngler = _tr.deltaMetric === 'perAngler';
        const valFmt = usePerAngler ? fmtRate : fmtCount;
        const signedFmt = usePerAngler ? fmtSignedRate : fmtSignedCount;

        const thead = '<thead><tr>' +
            '<th class="sortable txt" data-type="text">Species</th>' +
            `<th class="sortable">Last ${_tr.deltaWindow}d</th>` +
            `<th class="sortable">Prior ${_tr.deltaWindow}d</th>` +
            '<th class="sortable">Δ</th>' +
            '<th class="sortable">Δ%</th>' +
            '<th>Trips</th>' +
            '</tr></thead>';

        const bodyRows = rows.map(r => {
            const pctCell = r.isNew
                ? `<td class="trends-up trends-delta-new" data-sort="1e18">New</td>`
                : (r.pct == null
                    ? `<td class="trends-delta-muted" data-sort="${MISSING_SORT}">—</td>`
                    : `<td class="${deltaClass(r.pct)}" data-sort="${r.pct}">${fmtPct(r.pct)}</td>`);

            return '<tr>' +
                `<td class="txt" data-sort="${escapeHtml(r.species)}">${escapeHtml(r.species)}</td>` +
                `<td data-sort="${r.curVal}">${valFmt(r.curVal)}</td>` +
                `<td data-sort="${r.priorVal}">${valFmt(r.priorVal)}</td>` +
                `<td class="${deltaClass(r.delta)}" data-sort="${r.delta}">${signedFmt(r.delta)}</td>` +
                pctCell +
                `<td class="trends-delta-trips">${r.curTrips} / ${r.priorTrips}</td>` +
                '</tr>';
        }).join('');

        table.innerHTML = thead + '<tbody>' +
            (bodyRows || '<tr><td colspan="6" class="trends-delta-empty">No data for this window.</td></tr>') +
            '</tbody>';

        attachDeltaSort(table);
    }

    // Click-to-sort for the Species Deltas table, ported from
    // equity-horizon's Positions table SORT_JS: read the raw value from
    // each cell's data-sort attribute (never reparse the formatted text),
    // toggle direction on repeat clicks of the same header, and re-append
    // <tr> rows in the new order. Reattached on every render since the
    // table body is rebuilt from scratch each time.
    function attachDeltaSort(table) {
        const headRow = table.tHead.rows[0];
        const tbody = table.tBodies[0];
        Array.prototype.forEach.call(headRow.cells, (th, colIndex) => {
            if (!th.classList.contains('sortable')) return;
            th.addEventListener('click', () => {
                const dir = th.classList.contains('sort-desc') ? 'asc' : 'desc';
                Array.prototype.forEach.call(headRow.cells, h => h.classList.remove('sort-asc', 'sort-desc'));
                th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
                const isText = th.getAttribute('data-type') === 'text';
                const rowEls = Array.prototype.slice.call(tbody.rows);
                rowEls.sort((a, b) => {
                    const av = a.cells[colIndex].getAttribute('data-sort') || '';
                    const bv = b.cells[colIndex].getAttribute('data-sort') || '';
                    const cmp = isText ? av.localeCompare(bv) : (parseFloat(av) - parseFloat(bv));
                    return dir === 'asc' ? cmp : -cmp;
                });
                rowEls.forEach(row => tbody.appendChild(row));
            });
        });
    }
})();
