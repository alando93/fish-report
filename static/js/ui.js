// Shared UI primitives.

(function (global) {

    // Multi-select dropdown used by both the Daily Reports species filter
    // and the Trends species/boat filters.
    //
    // opts:
    //   container: HTMLElement to mount into (should be empty)
    //   label:     button label text
    //   items:     Array<{ value: string, label: string, meta?: string }>
    //   selected:  Set<string> initial selection
    //   onChange:  (selected: Set<string>) => void
    //
    // Returns: { setItems(items), getSelected(), setSelected(values), clear(), setLabel(text) }
    function makeMultiSelect(opts) {
        const { container, label, onChange } = opts;
        const state = {
            items: opts.items || [],
            selected: opts.selected || new Set()
        };

        container.classList.add('ms-root');
        container.innerHTML = `
            <button class="ms-btn" type="button">
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                    <path d="M1 3h11M3 6.5h7M5 10h3"
                          stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                </svg>
                <span class="ms-label">${label}</span>
                <span class="ms-badge" hidden></span>
            </button>
            <div class="ms-dropdown" hidden>
                <div class="ms-dd-top">
                    <div class="ms-dd-header">
                        <span>${label}</span>
                        <span class="ms-clear">Clear all</span>
                    </div>
                    <div class="ms-search-wrap">
                        <input class="ms-search" type="search" placeholder="Search ${label.toLowerCase()}…"
                               autocomplete="off" spellcheck="false" aria-label="Search ${label}">
                    </div>
                </div>
                <div class="ms-dd-list"></div>
            </div>
        `;

        const btn      = container.querySelector('.ms-btn');
        const dropdown = container.querySelector('.ms-dropdown');
        const list     = container.querySelector('.ms-dd-list');
        const badge    = container.querySelector('.ms-badge');
        const clearEl  = container.querySelector('.ms-clear');
        const search   = container.querySelector('.ms-search');
        let query = '';

        // Items matching the search box (case-insensitive substring on the
        // label, ignoring any markup in it). Empty query = all items.
        function visibleItems() {
            const q = query.trim().toLowerCase();
            if (!q) return state.items;
            return state.items.filter(it =>
                String(it.label).replace(/<[^>]*>/g, '').toLowerCase().includes(q));
        }

        function positionDropdown() {
            if (window.innerWidth > 640) {
                dropdown.style.cssText = '';
                return;
            }
            const rect = btn.getBoundingClientRect();
            const dropW = Math.min(260, window.innerWidth - 16);
            let left = rect.right - dropW;
            if (left < 8) left = 8;
            dropdown.style.position = 'fixed';
            dropdown.style.top = (rect.bottom + 4) + 'px';
            dropdown.style.left = left + 'px';
            dropdown.style.right = 'auto';
            dropdown.style.maxWidth = dropW + 'px';
        }

        function resetSearch() {
            if (!query) return;
            query = '';
            search.value = '';
            render();
        }

        function closeDropdown() {
            dropdown.hidden = true;
            dropdown.style.cssText = '';
            resetSearch();
        }

        btn.addEventListener('click', e => {
            e.stopPropagation();
            // Close any other open dropdowns on the page
            document.querySelectorAll('.ms-dropdown').forEach(d => {
                if (d !== dropdown) { d.hidden = true; d.style.cssText = ''; }
            });
            if (dropdown.hidden) {
                dropdown.hidden = false;
                positionDropdown();
                // Skip autofocus on narrow screens so the keyboard doesn't
                // pop up over the list; tap the box to search there.
                if (window.innerWidth > 640) search.focus();
            } else {
                closeDropdown();
            }
        });
        document.addEventListener('click', closeDropdown);
        dropdown.addEventListener('click', e => e.stopPropagation());

        search.addEventListener('input', () => {
            query = search.value;
            render();
        });
        search.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                // Enter toggles the top match, handy when one item is left.
                const first = list.querySelector('.ms-item');
                if (first) first.click();
            } else if (e.key === 'Escape') {
                if (query) resetSearch();
                else { closeDropdown(); btn.focus(); }
            }
        });

        clearEl.addEventListener('click', () => {
            state.selected.clear();
            render();
            onChange && onChange(new Set(state.selected));
        });

        function render() {
            const shown = visibleItems();
            list.innerHTML = shown.length ? shown.map(it => {
                const on = state.selected.has(it.value);
                return `
                    <div class="ms-item${on ? ' is-on' : ''}" data-v="${encodeURIComponent(it.value)}">
                        <span class="ms-check"></span>
                        <span class="ms-item-label">${it.label}</span>
                        ${it.meta ? `<span class="ms-item-meta">${it.meta}</span>` : ''}
                    </div>
                `;
            }).join('') : '<div class="ms-empty">No matches</div>';

            list.querySelectorAll('.ms-item').forEach(el => {
                el.addEventListener('click', () => {
                    const v = decodeURIComponent(el.dataset.v);
                    if (state.selected.has(v)) state.selected.delete(v);
                    else state.selected.add(v);
                    render();
                    onChange && onChange(new Set(state.selected));
                });
            });

            // Badge
            if (state.selected.size) {
                badge.textContent = state.selected.size;
                badge.hidden = false;
            } else {
                badge.hidden = true;
            }
        }

        render();

        return {
            setItems(items) {
                state.items = items;
                // Drop any selected values that no longer exist
                const valid = new Set(items.map(i => i.value));
                [...state.selected].forEach(v => { if (!valid.has(v)) state.selected.delete(v); });
                render();
            },
            getSelected() { return new Set(state.selected); },
            setSelected(values) {
                state.selected = new Set(values);
                render();
            },
            clear() {
                state.selected.clear();
                render();
            },
            // Change the button text only (the dropdown header keeps the
            // original label), e.g. "Boats: all" while nothing is picked.
            setLabel(text) {
                container.querySelector('.ms-btn .ms-label').textContent = text;
            }
        };
    }

    // Simple segmented button group.
    //
    // opts:
    //   container: HTMLElement
    //   options:   Array<{ value, label }>
    //   selected:  string (initial)
    //   onChange:  (value) => void
    function makeSegmented(opts) {
        const { container, options, onChange } = opts;
        let selected = opts.selected;

        container.classList.add('seg');
        container.innerHTML = options.map(o => `
            <button type="button" class="seg-btn${o.value === selected ? ' is-on' : ''}"
                    data-v="${encodeURIComponent(o.value)}">${o.label}</button>
        `).join('');

        container.querySelectorAll('.seg-btn').forEach(el => {
            el.addEventListener('click', () => {
                selected = decodeURIComponent(el.dataset.v);
                container.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('is-on'));
                el.classList.add('is-on');
                onChange && onChange(selected);
            });
        });

        return {
            get value() { return selected; },
            set(v) {
                selected = v;
                container.querySelectorAll('.seg-btn').forEach(b => {
                    b.classList.toggle('is-on', decodeURIComponent(b.dataset.v) === v);
                });
            }
        };
    }

    global.UI = { makeMultiSelect, makeSegmented };
})(window);
