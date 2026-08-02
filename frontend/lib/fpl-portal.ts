export type Position = "GKP" | "DEF" | "MID" | "FWD";

export interface SquadPlayer {
  name: string;
  team: string;
  position: Position;
  price: number;
  fixture: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  status?: "captain" | "vice" | "monitor";
  bench?: boolean;
}

export interface RadarPlayer {
  name: string;
  team: string;
  position: Position;
  price: number;
  ownership: number;
  next: string;
  ev4: number;
  ev6: number;
  xMins: number;
  trend: "rising" | "stable" | "falling";
  note: string;
}

export interface TransferScenario {
  id: string;
  name: string;
  label: string;
  summary: string;
  projected4: number;
  projected6: number;
  floor: number;
  ceiling: number;
  bank: number;
  out: string[];
  in: string[];
  core: string[];
  watchouts: string[];
}

export const currentSquad: SquadPlayer[] = [
  { name: "Alisson", team: "LIV", position: "GKP", price: 5.5, fixture: "NEW (A)", difficulty: 3, status: "vice" },
  { name: "O'Reilly", team: "MCI", position: "DEF", price: 6.5, fixture: "BOU (H)", difficulty: 3 },
  { name: "Tarkowski", team: "EVE", position: "DEF", price: 6.0, fixture: "CRY (H)", difficulty: 3 },
  { name: "Guéhi", team: "MCI", position: "DEF", price: 6.0, fixture: "BOU (H)", difficulty: 3 },
  { name: "Lacroix", team: "CRY", position: "DEF", price: 6.0, fixture: "EVE (A)", difficulty: 3 },
  { name: "Rice", team: "ARS", position: "MID", price: 7.5, fixture: "COV (H)", difficulty: 2 },
  { name: "Rogers", team: "CHE", position: "MID", price: 7.5, fixture: "FUL (A)", difficulty: 3 },
  { name: "Bruno G.", team: "NEW", position: "MID", price: 7.0, fixture: "LIV (H)", difficulty: 4 },
  { name: "Enzo", team: "CHE", position: "MID", price: 7.0, fixture: "FUL (A)", difficulty: 3 },
  { name: "Isak", team: "LIV", position: "FWD", price: 9.0, fixture: "NEW (A)", difficulty: 3 },
  { name: "Thiago", team: "BRE", position: "FWD", price: 8.0, fixture: "TOT (H)", difficulty: 3, status: "captain" },
  { name: "Lecomte", team: "FUL", position: "GKP", price: 4.0, fixture: "CHE (H)", difficulty: 4, bench: true },
  { name: "Truffert", team: "BOU", position: "DEF", price: 5.5, fixture: "MCI (A)", difficulty: 5, bench: true },
  { name: "Szoboszlai", team: "LIV", position: "MID", price: 7.0, fixture: "NEW (A)", difficulty: 3, bench: true },
  { name: "Gyökeres", team: "ARS", position: "FWD", price: 7.5, fixture: "COV (H)", difficulty: 2, bench: true },
];

export const radarPlayers: RadarPlayer[] = [
  { name: "Haaland", team: "MCI", position: "FWD", price: 15.5, ownership: 75.1, next: "BOU (H)", ev4: 28.4, ev6: 43.1, xMins: 86, trend: "rising", note: "Best captaincy coverage across the opening six." },
  { name: "Bruno Fernandes", team: "MUN", position: "MID", price: 12.0, ownership: 48.7, next: "HUL (A)", ev4: 24.8, ev6: 36.7, xMins: 89, trend: "rising", note: "Minutes, penalties and two elite opening fixtures." },
  { name: "Gabriel", team: "ARS", position: "DEF", price: 8.0, ownership: 25.4, next: "COV (H)", ev4: 21.6, ev6: 31.4, xMins: 88, trend: "stable", note: "Clean-sheet ceiling plus set-piece threat." },
  { name: "João Pedro", team: "CHE", position: "FWD", price: 7.5, ownership: 48.8, next: "FUL (A)", ev4: 19.3, ev6: 29.7, xMins: 80, trend: "rising", note: "Strong value if preseason role and penalties hold." },
  { name: "Rogers", team: "CHE", position: "MID", price: 7.5, ownership: 33.6, next: "FUL (A)", ev4: 18.5, ev6: 28.6, xMins: 82, trend: "stable", note: "Useful GW4 Hull captaincy hedge." },
  { name: "Gyökeres", team: "ARS", position: "FWD", price: 7.5, ownership: 13.8, next: "COV (H)", ev4: 18.9, ev6: 30.8, xMins: 79, trend: "rising", note: "Coventry and Leeds at home create explosive weeks." },
];

export const fixtureRuns = [
  { team: "MCI", player: "Haaland", fixtures: ["BOU H", "CRY A", "COV H", "MUN A", "SUN H", "LIV A"], scores: [3, 3, 2, 4, 2, 4] },
  { team: "MUN", player: "Bruno", fixtures: ["HUL A", "IPS H", "EVE A", "MCI H", "FUL A", "TOT H"], scores: [2, 2, 3, 4, 3, 3] },
  { team: "ARS", player: "Gyökeres", fixtures: ["COV H", "AVL A", "CHE H", "SUN A", "BHA A", "LEE H"], scores: [2, 4, 4, 3, 3, 2] },
  { team: "CHE", player: "Rogers", fixtures: ["FUL A", "BHA H", "ARS A", "HUL H", "BRE A", "BOU H"], scores: [3, 2, 5, 2, 3, 3] },
  { team: "LIV", player: "Isak", fixtures: ["NEW A", "NFO H", "IPS A", "FUL H", "BOU A", "MCI H"], scores: [3, 3, 2, 2, 3, 4] },
];

export const transferScenarios: TransferScenario[] = [
  {
    id: "captain-core",
    name: "Captaincy core",
    label: "Recommended",
    summary: "Concentrate budget in Haaland, Bruno and Gabriel, then protect flexibility with playable value picks.",
    projected4: 257.6,
    projected6: 382.4,
    floor: 341,
    ceiling: 429,
    bank: 0,
    out: ["Alisson", "O'Reilly", "Tarkowski", "Guéhi", "Lacroix", "Truffert", "Rice", "Bruno G.", "Enzo", "Szoboszlai", "Isak", "Thiago", "Lecomte"],
    in: ["Kinsky", "Dubravka", "Gabriel", "Maguire", "Mitchell", "C. Hughes", "B. Thomas", "Bruno Fernandes", "Stach", "Xhaka", "Slater", "Haaland", "João Pedro"],
    core: ["Haaland", "Bruno Fernandes", "Gabriel", "Rogers", "Gyökeres"],
    watchouts: ["Confirm Kinsky starts", "Monitor João Pedro's role", "Recheck Maguire minutes"],
  },
  {
    id: "balanced",
    name: "Balanced depth",
    label: "Lower variance",
    summary: "Keep Isak and spread funds across reliable starters, sacrificing Haaland captaincy coverage.",
    projected4: 248.1,
    projected6: 374.2,
    floor: 346,
    ceiling: 405,
    bank: 0.5,
    out: ["Alisson", "O'Reilly", "Tarkowski", "Lacroix", "Truffert", "Bruno G.", "Enzo", "Thiago"],
    in: ["Kinsky", "Gabriel", "Maguire", "Mitchell", "C. Hughes", "Bruno Fernandes", "Stach", "João Pedro"],
    core: ["Bruno Fernandes", "Isak", "Gabriel", "Rogers", "Gyökeres"],
    watchouts: ["No Haaland captain for BOU/COV/SUN", "More funds exposed to bench points"],
  },
  {
    id: "front-three",
    name: "Triple attack",
    label: "High ceiling",
    summary: "Haaland leads an aggressive three-forward structure with reduced defensive spend.",
    projected4: 260.3,
    projected6: 387.9,
    floor: 337,
    ceiling: 441,
    bank: 0,
    out: ["Alisson", "O'Reilly", "Tarkowski", "Guéhi", "Lacroix", "Truffert", "Rice", "Bruno G.", "Enzo", "Szoboszlai", "Isak"],
    in: ["Dubravka", "Gabriel", "Mitchell", "C. Hughes", "B. Thomas", "Bruno Fernandes", "Stach", "Xhaka", "Slater", "Haaland", "João Pedro"],
    core: ["Haaland", "Bruno Fernandes", "João Pedro", "Gyökeres", "Rogers"],
    watchouts: ["Thin defence", "Requires two £4.0m defenders to earn minutes"],
  },
];

export const captainPlan = [
  { gw: 1, captain: "Haaland", vice: "Gyökeres", fixture: "BOU (H)", confidence: 91 },
  { gw: 2, captain: "Bruno", vice: "Haaland", fixture: "IPS (H)", confidence: 87 },
  { gw: 3, captain: "Haaland", vice: "Bruno", fixture: "COV (H)", confidence: 94 },
  { gw: 4, captain: "Gyökeres", vice: "Rogers", fixture: "SUN (A)", confidence: 72 },
  { gw: 5, captain: "Haaland", vice: "Bruno", fixture: "SUN (H)", confidence: 93 },
  { gw: 6, captain: "Gyökeres", vice: "Bruno", fixture: "LEE (H)", confidence: 84 },
];

export const intelligenceItems = [
  {
    id: "fixtures",
    source: "AllAboutFPL",
    type: "Analysis",
    title: "2026/27 fixture analysis and opening runs",
    summary: "Use the editorial read to challenge model fixture ratings and identify fixture swings.",
    impact: "Planning",
    confidence: "Editorial",
    url: "https://allaboutfpl.com/",
    age: "3d",
    players: ["Haaland", "Bruno", "Gyökeres"],
  },
  {
    id: "scout",
    source: "Fantasy Football Scout",
    type: "Team news",
    title: "Preseason roles, expected line-ups and set pieces",
    summary: "Human context for expected minutes, tactical roles and uncertain starting positions.",
    impact: "High",
    confidence: "Corroborate",
    url: "https://www.fantasyfootballscout.co.uk/",
    age: "Monitor",
    players: ["Kinsky", "Maguire", "João Pedro"],
  },
  {
    id: "review",
    source: "FPL Review",
    type: "Model",
    title: "Projection and expected-minutes cross-check",
    summary: "Compare portal EV with a market-aware external model before locking a transfer.",
    impact: "High",
    confidence: "Model",
    url: "https://fplreview.com/",
    age: "Deadline",
    players: ["Haaland", "Bruno", "Gabriel"],
  },
  {
    id: "injuries",
    source: "Premier Injuries",
    type: "Injury",
    title: "Availability and potential return dates",
    summary: "Verify flags against official club comments; return dates are potential, not guarantees.",
    impact: "Squad",
    confidence: "Primary check",
    url: "https://www.premierinjuries.com/injury-table.php",
    age: "Live",
    players: ["My squad"],
  },
  {
    id: "market",
    source: "Market blend",
    type: "Odds",
    title: "Goalscorer and clean-sheet expectations",
    summary: "Use de-vigged market prices as a one-week signal, never as a standalone transfer rule.",
    impact: "Captaincy",
    confidence: "Market",
    url: "/value-bets",
    age: "Pending",
    players: ["Captain pool"],
  },
];

export const weeklyChecklist = [
  { id: "articles", label: "Read weekly strategy and captaincy articles", source: "AllAboutFPL" },
  { id: "team-news", label: "Review predicted line-ups and press conferences", source: "FFScout" },
  { id: "projections", label: "Cross-check EV and expected minutes", source: "FPL Review" },
  { id: "injuries", label: "Verify injuries, suspensions and return dates", source: "Premier Injuries" },
  { id: "decision", label: "Record transfer, captain and reason", source: "Decision journal" },
];
