"""
Cross-source team name normalization.
Maps team names from Football-Data.co.uk, FBref, and FPL API to canonical names.
"""

# Canonical name → [aliases from various sources]
# Includes current 2026-27 PL teams plus historical teams for multi-season training data
TEAM_ALIASES = {
    "Arsenal": ["Arsenal"],
    "Aston Villa": ["Aston Villa"],
    "Bournemouth": ["Bournemouth", "AFC Bournemouth"],
    "Brentford": ["Brentford"],
    "Brighton": ["Brighton", "Brighton and Hove Albion", "Brighton & Hove Albion"],
    "Burnley": ["Burnley"],
    "Chelsea": ["Chelsea"],
    "Coventry City": ["Coventry City", "Coventry"],
    "Crystal Palace": ["Crystal Palace"],
    "Everton": ["Everton"],
    "Fulham": ["Fulham"],
    "Hull City": ["Hull City", "Hull"],
    # Historical teams (relegated, kept for multi-season training data)
    "Ipswich": ["Ipswich", "Ipswich Town"],
    "Leeds": ["Leeds", "Leeds United"],
    "Leicester": ["Leicester", "Leicester City"],
    "Luton": ["Luton", "Luton Town"],
    "Liverpool": ["Liverpool"],
    "Man City": ["Man City", "Manchester City", "Manchester Ct"],
    "Man United": ["Man United", "Man Utd", "Manchester United", "Manchester Utd", "Manchester Un"],
    "Newcastle": ["Newcastle", "Newcastle United", "Newcastle Utd"],
    "Nott'm Forest": ["Nott'm Forest", "Nottingham Forest", "Nott'ham Forest"],
    "Sheffield United": ["Sheffield United", "Sheffield Utd"],
    "Southampton": ["Southampton"],
    "Sunderland": ["Sunderland"],
    "Tottenham": ["Tottenham", "Tottenham Hotspur", "Spurs"],
    "West Ham": ["West Ham", "West Ham United"],
    "Wolves": ["Wolves", "Wolverhampton Wanderers", "Wolverhampton"],
}

# Build reverse lookup: alias → canonical
_ALIAS_TO_CANONICAL = {}
for canonical, aliases in TEAM_ALIASES.items():
    for alias in aliases:
        _ALIAS_TO_CANONICAL[alias.lower()] = canonical


def normalize_team_name(name: str) -> str:
    """Convert any team name variant to canonical form."""
    if not name:
        return name
    canonical = _ALIAS_TO_CANONICAL.get(name.strip().lower())
    if canonical:
        return canonical
    # Try partial match
    name_lower = name.strip().lower()
    for alias, canon in _ALIAS_TO_CANONICAL.items():
        if alias in name_lower or name_lower in alias:
            return canon
    return name.strip()  # Return original if no match


# FPL API team ID → canonical name (2026-27 fallback).
# Runtime code derives this map from bootstrap-static rather than relying on it.
FPL_TEAM_MAP = {
    1: "Arsenal",
    2: "Aston Villa",
    3: "Bournemouth",
    4: "Brentford",
    5: "Brighton",
    6: "Chelsea",
    7: "Coventry City",
    8: "Crystal Palace",
    9: "Everton",
    10: "Fulham",
    11: "Hull City",
    12: "Ipswich",
    13: "Leeds",
    14: "Liverpool",
    15: "Man City",
    16: "Man United",
    17: "Newcastle",
    18: "Nott'm Forest",
    19: "Tottenham",
    20: "Sunderland",
}


def update_fpl_team_map(teams_data: list) -> dict:
    """Update FPL team ID mapping from bootstrap-static response."""
    mapping = {}
    for team in teams_data:
        team_id = team["id"]
        name = team["name"]
        canonical = normalize_team_name(name)
        mapping[team_id] = canonical
    return mapping
