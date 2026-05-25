// Moon Calendar — month grid showing lunar phase per day alongside a
// selected boat's catch (optionally filtered by species).

(function () {

    const _mc = {
        reports: [],
        allBoats: [],
        allSpecies: [],
        month: '',           // 'YYYY-MM'
        boat: '',            // '' = none selected
        speciesMS: null,     // UI.makeMultiSelect handle
        // Index of reports by date → boat → array of rows, for quick lookup.
        byDate: {}
    };

    window.initMoonCalendar = function (reports) {
        _mc.reports = reports || [];
        _mc.allBoats = [...new Set(_mc.reports.map(r => r.boat).filter(Boolean))].sort();
        _mc.allSpecies = [...new Set(_mc.reports.map(r => r.species).filter(Boolean))].sort();

        // Pre-index by (date, boat) for O(1) cell lookups.
        _mc.byDate = {};
        _mc.reports.forEach(r => {
            if (!r.date || !r.boat) return;
            _mc.byDate[r.date] = _mc.byDate[r.date] || {};
            (_mc.byDate[r.date][r.boat] = _mc.byDate[r.date][r.boat] || []).push(r);
        });

        // Default month = month of the latest report (fallback to today).
        const dates = [...new Set(_mc.reports.map(r => r.date))].filter(Boolean).sort();
        const seed = dates.length ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10);
        _mc.month = seed.slice(0, 7);

        const mount = document.getElementById('calendarSection');
        if (!mount) return;

        mount.innerHTML = `
            <div class="app-section">
                <div class="section-toolbar">
                    <div>
                        <div class="toolbar-title">Moon Calendar</div>
                        <div class="toolbar-sub">Per-day moon phase and catch totals for a selected boat.</div>
                    </div>
                </div>

                <div class="cal-body">
                    <div class="cal-control-row">
                        <label>Month</label>
                        <input type="month" id="mc-month" value="${_mc.month}">

                        <label style="margin-left: var(--space-3);">Boat</label>
                        <select id="mc-boat">
                            <option value="">— Select a boat —</option>
                            ${_mc.allBoats.map(b =>
                                `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`
                            ).join('')}
                        </select>

                        <label style="margin-left: var(--space-3);">Species</label>
                        <div id="mc-species-ms"></div>
                    </div>

                    <div id="mc-grid" class="cal-grid"></div>

                    <div class="cal-legend-note">
                        <span><span class="trends-legend-swatch new"></span>new moon (±1 day)</span>
                        <span><span class="trends-legend-swatch full"></span>full moon (±1 day)</span>
                        <span style="margin-left:auto;font-style:italic;">Tip: click a populated cell to see catch details.</span>
                    </div>
                </div>
            </div>
        `;

        // Wire controls.
        document.getElementById('mc-month').addEventListener('change', e => {
            _mc.month = e.target.value || _mc.month;
            renderGrid();
        });
        document.getElementById('mc-boat').addEventListener('change', e => {
            _mc.boat = e.target.value || '';
            renderGrid();
        });
        _mc.speciesMS = UI.makeMultiSelect({
            container: document.getElementById('mc-species-ms'),
            label: 'Filter species',
            items: _mc.allSpecies.map(s => ({ value: s, label: s })),
            selected: new Set(),
            onChange: () => renderGrid()
        });

        renderGrid();
    };

    // --- Grid rendering ----------------------------------------------------

    function renderGrid() {
        const grid = document.getElementById('mc-grid');
        if (!grid) return;

        const [yStr, mStr] = _mc.month.split('-');
        const year = parseInt(yStr, 10);
        const month = parseInt(mStr, 10);  // 1-12
        if (!year || !month) {
            grid.innerHTML = '<div class="cal-empty">Pick a month to view.</div>';
            return;
        }

        // Build list of days to render: Sun before/on the 1st → Sat on/after the last.
        const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
        const lastOfMonth  = new Date(Date.UTC(year, month,     0));
        const gridStart = new Date(firstOfMonth);
        gridStart.setUTCDate(firstOfMonth.getUTCDate() - firstOfMonth.getUTCDay());
        const gridEnd = new Date(lastOfMonth);
        gridEnd.setUTCDate(lastOfMonth.getUTCDate() + (6 - lastOfMonth.getUTCDay()));

        const speciesFilter = _mc.speciesMS ? _mc.speciesMS.getSelected() : new Set();
        const speciesMode = speciesFilter.size > 0;

        const cells = [];
        // Day-of-week header row.
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => {
            cells.push(`<div class="cal-dow">${d}</div>`);
        });

        for (let cur = new Date(gridStart); cur <= gridEnd; cur.setUTCDate(cur.getUTCDate() + 1)) {
            const iso = cur.toISOString().slice(0, 10);
            const inMonth = (cur.getUTCMonth() + 1) === month;
            const classes = ['cal-cell'];
            if (!inMonth) classes.push('is-outside');

            // Moon phase.
            const phase = (typeof moonPhase === 'function') ? moonPhase(iso) : null;
            const near  = (typeof daysToNearestNewOrFull === 'function') ? daysToNearestNewOrFull(iso) : null;
            if (near && near.days <= 1) {
                classes.push(near.kind === 'new' ? 'moon-new' : 'moon-full');
            }

            // Catch for (boat, date) filtered by species.
            let totalCount = 0;
            const speciesTotals = {};
            const rows = (_mc.boat && _mc.byDate[iso] && _mc.byDate[iso][_mc.boat]) || [];
            rows.forEach(r => {
                if (speciesMode && !speciesFilter.has(r.species)) return;
                const c = r.count || 0;
                totalCount += c;
                speciesTotals[r.species] = (speciesTotals[r.species] || 0) + c;
            });
            const hasData = totalCount > 0;
            if (hasData) classes.push('has-data');

            const moonHtml = phase
                ? `<span class="cal-moon" title="${escapeHtml(phase.name)} (${phase.illumination}%)">${phase.emoji}</span>`
                : '';
            const moonNameHtml = phase && inMonth
                ? `<div class="cal-moon-name">${escapeHtml(phase.name)}</div>`
                : '';

            let bodyHtml = '';
            if (hasData) {
                const topSpecies = Object.entries(speciesTotals)
                    .sort((a, b) => b[1] - a[1]);
                const lines = topSpecies.slice(0, 3).map(([sp, c]) =>
                    `<div class="cal-species-line">${escapeHtml(sp)} × ${c}</div>`
                ).join('');
                const extra = topSpecies.length > 3
                    ? `<div class="cal-more">+ ${topSpecies.length - 3} more</div>`
                    : '';
                bodyHtml = `
                    <div class="cal-total">${totalCount.toLocaleString()} fish</div>
                    ${lines}${extra}
                `;
            }

            cells.push(`
                <div class="${classes.join(' ')}" data-date="${iso}">
                    <div class="cal-cell-top">
                        <span class="cal-day">${cur.getUTCDate()}</span>
                        ${moonHtml}
                    </div>
                    ${moonNameHtml}
                    ${bodyHtml}
                </div>
            `);
        }

        grid.innerHTML = cells.join('');

        // Wire click on populated cells — opens day modal.
        grid.querySelectorAll('.cal-cell.has-data').forEach(el => {
            el.addEventListener('click', () => {
                const d = el.dataset.date;
                if (d) showDayModal(d, _mc.boat);
            });
        });
    }

    // --- Day detail modal -----------------------------------------------------

    function showDayModal(iso, boat) {
        const speciesFilter = _mc.speciesMS ? _mc.speciesMS.getSelected() : new Set();
        const speciesMode = speciesFilter.size > 0;

        const rows = (_mc.byDate[iso] && _mc.byDate[iso][boat]) || [];
        let totalCount = 0;
        const speciesTotals = {};
        rows.forEach(r => {
            if (speciesMode && !speciesFilter.has(r.species)) return;
            const c = r.count || 0;
            totalCount += c;
            speciesTotals[r.species] = (speciesTotals[r.species] || 0) + c;
        });

        const phase = (typeof moonPhase === 'function') ? moonPhase(iso) : null;

        const [y, m, d] = iso.split('-');
        const dateObj = new Date(Date.UTC(+y, +m - 1, +d));
        const dateLabel = dateObj.toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
        });
        const shortDate = dateObj.toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
        });

        const moonHtml = phase
            ? `<div class="cal-modal-moon">${phase.emoji} ${escapeHtml(phase.name)} &mdash; ${phase.illumination}% illuminated</div>`
            : '';

        const speciesRows = Object.entries(speciesTotals)
            .sort((a, b) => b[1] - a[1])
            .map(([sp, c]) =>
                `<div class="cal-modal-species-row">
                    <span class="cal-modal-species-name">${escapeHtml(sp)}</span>
                    <span class="cal-modal-species-count">${c.toLocaleString()}</span>
                </div>`
            ).join('');

        const overlay = document.createElement('div');
        overlay.className = 'cal-modal-overlay';
        overlay.innerHTML = `
            <div class="cal-modal" role="dialog" aria-modal="true">
                <div class="cal-modal-header">
                    <div>
                        <div class="cal-modal-title">${escapeHtml(boat)}</div>
                        <div class="cal-modal-date">${escapeHtml(dateLabel)}</div>
                    </div>
                    <button class="cal-modal-close" aria-label="Close">&times;</button>
                </div>
                ${moonHtml}
                <div class="cal-modal-total">${totalCount.toLocaleString()} fish total</div>
                <div class="cal-modal-species-list">
                    ${speciesRows || '<div class="cal-modal-empty">No catch data for selected species.</div>'}
                </div>
                <div class="cal-modal-footer">
                    <button class="cal-modal-link-btn">View Daily Report for ${escapeHtml(shortDate)} &rarr;</button>
                </div>
            </div>
        `;

        const onKeyDown = e => { if (e.key === 'Escape') close(); };
        const close = () => {
            overlay.remove();
            document.removeEventListener('keydown', onKeyDown);
        };

        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        overlay.querySelector('.cal-modal-close').addEventListener('click', close);
        document.addEventListener('keydown', onKeyDown);

        overlay.querySelector('.cal-modal-link-btn').addEventListener('click', () => {
            close();
            if (typeof window._rtJumpToDate === 'function') {
                window._rtJumpToDate(iso);
            }
        });

        document.body.appendChild(overlay);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }
})();
