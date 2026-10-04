#!/usr/bin/env python3
"""
Fish Reports Scraper

Scrapes daily dock totals from three sister sites that share one page layout:
    https://www.sandiegofishreports.com/dock_totals/boats.php?date=YYYY-MM-DD
    https://www.socalfishreports.com/dock_totals/boats.php?date=YYYY-MM-DD
    https://www.norcalfishreports.com/dock_totals/boats.php?date=YYYY-MM-DD

Each site is a region with its own output file (data/<region>.json). A region keeps
only the cities in its allowlist, and six-pack charters are dropped everywhere.

Usage:
    # Scrape the last 2 days for every region (default)
    python fish_reports_scraper.py

    # One region, one date
    python fish_reports_scraper.py --site socal --date 2026-04-17

    # Backfill a date range
    python fish_reports_scraper.py --start_date 2024-01-01 --end_date 2026-04-17

    # Parse without saving
    python fish_reports_scraper.py --dry_run

Output:
    data/<region>.json — matches the schema read by static/js/dashboard.js
"""

import argparse
import copy
import json
import logging
import os
import re
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Any, Dict, FrozenSet, List, Optional

import requests
from bs4 import BeautifulSoup, Tag

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("scraper_v3.log", mode="a"),
    ],
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Sites
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Site:
    region: str
    source: str
    base_url: str
    # Cities kept, matched against the "City, CA" line of each boat cell.
    # None keeps every city the site reports.
    cities: Optional[FrozenSet[str]]
    # Used when a boat cell has no city line.
    default_location: Optional[str] = None

    @property
    def dock_totals_url(self) -> str:
        return f"{self.base_url}/dock_totals/boats.php"


SITES: Dict[str, Site] = {
    "sandiego": Site(
        region="sandiego",
        source="San Diego Fish Reports",
        base_url="https://www.sandiegofishreports.com",
        cities=None,
        default_location="San Diego, CA",
    ),
    # The same pages also report San Pedro, Redondo Beach, Ventura and Avila Beach.
    # Adding one is a line here plus a backfill.
    "socal": Site(
        region="socal",
        source="SoCal Fish Reports",
        base_url="https://www.socalfishreports.com",
        cities=frozenset({
            "Marina Del Rey, CA",
            "Long Beach, CA",
            "Newport Beach, CA",
            "Dana Point, CA",
            "Oxnard, CA",
            "Santa Barbara, CA",
            "Morro Bay, CA",
        }),
    ),
    # The same pages also report San Francisco, Sausalito, Half Moon Bay, Monterey,
    # Santa Cruz, Bodega Bay, Eureka and San Jose.
    "norcal": Site(
        region="norcal",
        source="NorCal Fish Reports",
        base_url="https://www.norcalfishreports.com",
        cities=frozenset({
            "Berkeley, CA",
            "Emeryville, CA",
        }),
    ),
}

# Six-pack and other small private charters, dropped in every region: their light
# loads distort per-angler numbers. Names exactly as the sites print them.
SIX_PACK_BOATS: FrozenSet[str] = frozenset({
    # sandiego
    "Bight 23 (SD)", "Bight 28 (SD)", "Effishency", "El Gato Dos", "Freeman 34",
    "Game Changer", "Got Bait", "Limitless", "Little G", "Lucky B Sportfishing",
    "Nautilus", "No Patience", "Primetime", "Reel Champion", "Voodoo",
    # socal
    "Blackfish", "Current", "Graylight", "Lex Sea", "Second Chance",
    # norcal
    "Diamond", "Golden State Sportfishing", "Here We Go", "Playn Hooky",
    "Reel Addiction 1", "Reel Addiction 2", "Round 2", "Scallywag",
})

# A boat not yet in a region's file that averages this many anglers or fewer is
# logged as a likely six-pack, for a human to add to SIX_PACK_BOATS.
SIX_PACK_WARN_ANGLERS = 6

# Boats that some days appear under two landings with the same trip. Pin them to
# their home landing so the duplicate collapses (see _dedupe_trips).
BOAT_LANDING_OVERRIDES: Dict[str, str] = {
    "Western Pride": "Davey's Locker",
}

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_DATA_DIR = "data"
MAX_RECORDS = 100_000
REQUEST_TIMEOUT = 30
REQUEST_DELAY = 1.0          # seconds between requests to one site
SAVE_EVERY_DAYS = 30         # long ranges are saved in chunks, so a crash loses little

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

# Regex: matches patterns like "107 Rockfish", "2 Sheephead Released",
# or "96 Bluefin Tuna (up to 60 pounds)". The optional parenthetical group
# consumes weight/size notes before the lookahead so they don't break matching.
CATCH_PATTERN = re.compile(r"(\d+)\s+([A-Za-z][A-Za-z\s]*?)(?:\s+(Released))?(?:\s*\([^)]*\))?(?=\s*,\s*\d|\s*$)")


# ---------------------------------------------------------------------------
# Scraper
# ---------------------------------------------------------------------------
class FishReportsScraper:
    def __init__(self, site: Site, data_dir: str = DEFAULT_DATA_DIR) -> None:
        self.site = site
        self.output_file = os.path.join(data_dir, f"{site.region}.json")
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._last_request = 0.0
        os.makedirs(data_dir, exist_ok=True)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def scrape_date(self, date: str) -> List[Dict[str, Any]]:
        """Fetch and parse reports for a single date string (YYYY-MM-DD)."""
        url = f"{self.site.dock_totals_url}?date={date}"
        logger.info("Fetching %s", url)

        wait = REQUEST_DELAY - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        try:
            response = self.session.get(url, timeout=REQUEST_TIMEOUT)
            response.raise_for_status()
        except requests.RequestException as exc:
            logger.error("Request failed for %s: %s", url, exc)
            return []
        finally:
            self._last_request = time.monotonic()

        try:
            soup = BeautifulSoup(response.content, "html.parser")
            reports = self._parse_page(soup, date, url)
        except Exception as exc:  # noqa: BLE001
            logger.error("Parse error for %s %s: %s", self.site.region, date, exc)
            return []

        logger.info("Extracted %d report rows for %s %s", len(reports), self.site.region, date)
        return reports

    def scrape_date_range(self, start_date: str, end_date: str, dry_run: bool = False) -> None:
        """Scrape every date in [start_date, end_date] inclusive, saving in chunks."""
        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")

        if start > end:
            logger.error("start_date must be <= end_date")
            sys.exit(1)

        collected_any = False
        chunk: List[Dict[str, Any]] = []
        days_in_chunk = 0
        current = start
        while current <= end:
            chunk.extend(self.scrape_date(current.strftime("%Y-%m-%d")))
            days_in_chunk += 1
            current += timedelta(days=1)
            if days_in_chunk == SAVE_EVERY_DAYS or current > end:
                if chunk:
                    self.save_reports(chunk, dry_run=dry_run)
                    collected_any = True
                chunk, days_in_chunk = [], 0

        if not collected_any:
            logger.warning("No %s reports collected for range %s – %s",
                           self.site.region, start_date, end_date)

    def save_reports(self, new_reports: List[Dict[str, Any]], dry_run: bool = False) -> None:
        """Merge new_reports with existing data, deduplicate, trim, and write."""
        if dry_run:
            logger.info("DRY RUN — would save %d new %s report rows (sample below)",
                        len(new_reports), self.site.region)
            print(json.dumps(new_reports[:5], indent=2))
            return

        existing = self._load_existing()
        existing_reports: List[Dict[str, Any]] = existing.get("reports", [])

        self._warn_possible_six_packs(new_reports, existing_reports)

        # Drop any dates whose content is identical to the previous day — this happens when
        # the site hasn't posted a date's data yet and serves the prior day's page instead.
        # last_updated still advances, which triggers the frontend warning banner.
        new_reports = self._filter_duplicate_dates(new_reports, existing_reports)

        # Replace all records for dates present in the new batch
        new_dates = {r["date"] for r in new_reports}
        kept = [r for r in existing_reports if r["date"] not in new_dates]

        combined = self._deduplicate(kept + new_reports)
        combined.sort(key=lambda r: r["date"], reverse=True)
        if len(combined) > MAX_RECORDS:
            logger.warning("%s has %d records; trimming to the newest %d (oldest date kept: %s)",
                           self.output_file, len(combined), MAX_RECORDS,
                           combined[MAX_RECORDS - 1]["date"])
            combined = combined[:MAX_RECORDS]

        payload = {
            "region": self.site.region,
            "source": self.site.source,
            "site_url": self.site.base_url,
            "last_updated": datetime.now(tz=ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d %H:%M:%S %Z"),
            "reports": combined,
        }

        tmp = self.output_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
        os.replace(tmp, self.output_file)

        logger.info("Saved %d total reports to %s", len(combined), self.output_file)

    # ------------------------------------------------------------------
    # Parsing helpers
    # ------------------------------------------------------------------

    def _parse_page(self, soup: BeautifulSoup, report_date: str, source_url: str) -> List[Dict[str, Any]]:
        trips: List[Dict[str, Any]] = []

        panels = soup.find_all("div", class_="panel")
        if not panels:
            logger.warning("No .panel elements found on page — HTML structure may have changed")
            return []

        for panel in panels:
            panel_name = self._extract_panel_name(panel)
            if not panel_name:
                continue

            table = panel.find("table")
            if not table:
                logger.debug("Panel '%s' has no table, skipping", panel_name)
                continue

            for row in self._get_data_rows(table):
                cols = row.find_all("td", recursive=False)
                if len(cols) < 3:
                    continue
                try:
                    boat_info = self._parse_boat_col(cols[0], panel_name, self.site.default_location)
                    trip_info = self._parse_trip_col(cols[1])
                    catches = self._parse_catch_col(cols[2])
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Skipping malformed row in panel '%s': %s", panel_name, exc)
                    continue

                if not boat_info or not catches:
                    continue
                if self.site.cities is not None and boat_info["location"] not in self.site.cities:
                    continue
                if boat_info["boat"] in SIX_PACK_BOATS:
                    continue

                trips.append({**boat_info, **trip_info, "catches": catches})

        reports: List[Dict[str, Any]] = []
        for trip in self._dedupe_trips(trips):
            for catch in trip["catches"]:
                reports.append(
                    {
                        "region": self.site.region,
                        "location": trip["location"],
                        "landing": trip["landing"],
                        "boat": trip["boat"],
                        "trip": trip["trip"],
                        "anglers": trip["anglers"],
                        "species": catch["species"],
                        "count": catch["count"],
                        "released": catch["released"],
                        "date": report_date,
                        "source": self.site.source,
                        "source_url": source_url,
                    }
                )
        return reports

    @staticmethod
    def _dedupe_trips(trips: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Drop a trip listed twice on one page (same boat, trip and anglers), e.g.
        Western Pride under both Davey's Locker and Newport Landing. The two copies'
        catch lists can differ slightly, so this works per trip, not per record."""
        seen: set = set()
        unique: List[Dict[str, Any]] = []
        for t in trips:
            key = (t["boat"], t["trip"], t["anglers"])
            if key in seen:
                logger.debug("Dropping duplicate listing of %s %s under %s", t["boat"], t["trip"], t["landing"])
                continue
            seen.add(key)
            unique.append(t)
        return unique

    @staticmethod
    def _extract_panel_name(panel: Tag) -> Optional[str]:
        heading = panel.find("h2")
        if not heading:
            return None
        name = heading.get_text(strip=True)
        # "H&M Landing Fish Counts", "Long Beach Fish Counts for Today" → the name alone
        name = re.sub(r"\s*-?\s*Fish Counts(?: for Today)?\s*$", "", name, flags=re.IGNORECASE)
        return name.strip() or None

    @staticmethod
    def _get_data_rows(table: Tag) -> List[Tag]:
        tbody = table.find("tbody")
        if tbody:
            return tbody.find_all("tr")
        all_rows = table.find_all("tr")
        # Skip the first row if it looks like a header (contains <th>)
        if all_rows and all_rows[0].find("th"):
            return all_rows[1:]
        return all_rows

    @staticmethod
    def _parse_boat_col(col: Tag, panel_name: str, default_location: Optional[str]) -> Optional[Dict[str, str]]:
        """
        First column: boat link, landing link, then a "City, CA" line:
            <a><b>Dolphin</b></a><br><a>Fisherman's Landing</a><br>San Diego, CA
        The landing comes from the second link. San Diego panels are landings, but
        SoCal/NorCal panels are cities, so the panel name is only a fallback.
        """
        lines = [ln.strip() for ln in col.get_text(separator="\n").splitlines() if ln.strip()]
        if not lines:
            return None

        boat = lines[0]
        links = col.find_all("a")
        landing = links[1].get_text(strip=True) if len(links) > 1 else panel_name
        landing = BOAT_LANDING_OVERRIDES.get(boat, landing)

        location = default_location
        for line in lines[1:]:
            if re.search(r",\s*[A-Z]{2}\b", line):
                location = line
                break
        if location is None:
            return None

        return {"boat": boat, "landing": landing, "location": location}

    @staticmethod
    def _parse_trip_col(col: Tag) -> Dict[str, str]:
        """
        Second column: angler count, then the trip type, then an optional <i> note:
            35 Anglers<br><a>3/4 Day</a>                 (San Diego: trip is a link)
            4 Anglers<br>3/4 Day<br><i>Point Sal</i>     (SoCal/NorCal: plain text)
        Returns anglers as the full text (e.g. "53 Anglers") when available,
        or just the raw number string otherwise.
        """
        result: Dict[str, str] = {"trip": "Unknown", "anglers": "Unknown"}

        col = copy.copy(col)
        for note in col.find_all("i"):
            note.decompose()
        lines = [ln.strip() for ln in col.get_text(separator="\n").splitlines() if ln.strip()]
        full_text = "\n".join(lines)

        angler_match = re.search(r"(\d+)\s*Anglers?", full_text, re.IGNORECASE)
        if angler_match:
            result["anglers"] = angler_match.group(0).strip()
        else:
            num_match = re.search(r"\d+", full_text)
            if num_match:
                result["anglers"] = num_match.group(0)

        a_tag = col.find("a")
        if a_tag:
            result["trip"] = a_tag.get_text(strip=True)
        else:
            rest = [ln for ln in lines if not re.fullmatch(r"\d+\s*Anglers?", ln, re.IGNORECASE)]
            if rest:
                result["trip"] = rest[0]

        return result

    @staticmethod
    def _parse_catch_col(col: Tag) -> List[Dict[str, Any]]:
        """
        Third column: one or more catches, e.g.:
            "107 Rockfish, 2 Sheephead Released, 10 Calico Bass"

        Each entry becomes {'species': str, 'count': int, 'released': bool}.
        """
        text = col.get_text(separator=" ", strip=True)
        # Normalise multiple spaces
        text = re.sub(r"\s{2,}", " ", text)

        catches: List[Dict[str, Any]] = []

        for m in CATCH_PATTERN.finditer(text):
            count_str, raw_species, released_flag = m.group(1), m.group(2), m.group(3)

            species = raw_species.strip()
            # Strip any trailing "Released" that slipped into the species group
            species = re.sub(r"\s*Released\s*$", "", species, flags=re.IGNORECASE).strip()

            if not species:
                continue

            try:
                count = int(count_str)
            except ValueError:
                continue

            catches.append(
                {
                    "species": species,
                    "count": count,
                    "released": released_flag is not None,
                }
            )

        if not catches:
            logger.debug("No catches parsed from cell text: %r", text[:120])

        return catches

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------

    def _warn_possible_six_packs(
        self,
        new_reports: List[Dict[str, Any]],
        existing_reports: List[Dict[str, Any]],
    ) -> None:
        """Log boats new to this region whose trips average few anglers."""
        known = {r["boat"] for r in existing_reports}
        anglers_by_trip: Dict[tuple, int] = {}
        for r in new_reports:
            if r["boat"] in known:
                continue
            m = re.match(r"\d+", r.get("anglers") or "")
            if m:
                anglers_by_trip[(r["boat"], r["date"], r["trip"])] = int(m.group(0))

        by_boat: Dict[str, List[int]] = defaultdict(list)
        for (boat, _, _), anglers in anglers_by_trip.items():
            by_boat[boat].append(anglers)
        for boat, loads in sorted(by_boat.items()):
            avg = sum(loads) / len(loads)
            if avg <= SIX_PACK_WARN_ANGLERS:
                logger.warning(
                    "New %s boat '%s' averages %.1f anglers over %d trip(s) — "
                    "likely a six-pack; add it to SIX_PACK_BOATS if so",
                    self.site.region, boat, avg, len(loads),
                )

    @staticmethod
    def _canonical_rows(reports: List[Dict[str, Any]]) -> frozenset:
        return frozenset(
            (r.get("landing"), r.get("boat"), r.get("trip"),
             r.get("anglers"), r.get("species"), r.get("count"))
            for r in reports
        )

    def _filter_duplicate_dates(
        self,
        new_reports: List[Dict[str, Any]],
        existing_reports: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Remove dates from new_reports whose records match the prior day exactly."""
        existing_by_date: Dict[str, List] = defaultdict(list)
        for r in existing_reports:
            existing_by_date[r["date"]].append(r)

        new_by_date: Dict[str, List] = defaultdict(list)
        for r in new_reports:
            new_by_date[r["date"]].append(r)

        kept: List[Dict[str, Any]] = []
        for date in sorted(new_by_date):
            records = new_by_date[date]
            prev_date = (
                datetime.strptime(date, "%Y-%m-%d") - timedelta(days=1)
            ).strftime("%Y-%m-%d")
            # Prefer freshly-scraped prev-day data (same run = guaranteed same content
            # when the site is serving stale data). Fall back to stored data if the
            # previous day wasn't included in this scrape batch.
            prev_records = new_by_date.get(prev_date) or existing_by_date.get(prev_date, [])
            if prev_records and self._canonical_rows(records) == self._canonical_rows(prev_records):
                logger.warning(
                    "Skipping %s %s — %d records are identical to %s; "
                    "%s likely hasn't posted this date yet",
                    self.site.region, date, len(records), prev_date, self.site.base_url,
                )
            else:
                kept.extend(records)
        return kept

    def _load_existing(self) -> Dict[str, Any]:
        try:
            with open(self.output_file, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except FileNotFoundError:
            return {"reports": []}
        except json.JSONDecodeError as exc:
            logger.warning("Could not parse existing %s (%s) — starting fresh", self.output_file, exc)
            return {"reports": []}

    @staticmethod
    def _deduplicate(reports: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        seen: set = set()
        unique: List[Dict[str, Any]] = []
        for r in reports:
            key = (r["date"], r.get("location"), r.get("boat"), r.get("trip"),
                   r.get("anglers"), r.get("species"), r.get("count"), r.get("released"))
            if key not in seen:
                seen.add(key)
                unique.append(r)
        return unique


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fish Reports Scraper (San Diego, SoCal, NorCal)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python fish_reports_scraper.py
  python fish_reports_scraper.py --site socal --date 2026-04-17
  python fish_reports_scraper.py --start_date 2026-04-01 --end_date 2026-04-17
  python fish_reports_scraper.py --data_dir /tmp/scratch --site norcal --days 7
  python fish_reports_scraper.py --dry_run
        """,
    )
    parser.add_argument("--site", action="append", choices=sorted(SITES),
                        help="Region to scrape; repeat for several (default: all)")
    parser.add_argument("--date", help="Scrape a single date (YYYY-MM-DD)")
    parser.add_argument("--start_date", help="Range start date (YYYY-MM-DD)")
    parser.add_argument("--end_date", help="Range end date (YYYY-MM-DD)")
    parser.add_argument("--days", type=int, default=2,
                        help="Default lookback window in days when no date args are given (default: 2)")
    parser.add_argument("--data_dir", default=DEFAULT_DATA_DIR,
                        help=f"Directory for the region JSON files (default: {DEFAULT_DATA_DIR})")
    parser.add_argument("--dry_run", action="store_true", help="Parse without writing to disk")
    parser.add_argument("--verbose", action="store_true", help="Enable DEBUG logging")
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    if (args.start_date or args.end_date) and not (args.start_date and args.end_date):
        logger.error("Both --start_date and --end_date are required for a range scrape.")
        sys.exit(1)

    if args.date:
        start = end = args.date
    elif args.start_date:
        start, end = args.start_date, args.end_date
    else:
        # Default: today and the previous N days (Pacific Time — every boat is in California).
        today = datetime.now(tz=ZoneInfo("America/Los_Angeles"))
        end = today.strftime("%Y-%m-%d")
        start = (today - timedelta(days=args.days)).strftime("%Y-%m-%d")

    try:
        for region in args.site or list(SITES):
            scraper = FishReportsScraper(SITES[region], data_dir=args.data_dir)
            scraper.scrape_date_range(start, end, dry_run=args.dry_run)
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    except Exception as exc:  # noqa: BLE001
        logger.error("Unexpected error: %s", exc, exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
