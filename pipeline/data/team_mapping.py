"""
Cross-source team name normalization.
Maps team names from Football-Data.co.uk, FBref, and FPL API to canonical names.
"""

# Canonical name → [aliases from various sources]
TEAM_ALIASES = {
    "Arsenal": ["Arsenal"],
    "Aston Villa": ["Aston Villa"],
    "Bournemouth": ["Bournemouth", "AFC Bournemouth"],
    "Brentford": ["Brentford"],
    "Brighton": ["Brighton", "Brighton and Hove Albion", "Brighton & Hove Albion"],
    "Burnley": ["Burnley"],
    "Chelsea": ["Chelsea"],
    "Crystal Palace": ["Crystal Palace"],
    "Everton": ["Everton"],
    "Fulham": ["Fulham"],
    "Ipswich": ["Ipswich", "Ipswich Town"],
    "Leeds": ["Leeds", "Leeds United"],
    "Leicester": ["Leicester", "Leicester City"],
    "Liverpool": ["Liverpool"],
    "Luton": ["Luton", "Luton Town"],
    "Man City": ["Man City", "Manchester City", "Manchester Ct"],
    "Man United": ["Man United", "Manchester United", "Manchester Utd", "Manchester Un"],
    "Newcastle": ["Newcastle", "Newcastle United", "Newcastle Utd"],
    "Nott'm Forest": ["Nott'm Forest", "Nottingham Forest", "Nott'ham Forest"],
    "Sheffield United": ["Sheffield United", "Sheffield Utd"],
    "Southampton": ["Southampton"],
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


# FPL API team ID → canonical name (updated each season from bootstrap-static)
FPL_TEAM_MAP = {
    1: "Arsenal",
    2: "Aston Villa",
    3: "Bournemouth",
    4: "Brentford",
    5: "Brighton",
    6: "Chelsea",
    7: "Crystal Palace",
    8: "Everton",
    9: "Fulham",
    10: "Ipswich",
    11: "Leicester",
    12: "Liverpool",
    13: "Man City",
    14: "Man United",
    15: "Newcastle",
    16: "Nott'm Forest",
    17: "Southampton",
    18: "Tottenham",
    19: "West Ham",
    20: "Wolves",
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
