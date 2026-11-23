// Landing websites, for the booking link next to each landing in Daily Reports.
//
// Keyed by the landing name exactly as the scraper stores it (`landing` in
// data/<region>.json). A landing missing from this map just shows no link.
// URLs come from each landing's profile page on the fish-reports sites, checked
// 2026-11-22. Where a landing has no working site of its own (Marina Del Rey's
// returns 403 on a mismatched certificate; Hooks Landing's is blank), the link
// goes to its fish-reports profile, which lists its trips with booking links.

(function (global) {
    const LANDING_URLS = {
        // sandiego
        "Fisherman's Landing":     'https://www.fishermanslanding.com',
        'H&M Landing':             'https://www.hmlanding.com',
        'Oceanside Sea Center':    'https://www.oceansideseacenter.com',
        'Point Loma Sportfishing': 'https://www.pointlomasportfishing.com',
        'Seaforth Sportfishing':   'https://www.seaforthlanding.com',

        // socal
        '22nd Street Landing':                    'https://www.22ndstreet.com',
        'Black Pearl Sportfishing':               'https://www.blackpearlsportfishing.net',
        'Channel Islands Sportfishing':           'https://www.channelislandssportfishing.com',
        'Dana Wharf Sportfishing':                'https://danawharf.com',
        "Davey's Locker":                         'https://daveyslocker.com',
        'Hooks Landing':                          'https://www.socalfishreports.com/landings/hooks_landing.php',
        'LA Waterfront Cruises and Sportfishing': 'https://lawaterfrontcruises.com',
        'Long Beach Sportfishing':                'https://www.longbeachsportfishing.org',
        'Marina Del Rey Sportfishing':            'https://www.socalfishreports.com/landings/marina_del_rey_sportfishing.php',
        'Morro Bay Landing':                      'https://morrobaylanding.com',
        'Newport Landing':                        'https://newportlanding.com',
        'Pierpoint Landing':                      'https://www.pierpoint.net',
        'Redondo Beach Sportfishing':             'https://www.redondosportfishing.com',
        'Santa Barbara Landing':                  'https://www.sblanding.com',
        "Virg's Landing":                         'https://www.virgslanding.com',

        // norcal
        'Berkeley Charter Boats':       'https://berkeleycharterboats.com',
        'California Dawn Sportfishing': 'https://californiadawn.com',
        'Fish Emeryville':              'https://www.fishemeryville.com',
        'Happy Hooker Sportfishing':    'https://www.happyhookersportfishing.com',
        'Right Hook Sportfishing':      'https://www.righthook.net',
    };

    global.landingUrl = function (landing) {
        return LANDING_URLS[landing] || null;
    };
})(window);
