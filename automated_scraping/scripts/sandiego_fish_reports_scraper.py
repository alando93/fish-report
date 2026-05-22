#!/usr/bin/env python3
"""
San Diego Fish Reports Scraper

Scrapes fishing report data from:
    https://www.sandiegofishreports.com/dock_totals/boats.php?date=YYYY-MM-DD

Usage:
    # Scrape the last 7 days (default)
    python sandiego_fish_reports_scraper.py

    # Scrape a specific date
    python sandiego_fish_reports_scraper.py --date 2026-04-17

    # Scrape a date range
    python sandiego_fish_reports_scraper.py --start_date 2026-04-01 --end_date 2026-04-17

    # Parse without saving
    python sandiego_fish_reports_scraper.py --dry_run

Output:
    data/fishing_reports.json  — matches the schema read by static/js/dashboard.js
"""

import argparse
import json
import logging
import os
import re
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Any, Dict, List, Optional

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
# Constants
# ---------------------------------------------------------------------------
BASE_URL = "https://www.sandiegofishreports.com/dock_totals/boats.php"
DATA_DIR = "data"
OUTPUT_FILE = os.path.join(DATA_DIR, "fishing_reports.json")
MAX_RECORDS = 100_000
REQUEST_TIMEOUT = 30
SOURCE_NAME = "San Diego Fish Reports"

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
    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        os.makedirs(DATA_DIR, exist_ok=True)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def scrape_date(self, date: str) -> List[Dict[str, Any]]:
        """Fetch and parse reports for a single date string (YYYY-MM-DD)."""
        url = f"{BASE_URL}?date={date}"
        logger.info("Fetching %s", url)

        try:
            response = self.session.get(url, timeout=REQUEST_TIMEOUT)
            response.raise_for_status()
        except requests.RequestException as exc:
            logger.error("Request failed for %s: %s", url, exc)
            return []

        try:
            soup = BeautifulSoup(response.content, "html.parser")
            reports = self._parse_page(soup, date, url)
        except Exception as exc:  # noqa: BLE001
            logger.error("Parse error for %s: %s", date, exc)
            return []

        logger.info("Extracted %d report rows for %s", len(reports), date)
        return reports

    def scrape_date_range(self, start_date: str, end_date: str, dry_run: bool = False) -> None:
        """Scrape every date in [start_date, end_date] inclusive."""
        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")

        if start > end:
            logger.error("start_date must be <= end_date")
            sys.exit(1)

        all_reports: List[Dict[str, Any]] = []
        current = start
        while current <= end:
            all_reports.extend(self.scrape_date(current.strftime("%Y-%m-%d")))
            current += timedelta(days=1)

        if all_reports:
            self.save_reports(all_reports, dry_run=dry_run)
        else:
            logger.warning("No reports collected for range %s – %s", start_date, end_date)

    def save_reports(self, new_reports: List[Dict[str, Any]], dry_run: bool = False) -> None:
        """Merge new_reports with existing data, deduplicate, trim, and write."""
        if dry_run:
            logger.info("DRY RUN — would save %d new report rows (sample below)", len(new_reports))
            print(json.dumps(new_reports[:5], indent=2))
            return

        existing = self._load_existing()
        existing_reports: List[Dict[str, Any]] = existing.get("reports", [])

        # Replace all records for dates present in the new batch
        new_dates = {r["date"] for r in new_reports}
        kept = [r for r in existing_reports if r["date"] not in new_dates]

        combined = self._deduplicate(kept + new_reports)
        # Keep the MAX_RECORDS most-recent records
        combined.sort(key=lambda r: r["date"], reverse=True)
        combined = combined[:MAX_RECORDS]

        sources = sorted({r["source"] for r in combined})
        payload = {
            "reports": combined,
            "last_updated": datetime.now(tz=ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d %H:%M:%S %Z"),
            "sources": sources,
        }

        with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)

        logger.info("Saved %d total reports to %s", len(combined), OUTPUT_FILE)

    # ------------------------------------------------------------------
    # Parsing helpers
    # ------------------------------------------------------------------

    def _parse_page(self, soup: BeautifulSoup, report_date: str, source_url: str) -> List[Dict[str, Any]]:
        reports: List[Dict[str, Any]] = []

        panels = soup.find_all("div", class_="panel")
        if not panels:
            logger.warning("No .panel elements found on page — HTML structure may have changed")
            return reports

        for panel in panels:
            landing = self._extract_landing_name(panel)
            if not landing:
                continue

            table = panel.find("table")
            if not table:
                logger.debug("Panel '%s' has no table, skipping", landing)
                continue

            rows = self._get_data_rows(table)
            for row in rows:
                cols = row.find_all("td")
                if len(cols) < 3:
                    continue
                try:
                    boat_info = self._parse_boat_col(cols[0])
                    trip_info = self._parse_trip_col(cols[1])
                    catches = self._parse_catch_col(cols[2])
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Skipping malformed row in landing '%s': %s", landing, exc)
                    continue

                if not boat_info or not catches:
                    continue

                for catch in catches:
                    reports.append(
                        {
                            "location": boat_info["location"],
                            "landing": landing,
                            "boat": boat_info["boat"],
                            "trip": trip_info["trip"],
                            "anglers": trip_info["anglers"],
                            "species": catch["species"],
                            "count": catch["count"],
                            "released": catch["released"],
                            "date": report_date,
                            "source": SOURCE_NAME,
                            "source_url": source_url,
                        }
                    )

        return reports

    @staticmethod
    def _extract_landing_name(panel: Tag) -> Optional[str]:
        heading = panel.find("h2")
        if not heading:
            return None
        name = heading.get_text(strip=True)
        # Strip the trailing page-title noise
        name = re.sub(r"\s*-?\s*Fish Counts for Today\s*$", "", name, flags=re.IGNORECASE)
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
    def _parse_boat_col(col: Tag) -> Optional[Dict[str, str]]:
        """
        First column: boat name on the first text line, optional address below.
        Location defaults to 'San Diego, CA' when no address is present.
        """
        lines = [ln.strip() for ln in col.get_text(separator="\n").splitlines() if ln.strip()]
        if not lines:
            return None

        boat = lines[0]
        location = "San Diego, CA"

        # Look for an address-style line: contains a comma or state abbreviation
        for line in lines[1:]:
            if re.search(r",\s*[A-Z]{2}|,\s*CA\b", line):
                location = line.strip()
                break

        return {"boat": boat, "location": location}

    @staticmethod
    def _parse_trip_col(col: Tag) -> Dict[str, str]:
        """
        Second column typically has:
          - a number (angler count) as plain text
          - a hyperlinked trip-type string
        Returns anglers as the full text (e.g. "53 Anglers") when available,
        or just the raw number string otherwise.
        """
        result: Dict[str, str] = {"trip": "Unknown", "anglers": "Unknown"}

        # Trip type is usually inside an <a> tag
        a_tag = col.find("a")
        if a_tag:
            result["trip"] = a_tag.get_text(strip=True)

        # Anglers: look for a line/span that mentions a number + "Anglers"
        full_text = col.get_text(separator="\n", strip=True)
        # Match patterns like "53 Anglers", "53", "Anglers: 53"
        angler_match = re.search(r"(\d+)\s*Anglers?", full_text, re.IGNORECASE)
        if angler_match:
            result["anglers"] = angler_match.group(0).strip()
        else:
            # Fallback: grab the first number found
            num_match = re.search(r"\d+", full_text)
            if num_match:
                result["anglers"] = num_match.group(0)

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

    @staticmethod
    def _load_existing() -> Dict[str, Any]:
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except FileNotFoundError:
            return {"reports": [], "last_updated": "", "sources": []}
        except json.JSONDecodeError as exc:
            logger.warning("Could not parse existing %s (%s) — starting fresh", OUTPUT_FILE, exc)
            return {"reports": [], "last_updated": "", "sources": []}

    @staticmethod
    def _deduplicate(reports: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        seen: set = set()
        unique: List[Dict[str, Any]] = []
        for r in reports:
            key = (r["date"], r.get("location"), r.get("boat"), r.get("species"), r.get("count"))
            if key not in seen:
                seen.add(key)
                unique.append(r)
        return unique


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="San Diego Fish Reports Scraper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python sandiego_fish_reports_scraper.py
  python sandiego_fish_reports_scraper.py --date 2026-04-17
  python sandiego_fish_reports_scraper.py --start_date 2026-04-01 --end_date 2026-04-17
  python sandiego_fish_reports_scraper.py --dry_run
        """,
    )
    parser.add_argument("--date", help="Scrape a single date (YYYY-MM-DD)")
    parser.add_argument("--start_date", help="Range start date (YYYY-MM-DD)")
    parser.add_argument("--end_date", help="Range end date (YYYY-MM-DD)")
    parser.add_argument("--days", type=int, default=14,
                        help="Default lookback window in days when no date args are given (default: 14)")
    parser.add_argument("--dry_run", action="store_true", help="Parse without writing to disk")
    parser.add_argument("--verbose", action="store_true", help="Enable DEBUG logging")
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    scraper = FishReportsScraper()

    try:
        if args.date:
            reports = scraper.scrape_date(args.date)
            scraper.save_reports(reports, dry_run=args.dry_run)

        elif args.start_date and args.end_date:
            scraper.scrape_date_range(args.start_date, args.end_date, dry_run=args.dry_run)

        elif args.start_date or args.end_date:
            logger.error("Both --start_date and --end_date are required for a range scrape.")
            sys.exit(1)

        else:
            # Default: scrape today and the previous N days (Pacific Time — boats are SoCal-based).
            # 14-day window catches boats that post their catch data up to two weeks late.
            today = datetime.now(tz=ZoneInfo("America/Los_Angeles"))
            end = today.strftime("%Y-%m-%d")
            start = (today - timedelta(days=args.days)).strftime("%Y-%m-%d")
            scraper.scrape_date_range(start, end, dry_run=args.dry_run)

    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    except Exception as exc:  # noqa: BLE001
        logger.error("Unexpected error: %s", exc, exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
