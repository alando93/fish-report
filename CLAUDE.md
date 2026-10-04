# CLAUDE.md

Orientation for Claude Code sessions working in this repo. For human-facing setup, data schema, scraper CLI, and deployment, read [`README.md`](./README.md) — don't duplicate it here.

## What this is

**Fishing Dashboard**: a static site (vanilla HTML/CSS/JS) that renders fish-count data scraped from three sister sites: sandiegofishreports.com, socalfishreports.com and norcalfishreports.com. Each site is a region with its own file, `data/<region>.json` (`sandiego`, `socal`, `norcal`). A Python scraper runs every 4h from a systemd timer on the OptiPlex (`scrape_run.sh`) and commits updated JSON back to `main`. GitHub Actions is a disabled, manual-only fallback. No backend, no build step, no framework, no tests.

## Commands

```bash
# Serve the dashboard (must be from repo root — paths are relative)
python -m http.server 8000           # → http://localhost:8000

# Run scraper (writes data/<region>.json)
pip install -r requirements.txt      # once
python automated_scraping/scripts/fish_reports_scraper.py                     # all regions, last 2 days
python automated_scraping/scripts/fish_reports_scraper.py --site socal --dry_run --verbose --date 2026-04-18
python automated_scraping/scripts/fish_reports_scraper.py --data_dir /tmp/scratch --days 7   # leave data/ alone
```

Scraper logs go to `scraper_v3.log` in the working directory. See `README.md` for full CLI flags.

## Repo map

| Path | Role |
|---|---|
| `index.html` | Single entry point. DOM mounts: `#reportsSection`, `#trendsSection`. Script load order (lines 46–51) is load-bearing — see below. |
| `static/js/dashboard.js` | **Daily Reports** view controller. Owns `_rt` state. |
| `static/js/trends.js` | **Trends** chart controller. Owns `_tr` state. Uses Chart.js. |
| `static/js/tripDuration.js` | Trip string parser + multi-day allocation. Reuse for any per-day math. |
| `static/js/moon.js` | Moon phase util (`moonPhase`, `daysToNearestNewOrFull`). |
| `static/js/ui.js` | Shared primitives (multi-select, segmented control) on `window.UI`. Reuse before building new widgets. |
| `static/css/style.css` | Design tokens in `:root` (colors, spacing, type scale, chart palette). Edit the token, not the rule. |
| `data/<region>.json` | **Generated output**, one file per source site. Don't hand-edit; the scraper overwrites it. |
| `automated_scraping/scripts/fish_reports_scraper.py` | `FishReportsScraper(site)` + CLI. `SITES` (per-region URL + city allowlist), `SIX_PACK_BOATS`, `BOAT_LANDING_OVERRIDES` at the top. Type-hinted; runs on 3.10+. |
| `scrape_run.sh` + `systemd/` | The scheduled run (every 4h, the only regular data writer). Runs in a dedicated clone that resets to `origin/main` each run. |
| `.github/workflows/scrape.yml` | Manual-only fallback, disabled in GitHub. Stop the timer before dispatching it. |

## Frontend architecture

- **Script load order matters.** `index.html` loads `moon.js` → `ui.js` → `tripDuration.js` → `trends.js` → `dashboard.js`. Later files depend on globals defined earlier. Don't reorder without tracing dependencies.
- **No modules, no bundler.** Each JS file is a `<script>` tag; module scope is achieved with IIFEs / file-level closures.
- **State lives in one object per view.** `_rt` in `dashboard.js`, `_tr` in `trends.js`. No Redux, no observers — just module-scoped objects mutated by event handlers.
- **Public vs. private.** Underscore-prefixed helpers (`_rtChangeDate`, `_trRender`) are file-internal. Anything callable from another file or from HTML is attached to `window`.

## Scraper notes

- `scrape_date_range` is **idempotent per region file**: when new records are saved, any existing records for the dates in the new batch are dropped first. That is only safe because each file has exactly one source; never point two sites at one file.
- **Tracked cities are an allowlist** (`SITES[...].cities`). The socal and norcal pages also return San Pedro, Redondo Beach, Ventura, Avila Beach, San Francisco, Sausalito, Half Moon Bay, Monterey, Santa Cruz, Bodega Bay, Eureka and San Jose for free. Adding one is a line in `SITES` plus a backfill of that region.
- **Six-packs are excluded** by name (`SIX_PACK_BOATS`). A boat new to a region that never carried more than 6 anglers logs a `WARNING` to review.
- **Landing comes from the boat cell's second link**, not the panel heading. On socal/norcal the panel is a city.
- Dedup key: `(date, location, boat, trip, anglers, species, count, released)`, plus `_dedupe_trips` for one trip listed under two landings. Each file is capped at 100,000 records (trimming logs a warning).
- Validate parsing changes with `--dry_run --verbose`, or `--data_dir` to a scratch folder, before touching the committed JSON.

## Gotchas

- **Multi-day trip allocation.** The source credits a trip's entire catch to its *return* date. `static/js/tripDuration.js` exposes two modes: **as-reported** (what the JSON stores) and **spread** (catch divided across the days the trip spanned). `trends.js` uses spread; `dashboard.js` surfaces a "Days" column and per-day rate. Any new per-day aggregation should reuse `tripDuration.js` — don't reimplement.
- **Moon phase is approximate.** Synodic cycle anchored to 2000-01-06, ±1 day accuracy. Fine for fishing. Don't swap in an astronomy dependency.
- **Relative paths.** The dashboard fetches `data/<region>.json` relatively, so it must be served from the repo root, not a subpath.
- **Regions switch by page reload.** `REGIONS` in `dashboard.js` maps region → file; the region comes from `?region=`, then localStorage, then `sandiego`. Changing it reloads the page, so Trends and Moon Calendar always initialize from one region's data. Don't add in-place region switching without making both views re-initializable.
- **Source links come from the data file** (`site_url`). Don't hard-code a site in the JS.
- **Species lookup tables live in `dashboard.js`.** Two module-level constants govern pill display: `SPECIES_DAILY_LIMIT` (species → daily bag limit per angler) and `SPECIES_CATEGORY` (category name → list of species name substrings). Add new species to both when scraper output introduces names not yet covered. The category helper `_rtSpeciesCategory(sp)` does case-insensitive substring matching — prefer adding full common names rather than short fragments to avoid false matches.
- **Trends breakdown is rebuilt on every `redraw()`.** `_tr.breakdown` (reset at the top of `redraw()`) is populated inside `seriesBySpecies()` and `seriesByBoat()` as a side effect of the main aggregation loop. The tooltip `label` callback reads from it synchronously. If you refactor the aggregation functions, ensure `_tr.breakdown` is still populated before `_tr.chart.update()` is called.

## Conventions

- JS: underscore prefix for private module state and helpers; public API on `window`. kebab-case for CSS classes and DOM IDs.
- CSS: change tokens in `:root` rather than individual rules.
- Python: type hints, `logging` to both stdout and `scraper_v3.log`, constants UPPER_CASE at module top.

## Verifying a change (no test suite exists)

- **Scraper:** `python automated_scraping/scripts/fish_reports_scraper.py --dry_run --verbose --date <recent-date>` (add `--site` to narrow) and inspect stdout + `scraper_v3.log`. Check a few parsed records match the source page.
- **Frontend:** `python -m http.server 8000`, open the dashboard, exercise date nav, species filter, and the Trends section. Watch the browser console. If you can't actually open a browser in your environment, say so explicitly — don't claim the UI works.
- **Both:** `git diff data/` should be empty unless you intentionally ran the scraper without `--dry_run`.
