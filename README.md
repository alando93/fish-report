# SoCal Fishing Dashboard

A static web dashboard that automatically scrapes daily fish count data from San Diego landings and displays it as a browsable, date-navigable report table.

---

## What It Does

The scraper fetches fish count pages from [sandiegofishreports.com](https://www.sandiegofishreports.com/dock_totals/boats.php) for each landing in San Diego. Each page lists every boat that went out, the trip type, how many anglers were on board, and a breakdown of every species caught. That data is parsed into structured JSON and committed back to the repository. The dashboard reads the JSON and renders it as a filterable, date-browsable table — no backend required.

GitHub Actions runs the scraper every 4 hours and pushes updated data automatically.

---

## Dashboard

The dashboard has three tabs:

### Daily Reports
A table of all trips for a selected date, grouped by landing.

- Navigate dates with the prev/next arrows or the date picker
- Jump to the most recent data with the **Latest** button
- Filter the table to specific species using the **Filter species** dropdown
- Each species pill shows the raw count, average per angler, and (for multi-day trips) a per-day rate
- Pills are color-coded by species family — Tuna (blue), Rockfish (orange-red), Bass (green), Yellowtail (gold), Flatfish (teal), Dorado/Wahoo/Marlin/etc. (purple)
- A small health bar on each pill shows catch as a percentage of the legal daily bag limit per angler; a 🏆 appears when the limit is reached
- Click the source link to open the original report page on sandiegofishreports.com

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
│       └── sandiego_fish_reports_scraper.py
├── data/
│   └── fishing_reports.json               # Scraped data (read by dashboard)
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
        └── scrape.yml                     # GitHub Actions automation
```

---

## Data

### File

`data/fishing_reports.json` — generated and updated by the scraper, committed by GitHub Actions.

### Schema

```json
{
  "reports": [
    {
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
  ],
  "last_updated": "2026-04-18 23:23:32",
  "sources": ["San Diego Fish Reports"]
}
```

| Field | Description |
|---|---|
| `location` | City/state parsed from the boat's address; defaults to `San Diego, CA` |
| `landing` | Dock or landing the boat departed from |
| `boat` | Vessel name |
| `trip` | Trip type — e.g. `1/2 Day AM`, `3/4 Day`, `Full Day`, `Overnight` |
| `anglers` | Passenger count text as it appears on the source page |
| `species` | Fish species caught |
| `count` | Number of that species caught on the trip |
| `released` | `true` if caught and released, `false` if kept |
| `date` | Date of the trip in `YYYY-MM-DD` format |
| `source` | Always `"San Diego Fish Reports"` |
| `source_url` | Direct URL to the original report for that date |

Records are deduplicated by `date + location + boat + species + count`. The file stores up to 100,000 records, keeping the most recent. Historical data goes back to **January 2024**.

---

## Scraper

### Usage

```bash
# Install dependencies
pip install -r requirements.txt

# Scrape the last 2 days (today + yesterday, default)
python automated_scraping/scripts/sandiego_fish_reports_scraper.py

# Scrape a specific date
python automated_scraping/scripts/sandiego_fish_reports_scraper.py --date 2026-04-17

# Scrape a date range
python automated_scraping/scripts/sandiego_fish_reports_scraper.py --start_date 2025-01-01 --end_date 2026-04-18

# Parse and print without writing to disk
python automated_scraping/scripts/sandiego_fish_reports_scraper.py --dry_run

# Verbose logging
python automated_scraping/scripts/sandiego_fish_reports_scraper.py --verbose
```

### How It Works

1. Sends a GET request to `boats.php?date=YYYY-MM-DD` for each date in the range.
2. Finds every `.panel` div on the page — each panel is one landing.
3. For each panel, reads the `<h2>` heading (landing name) and parses the `<table>` of boat rows.
4. Each row yields: boat name, address/location, trip type, angler count, and a catch string like `"107 Rockfish, 2 Sheephead Released"`.
5. The catch string is split with regex into individual `{species, count, released}` records.
6. New records are merged with the existing JSON, removing any old records for the same dates to allow clean re-runs. The result is sorted by date descending and capped at 100,000 records.
7. The final payload is written to `data/fishing_reports.json`.

Logs are written to `scraper_v3.log` in the working directory.

---

## Automation

`.github/workflows/scrape.yml` runs on a schedule every 4 hours and can also be triggered manually from the Actions tab.

```
on:
  schedule:
    - cron: '0 */4 * * *'
  workflow_dispatch:
```

The workflow checks out the repo, installs dependencies, runs the scraper (last 2 days by default), and commits any changes to `data/` back to the repository. If nothing changed, it exits cleanly.

**Required:** GitHub Actions needs write access to the repo. For private repos, confirm `Settings → Actions → Workflow permissions` is set to **Read and write permissions**.

---

## Setup

1. Fork or clone the repository.
2. Enable GitHub Actions — the scheduled workflow will run automatically.
3. To backfill historical data, run the scraper locally with a date range and push the result:
   ```bash
   pip install -r requirements.txt
   python automated_scraping/scripts/sandiego_fish_reports_scraper.py --start_date 2024-01-01 --end_date 2026-04-18
   git add data/fishing_reports.json
   git commit -m "Backfill historical data"
   git push
   ```
4. Deploy `index.html` via GitHub Pages, Netlify, or any static host. The dashboard fetches `data/fishing_reports.json` via a relative path — no backend or build step needed.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Scraping | Python 3, `requests`, `BeautifulSoup4` |
| Automation | GitHub Actions |
| Frontend | Vanilla HTML/CSS/JS |
| Styling | Bulma CSS, Font Awesome |
| Data | JSON (committed to repo) |

---

## Disclaimer

Data is sourced from sandiegofishreports.com and is provided for informational purposes only. Always verify conditions and regulations before fishing.
