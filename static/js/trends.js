// Trends section — Chart.js time series with moon-phase background bands.

(function () {

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
        breakdown: {},      // breakdown[date][groupLabel][subLabel] = { count, trips: [{ tripDays, dayIndex, totalDays }] }
    };

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
                        <label>View</label>
                        <div id="tr-mode"></div>
                        <div id="tr-species-ms"></div>
                        <div id="tr-boats-ms" hidden></div>
                    </div>

                    <div class="trends-control-row">
                        <label>Metric</label>
                        <div id="tr-metric"></div>
                        <label style="margin-left: var(--space-3);">Smoothing</label>
                        <div id="tr-smoothing"></div>
                        <label style="margin-left: var(--space-3);">Range</label>
                        <div id="tr-range"></div>
                    </div>

                    <div class="trends-control-row">
                        <label>Attribution</label>
                        <div id="tr-attribution"></div>
                        <span class="trends-attribution-hint">
                            How multi-day trip catches are distributed across the calendar.
                        </span>
                    </div>

                    <div class="trends-chart-wrap">
                        <canvas id="trends-chart"></canvas>
                    </div>

                    <div class="trends-legend-note">
                        <span><span class="trends-legend-swatch new"></span>new moon (\u00B11 day)</span>
                        <span><span class="trends-legend-swatch full"></span>full moon (\u00B11 day)</span>
                        <span class="trends-click-hint">Tip: click/tap any day to update its Daily Report.</span>
                    </div>
                </div>
            </div>
        `;

        // Segmented controls
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
                { value: 'perAngler',  label: 'Per angler' },
                { value: 'totalTrips', label: 'Total trips' }
            ],
            selected: _tr.metric,
            onChange: v => {
                const wasTrips = _tr.metric === 'totalTrips';
                _tr.metric = v;
                const isTrips = v === 'totalTrips';
                if (wasTrips !== isTrips) {
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
            onChange: v => { _tr.attribution = v; redraw(); }
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

    // --- Aggregation -------------------------------------------------------

    function visibleDates() {
        if (!_tr.dates.length) return [];
        if (!_tr.rangeDays) return _tr.dates;
        const end = _tr.dates[_tr.dates.length - 1];
        const endTs = Date.parse(end + 'T12:00:00Z');
        const startTs = endTs - _tr.rangeDays * 86400000;
        return _tr.dates.filter(d => Date.parse(d + 'T12:00:00Z') >= startTs);
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

    // Build one series per selected species: daily total (or per-angler) for
    // that species across all boats.
    function seriesBySpecies(dates) {
        const selected = _tr.speciesMS.getSelected();
        if (!selected.size) return [];

        const counts = {};       // counts[date][species] = count
        const anglerSum = {};    // anglerSum[date] = total anglers
        // Track which (tripKey, date) pairs we've already counted anglers for,
        // so anglers don't get inflated by multiple species rows on the same trip.
        const anglerSeen = {};

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
                    anglerSum[d] = (anglerSum[d] || 0) + anglers * w;
                }

                // Breakdown: for each species, track catch per boat (with trip info for tooltip)
                const boat = r.boat || 'Unknown';
                _tr.breakdown[d] = _tr.breakdown[d] || {};
                _tr.breakdown[d][r.species] = _tr.breakdown[d][r.species] || {};
                const bucket = _tr.breakdown[d][r.species][boat] =
                    _tr.breakdown[d][r.species][boat] || { count: 0, trips: [] };
                bucket.count += (r.count || 0) * w;
                bucket.trips.push(tripInfo);
            });
        });

        return [...selected].sort().map(sp => ({
            label: sp,
            data: dates.map(d => {
                const raw = (counts[d] && counts[d][sp]) || 0;
                if (_tr.metric === 'perAngler') {
                    const a = anglerSum[d] || 0;
                    return a > 0 ? raw / a : null;
                }
                return raw || null;
            })
        }));
    }

    // Build a single series of unique trip counts per date. Optionally
    // filtered by the Boats multi-select (empty = all boats). Always uses
    // as-reported attribution (a trip "returns" on one specific date).
    function seriesTotalTrips(dates) {
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

        // Populate breakdown with the tooltip-ready trip list per date.
        dates.forEach(d => {
            _tr.breakdown[d] = _tr.breakdown[d] || {};
            _tr.breakdown[d].__trips = meta[d] ? Object.values(meta[d]) : [];
        });

        const label = usingFilter ? 'Total trips (filtered)' : 'Total trips';
        return [{
            label,
            data: dates.map(d => (counts[d] ? counts[d].size : 0))
        }];
    }

    // Build one series per selected boat: daily total across all species.
    function seriesByBoat(dates) {
        const selected = _tr.boatsMS.getSelected();
        if (!selected.size) return [];

        const counts = {};       // counts[date][boat]
        const anglerSum = {};    // anglerSum[date][boat]
        const anglerSeen = {};   // (tripKey) already counted for anglers?

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
                    anglerSum[d] = anglerSum[d] || {};
                    anglerSum[d][r.boat] = (anglerSum[d][r.boat] || 0) + anglers * w;
                }

                // Breakdown: for each boat, track catch per species (with trip info for tooltip)
                const sp = r.species || 'Unknown';
                _tr.breakdown[d] = _tr.breakdown[d] || {};
                _tr.breakdown[d][r.boat] = _tr.breakdown[d][r.boat] || {};
                const bucket = _tr.breakdown[d][r.boat][sp] =
                    _tr.breakdown[d][r.boat][sp] || { count: 0, trips: [] };
                bucket.count += (r.count || 0) * w;
                bucket.trips.push(tripInfo);
            });
        });

        return [...selected].sort().map(boat => ({
            label: boat,
            data: dates.map(d => {
                const raw = (counts[d] && counts[d][boat]) || 0;
                if (_tr.metric === 'perAngler') {
                    const a = (anglerSum[d] && anglerSum[d][boat]) || 0;
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
        const isTrips = _tr.metric === 'totalTrips';
        _tr.chart = new Chart(canvas.getContext('2d'), {
            type: isTrips ? 'bar' : 'line',
            data: { labels: [], datasets: [] },
            options: {
                maintainAspectRatio: false,
                responsive: true,
                events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
                interaction: isTrips
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
                                const pretty = new Date(d + 'T12:00:00Z').toLocaleDateString('en-US',
                                    { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
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
                                        ? v.toFixed(2) + ' / angler'
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
                                            lines.push(`  ${name}: ${Math.round(info.count).toLocaleString()}${suffix}`);
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

        let raw;
        if (_tr.metric === 'totalTrips') {
            raw = seriesTotalTrips(dates);
        } else {
            raw = _tr.mode === 'species' ? seriesBySpecies(dates) : seriesByBoat(dates);
        }

        const datasets = raw.map((s, i) => {
            const color = _tr.palette[i % _tr.palette.length];
            if (_tr.metric === 'totalTrips') {
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
            const data = _tr.smoothing ? rollingAverage(s.data, _tr.smoothing) : s.data;
            return {
                label: s.label,
                data,
                borderColor: color,
                backgroundColor: color,
                borderWidth: 1.6,
                pointRadius: _tr.smoothing ? 0 : 2,
                pointHoverRadius: 4,
                tension: 0.25,
                spanGaps: true
            };
        });

        _tr.chart.data.labels = dates;
        _tr.chart.data.datasets = datasets;
        _tr.chart.options.scales.y.title = {
            display: true,
            text: _tr.metric === 'totalTrips' ? 'Trips'
                : _tr.metric === 'perAngler' ? 'Fish per angler'
                : 'Fish count',
            color: 'rgba(0,0,0,0.55)',
            font: { size: 11 }
        };
        _tr.chart.options.plugins.legend.display = _tr.metric !== 'totalTrips';
        _tr.chart.update('none');
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
        const attrHintEl   = document.querySelector('.trends-attribution-hint');

        // Helper: hide/show a control along with its preceding <label>.
        function setHidden(el, hidden) {
            if (!el) return;
            el.hidden = hidden;
            const prev = el.previousElementSibling;
            if (prev && prev.tagName === 'LABEL') prev.hidden = hidden;
        }

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
            setHidden(smoothingEl, false);
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
})();
