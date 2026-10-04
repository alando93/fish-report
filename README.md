# Fishing Dashboard

A static web dashboard that automatically scrapes daily fish counts from California sportfishing landings (San Diego, SoCal and the Bay Area) and displays them as a browsable, date-navigable report table.

---

## What It Does

The scraper fetches the daily dock-totals page from three sister sites that share one page layout. Each page lists every boat that went out, the trip type, how many anglers were on board, and a breakdown of every species caught. That data is parsed into one structured JSON file per region and committed back to the repository. The dashboard reads the selected region's file and renders it as a filterable, date-browsable table. No backend is required.

| Region | Site | Cities tracked |
|---|---|---|
| `sandiego` | [sandiegofishreports.com](https://www.sandiegofishreports.com/dock_totals/boats.php) | Everything the site reports (San Diego, Oceanside) |
| `socal` | [socalfishreports.com](https://www.socalfishreports.com/dock_totals/boats.php) | Long Beach, Newport Beach, Dana Point, Oxnard, Santa Barbara, Morro Bay |
| `norcal` | [norcalfishreports.com](https://www.norcalfishreports.com/dock_totals/boats.php) | Berkeley, Emeryville |

**Six-pack charters are excluded** in every region (`SIX_PACK_BOATS` in the scraper). Their light loads distort per-angler numbers.

**Untracked cities come free.** The same page requests already return these cities, which the allowlist drops:
- **socal:** San Pedro, Marina Del Rey, Redondo Beach, Ventura, Avila Beach
- **norcal:** San Francisco, Sausalito, Half Moon Bay, Monterey, Santa Cruz, Bodega Bay, Eureka, San Jose

To track one, add it to that site's `cities` in `SITES`, then backfill that region (`--site <region> --start_date 2024-01-01 --end_date <today>`). No new scraping code is needed.

A systemd timer on a home server runs the scraper every 4 hours and pushes updated data (`scrape_run.sh`, `systemd/`).

---

## Dashboard

The dashboard has three tabs:

### Daily Reports
A table of all trips for a selected date, grouped by landing. Pick the region (San Diego / SoCal / NorCal) from the menu in the navbar; the choice is kept in the URL (`?region=socal`) and remembered for the next visit.

- Navigate dates with the prev/next arrows or the date picker
- Jump to the most recent data with the **Latest** button
- Filter the table to specific species using the **Filter species** dropdown
- Each species pill shows the raw count, average per angler, and (for multi-day trips) a per-day rate
- Pills are color-coded by species family — Tuna (blue), Rockfish (orange-red), Bass (green), Yellowtail (gold), Flatfish (teal), Dorado/Wahoo/Marlin/etc. (purple)
- A small health bar on each pill shows catch as a percentage of the legal daily bag limit per angler; a 🏆 appears when the limit is reached
- Click the source link to open the original report page on the region's source site

### Trends
Time-series charts of catch over time with configurable controls:

- **Mode** — by species (one line per species) or by boat (one line per vessel)
- **Metric** — total fish count, per-angler average, or total trip count
- **Smoothing** — none, 7-day, or 14-day rolling average
- **Range** — last 30 days, 90 days, 1 year, or all time
- **Attribution** — catch credited to the return date (as-reported) or spread evenly across the days the trip spanned
- Moon phase bands are drawn on the chart background; click any data point to jump to that date in Daily Reports

### Moon Calendar
A monthly grid view showing catch totals and moon phases day by day.

- Select a boat and optionally filter by species
- Each cell shows the total catch and top species for that day
- New moon and full moon days are highlighted
- Click any populated cell for a detailed species breakdown and a link to the Daily Report

The dashboard is a plain `index.html` file. Serve it from any static host or locally:

```bash
python -m http.server 8000
# open http://localhost:8000
```

---

## Project Structure

```
fish-report/
├── index.html                              # Dashboard
├── requirements.txt                        # Python dependencies
├── automated_scraping/
│   └── scripts/
│       └── fish_reports_scraper.py
├── data/
│   ├── sandiego.json                      # Scraped data, one file per region
│   ├── socal.json
│   └── norcal.json
├── scrape_run.sh                          # Scheduled run: sync → scrape → commit + push
├── systemd/                               # fish-scrape.service + .timer
├── static/
│   ├── css/style.css
│   └── js/
│       ├── dashboard.js      # Daily Reports view
│       ├── trends.js         # Trends chart (Chart.js)
│       ├── moonCalendar.js   # Moon Calendar view
│       ├── tripDuration.js   # Trip string parser + multi-day allocation
│       ├── moon.js           # Moon phase utilities
│       └── ui.js             # Shared widgets (multi-select, segmented control)
└── .github/
    └── workflows/
        └── scrape.yml                     # Manual-only fallback (disabled)
```

---

## Data

### Files

`data/<region>.json` (`sandiego`, `socal`, `norcal`): generated and updated by the scraper, committed by the scheduled run. Each file has exactly one source site.

### Schema

```json
{
  "region":       "sandiego",
  "source":       "San Diego Fish Reports",
  "site_url":     "https://www.sandiegofishreports.com",
  "last_updated": "2026-04-18 23:23:32 PDT",
  "reports": [
    {
      "region":     "sandiego",
      "location":   "San Diego, CA",
      "landing":    "H&M Landing",
      "boat":       "Intrepid",
      "trip":       "1.5 Day Overnight",
      "anglers":    "31 Anglers",
      "species":    "Bluefin Tuna",
      "count":      88,
      "released":   false,
      "date":       "2026-04-18",
      "source":     "San Diego Fish Reports",
      "source_url": "https://www.sandiegofishreports.com/dock_totals/boats.php?date=2026-04-18"
    }
  ]
}
```

| Field | Description |
|---|---|
| `region` | `sandiego`, `socal` or `norcal` |
| `location` | City/state from the boat cell; only cities in the region's allowlist are kept. San Diego defaults to `San Diego, CA` when the line is missing |
| `landing` | Dock or landing the boat departed from (the landing link in the boat cell) |
| `boat` | Vessel name |
| `trip` | Trip type — e.g. `1/2 Day AM`, `3/4 Day`, `Full Day`, `Overnight` |
| `anglers` | Passenger count text as it appears on the source page |
| `species` | Fish species caught |
| `count` | Number of that species caught on the trip |
| `released` | `true` if caught and released, `false` if kept |
| `date` | Date of the trip in `YYYY-MM-DD` format |
| `source` | The region's source site, e.g. `"SoCal Fish Reports"` |
| `source_url` | Direct URL to the original report for that date |

Records are deduplicated by `date + location + boat + trip + anglers + species + count + released`, and a trip listed under two landings on the same page is kept once. Each file is capped at 100,000 records, keeping the most recent; the scraper logs a warning if it ever trims. Historical data goes back to **January 2024**.

---

## Scraper

### Usage

```bash
# Install dependencies
pip install -r requirements.txt

# Scrape today and the previous 2 days for every region (default)
python automated_scraping/scripts/fish_reports_scraper.py

# One region (repeat --site for several)
python automated_scraping/scripts/fish_reports_scraper.py --site socal

# Scrape a specific date
python automated_scraping/scripts/fish_reports_scraper.py --date 2026-04-17

# Scrape a date range (saved in 30-day chunks)
python automated_scraping/scripts/fish_reports_scraper.py --start_date 2025-01-01 --end_date 2026-04-18

# Write somewhere other than data/ (experiments; leaves tracked files alone)
python automated_scraping/scripts/fish_reports_scraper.py --data_dir /tmp/scratch --days 7

# Parse and print without writing to disk
python automated_scraping/scripts/fish_reports_scraper.py --dry_run

# Verbose logging
python automated_scraping/scripts/fish_reports_scraper.py --verbose
```

### How It Works

1. For each region, sends a GET request to `boats.php?date=YYYY-MM-DD` for each date in the range, at most one request per second.
2. Finds every `.panel` div on the page. On sandiego a panel is a landing; on socal/norcal it is a city.
3. Each table row yields boat name, landing (the second link in the boat cell), city, trip type, angler count, and a catch string like `"107 Rockfish, 2 Sheephead Released"`. The trip type is a link on sandiego and plain text on socal/norcal.
4. Rows outside the region's city allowlist and six-pack boats are dropped. A boat new to the region that averages 6 or fewer anglers is logged as a likely six-pack to review.
5. The catch string is split with regex into individual `{species, count, released}` records.
6. New records are merged into the region's file, replacing old records for the same dates so re-runs are clean. A date whose records match the previous day exactly is skipped, because the site serves the prior day's page until it posts.

Logs are written to `scraper_v3.log` in the working directory.

---

## Automation

**Scheduled:** `fish-scrape.timer` (systemd user timer, every 4 hours at :30 UTC) runs `scrape_run.sh` in a dedicated clone. Each run syncs to `origin/main`, scrapes the last 2 days for every region, commits `data/` if it changed, and pushes. It never force-pushes, pings Healthchecks on success or failure, and is the only regular data writer.

**Manual fallback:** `.github/workflows/scrape.yml` is `workflow_dispatch` only and is disabled in GitHub. To use it, stop the timer, run `gh workflow enable "Scrape Fishing Reports"`, then dispatch it with optional `start_date`/`end_date`, `days` and `site` inputs.

---

## Setup

1. Clone the repository and `pip install -r requirements.txt`.
2. To backfill history, run the scraper with a date range and commit the region files:
   ```bash
   python automated_scraping/scripts/fish_reports_scraper.py --start_date 2024-01-01 --end_date 2026-04-18
   git add data/
   git commit -m "Backfill historical data"
   git push
   ```
3. Deploy via GitHub Pages or any static host. The dashboard fetches `data/<region>.json` via a relative path, so no backend or build step is needed.
4. For scheduled scraping, install `systemd/fish-scrape.{service,timer}` and point the service at `scrape_run.sh`.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Scraping | Python 3, `requests`, `BeautifulSoup4` |
| Automation | systemd timer (GitHub Actions as manual fallback) |
| Frontend | Vanilla HTML/CSS/JS |
| Styling | Bulma CSS, Font Awesome |
| Data | JSON (committed to repo) |

---

## Disclaimer

Data is sourced from sandiegofishreports.com, socalfishreports.com and norcalfishreports.com, and is provided for informational purposes only. Always verify conditions and regulations before fishing.
