#!/usr/bin/env bash
# Scheduled scrape on the OptiPlex (FISH-001 Part B): sync → scrape → commit + push data/.
# Run by fish-scrape.timer every 4h. Replaces the GitHub Actions cron as the one
# data writer once the coexistence window ends.
#
# Runs in a DEDICATED clone (~/git/fish-report-scraper) that always tracks main —
# never in ~/git/fish-report, which is the nginx staging tree and may have a
# preview branch checked out. Local state here is disposable: every run starts
# from a fresh origin/main, and the scraper is idempotent over its window, so
# nothing lost by a reset is not re-scraped on the next run.
#
# Never force-pushes. A push rejected because another writer got there first is
# retried from the new origin/main; any other failure logs, pings /fail, exits.
set -u

# Whole body in one block: bash parses it fully before running, so the
# reset below can rewrite this file mid-run without bash reading a mix.
{

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$REPO/.venv/bin/python"
SCRAPER="$REPO/automated_scraping/scripts/sandiego_fish_reports_scraper.py"
STAGING="$HOME/git/fish-report"
LOG="$HOME/.local/state/fish-scrape.log"
ENV_FILE="$HOME/.config/fish-scrape.env"   # HEALTHCHECKS_URL (ping URL)
DAYS="${SCRAPE_DAYS:-2}"
ATTEMPTS=3

mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG"; }

# shellcheck source=/dev/null
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

# Ping failure warns but never changes the run's outcome
hc_ping() {
    [ -n "${HEALTHCHECKS_URL:-}" ] || return 0
    curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECKS_URL}${1:-}" \
        || log "WARN heartbeat healthchecks${1:-} failed"
}

fail() {
    log "FAIL $1"
    hc_ping /fail
    exit 1
}

# Runs a step, logging OK or FAIL with the last line of its output
step() {
    local name="$1" out
    shift
    if out="$("$@" 2>&1)"; then
        log "OK   $name"
    else
        fail "$name (exit $?): $(printf '%s' "$out" | tail -n 1)"
    fi
}

cd "$REPO" || fail "repo dir missing"
log "RUN  start (last $DAYS days)"
hc_ping /start

pushed=0
for attempt in $(seq 1 "$ATTEMPTS"); do
    step fetch git fetch --quiet origin main
    step sync git reset --quiet --hard origin/main
    step scrape "$PY" "$SCRAPER" --days "$DAYS"

    if git diff --quiet -- data/; then
        log "OK   no new data"
        pushed=1
        break
    fi
    step commit git commit --quiet -m "Update fishing reports data (optiplex)" -- data/

    if out="$(git push --quiet origin main 2>&1)"; then
        log "OK   push ($(git rev-parse --short HEAD))"
        pushed=1
        break
    fi
    # Someone else (the Actions cron, during coexistence) pushed first:
    # start over from their commit. Anything else is a real failure.
    if printf '%s' "$out" | grep -qE 'rejected|fetch first|non-fast-forward'; then
        log "WARN push rejected — origin moved, retrying from new origin/main ($attempt/$ATTEMPTS)"
        continue
    fi
    fail "push (never forcing): $(printf '%s' "$out" | tail -n 1)"
done
[ "$pushed" -eq 1 ] || fail "push still rejected after $ATTEMPTS attempts"

# Keep staging data fresh — but only when the staging tree is on a clean main.
# A checked-out preview branch or local edits are left alone. Warn-only.
if [ -d "$STAGING/.git" ]; then
    branch="$(git -C "$STAGING" symbolic-ref --short -q HEAD)"
    if [ "$branch" = main ] && [ -z "$(git -C "$STAGING" status --porcelain --untracked-files=no)" ]; then
        git -C "$STAGING" pull --quiet --ff-only origin main >>"$LOG" 2>&1 \
            && log "OK   staging fast-forwarded" \
            || log "WARN staging fast-forward failed (left as-is)"
    else
        log "SKIP staging refresh — on '${branch:-detached}' or dirty"
    fi
fi

log "RUN  complete"
hc_ping
exit 0
}
