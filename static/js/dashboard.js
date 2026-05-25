// SoCal Fishing Dashboard — Daily Reports view.

let allReports = [];

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', initializeDashboard);

async function initializeDashboard() {
    try {
        const data = await fetchFishingData();
        allReports = data.reports || [];

        const dateRange = getDateRange(allReports);
        document.getElementById('lastUpdated').textContent =
            `Data from ${dateRange} | Last updated: ${data.last_updated || 'Unknown'}`;

        initReportsTable(allReports);
        _rtCheckDelayedData(data.last_updated);
        if (typeof initTrendsSection === 'function') {
            initTrendsSection(allReports);
        }
        if (typeof initMoonCalendar === 'function') {
            initMoonCalendar(allReports);
        }
        initTabs();
    } catch (err) {
        console.error('Dashboard error:', err);
        showErrorMessage('Failed to load dashboard data. Please try again later.');
    }
}

// ---------------------------------------------------------------------------
// Tab navigation — hash-routed (#daily | #trends | #moon).
// ---------------------------------------------------------------------------

const TABS = ['daily', 'trends', 'moon'];

function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => _switchTab(btn.dataset.tab, true));
    });
    window.addEventListener('hashchange', () => {
        _switchTab(_tabFromHash(), false);
    });
    _switchTab(_tabFromHash(), false);
}

function _tabFromHash() {
    const h = (window.location.hash || '').replace(/^#/, '');
    return TABS.includes(h) ? h : 'daily';
}

function _switchTab(tab, updateHash) {
    if (!TABS.includes(tab)) tab = 'daily';
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.hidden = panel.dataset.tab !== tab;
    });
    if (updateHash) {
        history.replaceState(null, '', '#' + tab);
    }
    // Let views know they became visible (e.g. Chart.js may need a resize).
    if (tab === 'trends' && window._trOnShow) window._trOnShow();
}

// Exposed so Trends chart / Moon Calendar can jump the Daily view to a date.
window._rtJumpToDate = function (date) {
    if (!date) return;
    if (_rt.minDate && date < _rt.minDate) return;
    if (_rt.maxDate && date > _rt.maxDate) return;
    _switchTab('daily', true);
    _rtChangeDate(date);
};

async function fetchFishingData() {
    const response = await fetch('data/fishing_reports.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

// ---------------------------------------------------------------------------
// Species metadata — daily bag limits (per angler per day) and categories.
// ---------------------------------------------------------------------------

const SPECIES_DAILY_LIMIT = {
    'Yellowtail': 10,
    'Bluefin Tuna': 2,
    'Yellowfin Tuna': 10,
    'Albacore': 25,
    'Skipjack Tuna': 25,
    'Dorado': 5,
    'Wahoo': 10,
    'White Seabass': 3,
    'White Sea Bass': 3,
    'Halibut': 5,
    'Calico Bass': 5,
    'Sand Bass': 10,
    'Spotted Bay Bass': 3,
    'Rockfish': 10,
    'Vermilion Rockfish': 10,
    'Bocaccio': 10,
    'Canary Rockfish': 10,
    'Chilipepper': 10,
    'Cowcod': 0,
    'Lingcod': 2,
    'Sheephead': 5,
    'Sculpin': 10,
    'Bonito': 20,
    'Barracuda': 10,
    'Striped Marlin': 1,
    'Swordfish': 1,
};

const SPECIES_CATEGORY = {
    tuna:       ['Bluefin Tuna', 'Yellowfin Tuna', 'Albacore', 'Skipjack Tuna', 'Skipjack'],
    rockfish:   ['Rockfish', 'Vermilion Rockfish', 'Bocaccio', 'Canary Rockfish',
                 'Chilipepper', 'Cowcod', 'Sculpin'],
    bass:       ['Calico Bass', 'Sand Bass', 'Spotted Bay Bass', 'White Seabass', 'White Sea Bass'],
    yellowtail: ['Yellowtail', 'Amberjack'],
    flatfish:   ['Halibut', 'Sanddab', 'Sand Dab', 'Sole', 'Flounder', 'Turbot'],
    pelagic:    ['Dorado', 'Wahoo', 'Striped Marlin', 'Marlin', 'Swordfish', 'Barracuda', 'Bonito'],
};

function _rtSpeciesCategory(sp) {
    const lower = sp.toLowerCase();
    for (const [cat, list] of Object.entries(SPECIES_CATEGORY)) {
        if (list.some(name => lower.includes(name.toLowerCase()) ||
                              name.toLowerCase().includes(lower))) {
            return cat;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Reports Table — date-navigable, landing-grouped, species-filterable.
// ---------------------------------------------------------------------------

let _rt = {
    allReports: [],
    currentDate: '',
    minDate: '',
    maxDate: '',
    speciesFilter: null // UI.makeMultiSelect handle
};

function initReportsTable(reports) {
    _rt.allReports = reports;

    const dates = [...new Set(reports.map(r => r.date))].filter(Boolean).sort();
    if (!dates.length) {
        document.getElementById('reportsSection').innerHTML =
            '<p class="has-text-grey">No report data available.</p>';
        return;
    }
    _rt.minDate = dates[0];
    _rt.maxDate = dates[dates.length - 1];
    _rt.currentDate = _rt.maxDate;

    document.getElementById('reportsSection').innerHTML = `
        <div class="app-section">
            <div class="section-toolbar">
                <div>
                    <div id="rt-title"    class="toolbar-title"></div>
                    <div id="rt-sub"      class="toolbar-sub"></div>
                    <a   id="rt-src" href="#" target="_blank" rel="noopener"
                         class="toolbar-link">sandiegofishreports.com &rarr;</a>
                </div>

                <div class="toolbar-controls">
                    <div class="date-group">
                        <button id="rt-prev" aria-label="Previous day">&#8249;</button>
                        <input type="date" id="rt-date"
                               min="${_rt.minDate}" max="${_rt.maxDate}">
                        <button id="rt-next" aria-label="Next day">&#8250;</button>
                    </div>
                    <button id="rt-latest" class="btn">Latest</button>
                    <div id="rt-species-filter"></div>
                </div>
            </div>

            <div id="rt-legend" class="rt-legend"></div>
            <div id="rt-card"   class="rt-card"></div>
        </div>
    `;

    // Navigation
    document.getElementById('rt-prev').addEventListener('click', () => _rtShiftDay(-1));
    document.getElementById('rt-next').addEventListener('click', () => _rtShiftDay(1));
    document.getElementById('rt-latest').addEventListener('click', () => _rtChangeDate(_rt.maxDate));
    document.getElementById('rt-date').addEventListener('change', e => _rtChangeDate(e.target.value));

    // Species filter (shared UI helper)
    _rt.speciesFilter = UI.makeMultiSelect({
        container: document.getElementById('rt-species-filter'),
        label: 'Filter species',
        items: [],
        onChange: () => _rtApplyFilter()
    });

    _rtChangeDate(_rt.currentDate);
}

function _rtCheckDelayedData(lastUpdated) {
    if (!lastUpdated || !_rt.maxDate) return;
    const scrapeDateStr = lastUpdated.slice(0, 10);
    if (scrapeDateStr <= _rt.maxDate) return;

    const dismissKey = `delayed-banner-${scrapeDateStr}`;
    if (sessionStorage.getItem(dismissKey)) return;

    const maxDt = new Date(_rt.maxDate + 'T12:00:00Z');
    const fmtMax = maxDt.toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric' });

    const banner = document.createElement('div');
    banner.className = 'rt-delayed-banner';
    banner.innerHTML =
        `<span><strong>Today’s reports aren’t posted yet</strong> — ` +
        `sandiegofishreports.com hasn’t published data for ${scrapeDateStr}. ` +
        `Showing the most recent available data (${fmtMax}).</span>` +
        `<button class="rt-delayed-banner__close" aria-label="Dismiss">×</button>`;
    banner.querySelector('button').addEventListener('click', () => {
        banner.remove();
        sessionStorage.setItem(dismissKey, '1');
    });

    const section = document.querySelector('#reportsSection .app-section');
    if (section) section.prepend(banner);
}

function _rtGetTripsForDate(date) {
    const byKey = {};
    const keyOrder = [];

    _rt.allReports
        .filter(r => r.date === date)
        .forEach(r => {
            const key = `${r.landing || 'Unknown'}|||${r.boat || 'Unknown'}|||${r.trip || ''}`;
            if (!byKey[key]) {
                keyOrder.push(key);
                byKey[key] = {
                    landing:   r.landing   || 'Unknown',
                    boat:      r.boat      || 'Unknown',
                    trip:      r.trip      || '',
                    anglers:   parseInt(r.anglers) || 0,
                    catch:     {},
                    sourceUrl: r.source_url ||
                               `https://www.sandiegofishreports.com/dock_totals/boats.php?date=${date}`
                };
            }
            if (r.species && r.count) {
                byKey[key].catch[r.species] = (byKey[key].catch[r.species] || 0) + r.count;
            }
        });

    return keyOrder.map(key => {
        const row = byKey[key];
        return {
            ...row,
            catch: Object.entries(row.catch)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([sp, cnt]) => ({ sp, cnt }))
        };
    });
}

function _rtShiftDay(n) {
    const dt = new Date(_rt.currentDate + 'T12:00:00Z');
    const nextDt = new Date(dt.getTime() + n * 86400000);
    const next = nextDt.toISOString().slice(0, 10);
    if (next >= _rt.minDate && next <= _rt.maxDate) _rtChangeDate(next);
}

function _rtChangeDate(date) {
    _rt.currentDate = date;

    const dateInput = document.getElementById('rt-date');
    const prevBtn   = document.getElementById('rt-prev');
    const nextBtn   = document.getElementById('rt-next');
    const latestBtn = document.getElementById('rt-latest');

    dateInput.value  = date;
    prevBtn.disabled = date <= _rt.minDate;
    nextBtn.disabled = date >= _rt.maxDate;

    const isLatest = date === _rt.maxDate;
    latestBtn.classList.toggle('btn--active', isLatest);

    // Header
    const trips = _rtGetTripsForDate(date);
    const totalFish  = trips.reduce((s, r) => s + r.catch.reduce((a, c) => a + c.cnt, 0), 0);
    const totalTrips = trips.length;
    const dt = new Date(date + 'T12:00:00Z');
    const fmtDate = dt.toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const moon = (typeof moonPhase === 'function') ? moonPhase(date) : null;
    const moonHtml = moon
        ? ` \u00B7 <span class="rt-moon" title="${moon.illumination}% illuminated">${moon.emoji} ${moon.name} (${moon.illumination}%)</span>`
        : '';

    document.getElementById('rt-title').textContent =
        isLatest ? 'Counts for today' : `Counts for ${fmtDate}`;

    const subEl = document.getElementById('rt-sub');
    if (trips.length) {
        subEl.innerHTML = `${fmtDate} \u2014 ${totalTrips} trip${totalTrips !== 1 ? 's' : ''} \u00B7 ${totalFish.toLocaleString()} fish${moonHtml}`;
    } else {
        subEl.innerHTML = `${fmtDate} \u2014 no data scraped for this date${moonHtml}`;
    }
    document.getElementById('rt-src').href =
        `https://www.sandiegofishreports.com/dock_totals/boats.php?date=${date}`;

    // Refresh species filter items for the new date
    const speciesList = [...new Set(trips.flatMap(r => r.catch.map(c => c.sp)))].sort();
    const speciesItems = speciesList.map(sp => {
        const total = trips.reduce(
            (s, r) => s + (r.catch.find(c => c.sp === sp)?.cnt || 0), 0);
        return { value: sp, label: sp, meta: total.toLocaleString() };
    });
    _rt.speciesFilter.clear();
    _rt.speciesFilter.setItems(speciesItems);

    _rtBuildTable(trips);
    _rtUpdateLegend(trips);
    _rtApplyFilter();
}

const _RT_CATEGORY_LABELS = {
    tuna: 'Tuna', rockfish: 'Rockfish', bass: 'Bass',
    yellowtail: 'Yellowtail', flatfish: 'Flatfish', pelagic: 'Pelagic',
};

function _rtUpdateLegend(trips) {
    const el = document.getElementById('rt-legend');
    if (!el) return;
    const present = new Set(
        trips.flatMap(r => r.catch.map(c => _rtSpeciesCategory(c.sp))).filter(Boolean)
    );
    if (!present.size) { el.innerHTML = ''; return; }
    el.innerHTML = Object.keys(_RT_CATEGORY_LABELS)
        .filter(cat => present.has(cat))
        .map(cat =>
            `<span class="rt-legend-item rt-legend--${cat}">` +
            `<span class="rt-legend-swatch"></span>${_RT_CATEGORY_LABELS[cat]}</span>`
        ).join('');
}

function _rtBuildTable(trips) {
    const card = document.getElementById('rt-card');

    if (!trips.length) {
        card.innerHTML = `
            <div class="rt-empty">
                No catch data available for this date.<br>
                The scraper may not have run yet, or there were no reported trips.
            </div>`;
        return;
    }

    const landingOrder = [];
    const byLanding = {};
    trips.forEach(r => {
        if (!byLanding[r.landing]) {
            landingOrder.push(r.landing);
            byLanding[r.landing] = [];
        }
        byLanding[r.landing].push(r);
    });

    card.innerHTML = landingOrder.map(landing => {
        const lrows = byLanding[landing];
        const uniqueBoatCount = new Set(lrows.map(r => r.boat)).size;

        const tableRows = lrows.map(r => {
            const isMultiTrip = lrows.filter(x => x.boat === r.boat).length > 1;
            const td = (typeof TripDuration !== 'undefined')
                ? TripDuration.parse(r.trip)
                : { tripDays: 1, windowDays: 1, isMultiDay: false, matched: true };
            // Limit-days = the number of calendar days the CA daily bag limit
            // applies across for this trip. A 1.5-day trip covers 2 limit-days,
            // a 2-day trip covers 2, a 3-day trip covers 3, etc.
            const limitDays = Math.max(1, Math.ceil(td.tripDays));

            const pills = r.catch.map(c => {
                const avgVal = r.anglers > 0 ? c.cnt / r.anglers : null;
                const avgStr = avgVal != null
                    ? avgVal.toFixed(1) + ' per angler (full trip)'
                    : '';
                const avgTitle = avgVal != null
                    ? `${avgVal.toFixed(2)} ${c.sp} per angler \u2014 average across the entire `
                      + `${TripDuration.formatDays(td.tripDays)}-day trip`
                    : '';
                const perDayVal = td.isMultiDay && r.anglers > 0
                    ? c.cnt / (r.anglers * limitDays)
                    : null;
                const perDayStr = perDayVal != null
                    ? perDayVal.toFixed(2) + ' per angler per limit-day'
                    : '';
                const perDayTitle = perDayVal != null
                    ? `${perDayVal.toFixed(2)} ${c.sp} per angler per limit-day `
                      + `(${TripDuration.formatDays(td.tripDays)}-day trip counts as `
                      + `${limitDays} limit-day${limitDays === 1 ? '' : 's'} under CA regs)`
                    : '';
                const parts = [];
                if (avgStr)    parts.push(`<span class="rt-pill-avg" title="${avgTitle}">${avgStr}</span>`);
                if (perDayStr) parts.push(`<span class="rt-pill-avg rt-pill-perday" title="${perDayTitle}">${perDayStr}</span>`);
                if (!parts.length && r.anglers <= 0) parts.push('<span class="rt-pill-avg">\u2014</span>');

                const limit = SPECIES_DAILY_LIMIT[c.sp];
                let limitBar = '';
                if (limit != null && r.anglers > 0 && limit > 0) {
                    const pct = Math.min(1, c.cnt / (r.anglers * limitDays * limit));
                    const pctRound = Math.round(pct * 100);
                    const barClass = pct >= 1    ? 'rt-limit-bar--full'
                                   : pct >= 0.8 ? 'rt-limit-bar--high'
                                   : pct >= 0.5 ? 'rt-limit-bar--mid'
                                   :              'rt-limit-bar--low';
                    const trophy = pct >= 1 ? '\u{1F3C6}' : '';
                    const regText = `California daily bag limit: ${limit} ${c.sp} per angler`;
                    limitBar = `<span class="rt-limit-wrap" title="${pctRound}% of limit \u2014 ${regText}">` +
                               `<span class="rt-limit-bar ${barClass}" style="width:${Math.round(pct * 40)}px"></span>` +
                               `<span class="rt-limit-pct">${pctRound}%</span>` +
                               `${trophy}</span>`;
                } else if (limit === 0 && c.cnt > 0) {
                    limitBar = `<span class="rt-limit-wrap" title="Protected species \u2014 retention prohibited (California)">\u26A0\uFE0F</span>`;
                }

                const cat = _rtSpeciesCategory(c.sp);
                const catClass = cat ? ` rt-pill--${cat}` : '';
                return `
                    <span class="rt-pill${catClass}" data-sp="${c.sp}">
                        <span class="rt-pill-count">${c.cnt}</span>
                        <span class="rt-pill-species">${c.sp}</span>
                        ${parts.join('')}${limitBar}
                    </span>`;
            }).join('');

            return `
                <tr class="rt-trip-row${isMultiTrip ? ' rt-multi-trip' : ''}">
                    <td class="rt-col-boat">
                        <div class="rt-boat-name">${r.boat}</div>
                    </td>
                    <td class="rt-col-trip">
                        <div class="rt-trip-anglers">${r.anglers ? `${r.anglers} Anglers` : '\u2014'}</div>
                        <div class="rt-trip-name">${r.trip}</div>
                    </td>
                    <td class="rt-col-catch">
                        <div class="rt-catch-list">${pills}</div>
                    </td>
                </tr>`;
        }).join('');

        return `
            <div class="rt-landing-block">
                <div class="rt-landing-header">
                    <svg class="rt-landing-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/>
                        <path d="M3 8 Q6 4 9 8" stroke="currentColor" stroke-width="1.2" fill="none"/>
                    </svg>
                    <span class="rt-landing-name">${landing}</span>
                    <span class="rt-landing-count">
                        ${uniqueBoatCount} boat${uniqueBoatCount !== 1 ? 's' : ''}
                    </span>
                </div>
                <div class="rt-table-scroll">
                <table class="rt-table">
                    <colgroup>
                        <col class="rt-col-boat">
                        <col class="rt-col-trip">
                        <col class="rt-col-catch">
                    </colgroup>
                    <thead>
                        <tr>
                            <th>Boat</th>
                            <th>Trip Details</th>
                            <th>Catch <span class="rt-th-hint">count &middot; per angler (full trip) &middot; per angler per limit-day</span></th>
                        </tr>
                    </thead>
                    <tbody>${tableRows}</tbody>
                </table>
                </div>
            </div>`;
    }).join('');
}

// Apply the species filter without rebuilding the table DOM.
function _rtApplyFilter() {
    const active = _rt.speciesFilter ? _rt.speciesFilter.getSelected() : new Set();

    document.querySelectorAll('.rt-pill').forEach(pill => {
        const show = active.size === 0 || active.has(pill.dataset.sp);
        pill.style.display = show ? 'inline-flex' : 'none';
    });

    document.querySelectorAll('.rt-trip-row').forEach(row => {
        const hasVisible = [...row.querySelectorAll('.rt-pill')]
            .some(p => p.style.display !== 'none');
        row.style.display = (active.size > 0 && !hasVisible) ? 'none' : '';
    });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getDateRange(reports) {
    if (!reports || reports.length === 0) return 'No data';
    const dates = reports.map(r => new Date(r.date + 'T12:00:00Z')).filter(d => !isNaN(d));
    if (!dates.length) return 'No valid dates';
    const min = new Date(Math.min(...dates));
    const max = new Date(Math.max(...dates));
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${fmt(min)} to ${fmt(max)}`;
}

function showErrorMessage(message) {
    const container = document.querySelector('.container');
    const div = document.createElement('div');
    div.className = 'notification is-danger';
    div.innerHTML = `<i class="fas fa-exclamation-triangle mr-2"></i>${message}`;
    container.insertBefore(div, container.firstChild);
    setTimeout(() => div.remove(), 10000);
}
