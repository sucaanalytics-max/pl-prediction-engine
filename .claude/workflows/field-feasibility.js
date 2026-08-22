export const meta = {
  name: 'field-feasibility',
  description: 'Re-measure what FPL's API makes affordable: sampling frame, picks cost, live payload, and required sample size',
  phases: [
    { title: 'Probe', detail: 'gentle, low-volume probes of four endpoints' },
    { title: 'Statistics', detail: 'required sample size, then an adversarial check' },
    { title: 'Verdict', detail: 'one feasibility synthesis' },
  ],
}

const REPO = '/Users/tusk-jvb/dev/pl-prediction-engine'

const RULES = `
Repo: ${REPO}. Python: \`PYTHONPATH=. .venv/bin/python\` (unittest, NOT pytest).

*** HARD SAFETY CONSTRAINT — READ TWICE ***
GW1 is LIVE right now and this project's pipeline depends on
https://fantasy.premierleague.com/api/bootstrap-static/ being reachable. Its GW2 seal is
irrecoverable. Getting this machine's IP rate-limited or blocked would be a serious,
self-inflicted production incident.

Therefore:
  - Make AT MOST 8 HTTP requests to fantasy.premierleague.com in total, across your whole task.
  - Sleep at least 2 seconds between requests.
  - NEVER run a rate-limit stress test, a loop, a benchmark, or a concurrency probe. Do not try to
    find the limit by hitting it. Infer cost from response headers, payload sizes and arithmetic.
  - Use a normal User-Agent.
If you cannot answer something within that budget, say so and explain what would be needed. An
honest "not measured" is worth far more here than a number obtained by hammering.

Report exact payload shapes, key names, byte sizes and HTTP status codes you actually observed.
Never invent a field name — if you did not see it, say you did not see it.

CONTEXT already established (do not re-derive):
  - bootstrap-static gives, per element: selected_by_percent (OVERALL ownership %),
    transfers_in_event, transfers_out_event, selected_rank. Top level: total_players = 9,126,353.
  - pipeline/config.py:52 defines FPL_EVENT_LIVE = ".../event/{gameweek}/live/" and
    pipeline/learning/outcomes.py already parses it at settlement.
  - The repo currently calls ONLY bootstrap-static in anger. No league or standings call exists.
  - livefpl.net shows, per player, an "EO (Effective Ownership)" figure segmented by rank tier
    (e.g. "Top 10k"), plus live rank, and "threats" = high-EO players you do not own.
`

const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'requestsMade', 'observed', 'costArithmetic', 'answer', 'notMeasured'],
  properties: {
    question: { type: 'string' },
    requestsMade: { type: 'integer', description: 'Actual count of HTTP requests you made' },
    observed: {
      type: 'array',
      description: 'Concrete observations: URL, status, key fields seen, payload size',
      items: { type: 'string' },
    },
    costArithmetic: { type: 'string', description: 'Requests and bytes needed at realistic scale, shown as arithmetic' },
    answer: { type: 'string' },
    notMeasured: { type: 'array', items: { type: 'string' } },
  },
}

phase('Probe')

const PROBES = [
  {
    key: 'standings-frame',
    prompt: `Can we obtain a SAMPLING FRAME of manager entry ids, and at what cost? Probe the classic
league standings endpoint for the "Overall" league (league id 314):
  https://fantasy.premierleague.com/api/leagues-classic/314/standings/?page_standings=1
Report: HTTP status; whether auth is needed; how many entries per page; the exact key names for an
entry's id and total; whether has_next is present; and whether deep pages are reachable (try ONE
deep page, e.g. page 20, not a sweep). Then compute: how many requests to collect 10,000 entry ids,
and how many to collect 1,000. State whether the top of league 314 is a sample of the TOP of the
distribution rather than a representative sample of all 9.1M managers — that distinction decides
what it can and cannot be used for.`,
  },
  {
    key: 'picks-endpoint',
    prompt: `Can we read an arbitrary manager's squad, and at what cost? Probe
  https://fantasy.premierleague.com/api/entry/{id}/event/{gw}/picks/
for a couple of known-public entries (use 20945, and one more of your choosing) at gameweek 1.
Report: HTTP status; whether auth is needed; the exact key names for the picks array, element id,
multiplier, is_captain, is_vice_captain; whether entry_history with points/bank/value is included;
and the payload size in bytes. Then compute the cost of fetching picks for 1,000 and for 10,000
managers, and the total bytes. Note explicitly whether this endpoint is available BEFORE a deadline
(it should not be) and whether it is stable AFTER one.`,
  },
  {
    key: 'live-endpoint',
    prompt: `What exactly does the live endpoint give us, and how cheap is a refresh? Probe
  https://fantasy.premierleague.com/api/event/1/live/
ONCE. Report: HTTP status; payload size in bytes; how many elements; the exact stat key names
available per element (especially total_points, minutes, bonus, and anything resembling provisional
or BPS); and whether it carries enough to recompute a manager's score from their picks WITHOUT any
further per-manager request. Cross-check your reading of the shape against
pipeline/learning/outcomes.py, which already parses this endpoint, and cite the lines. The key
question: is one request per refresh sufficient to rescore an arbitrary number of already-known
squads?`,
  },
  {
    key: 'eo-from-bootstrap',
    prompt: `How far does the data we ALREADY fetch get us toward livefpl's numbers, at zero
additional cost? Do NOT make any HTTP request unless you truly need one (budget: at most 2).
Read the repo instead: pipeline/data/fpl_api.py, pipeline/run_pipeline.py around line 1135,
pipeline/learning/ledger.py around 115-130.
Answer precisely: (a) what does selected_by_percent give us and what does it NOT — specifically,
can true Effective Ownership be computed from it, given EO needs captaincy and chip multipliers?
(b) what do transfers_in_event / transfers_out_event enable, and is that a usable stand-in for
livefpl's "Popular Transfers"? (c) is selected_by_percent segmented by rank tier, or overall only?
(d) which livefpl features become available with ZERO new data collection, which need a sample of
squads, and which need something we cannot get at all. Be blunt about the boundary.`,
  },
]

const probes = await parallel(
  PROBES.map((p) => () =>
    agent(`${RULES}\n\nYOUR PROBE (${p.key}):\n${p.prompt}`,
      { label: `probe:${p.key}`, phase: 'Probe', schema: PROBE_SCHEMA, effort: 'high' })
  )
)

const found = probes.filter(Boolean)
for (const p of found) log(`${p.question.slice(0, 50)} — ${p.requestsMade} requests`)

phase('Statistics')

const evidence = JSON.stringify(
  found.map((p) => ({ q: p.question, observed: p.observed, cost: p.costArithmetic, answer: p.answer })),
  null, 1
)

const STATS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sampleForEO', 'sampleForRank', 'reasoning', 'refuted', 'caveats'],
  properties: {
    sampleForEO: { type: 'string', description: 'Sample size for EO within ~1 percentage point, with the arithmetic' },
    sampleForRank: { type: 'string', description: 'Whether a live rank estimate is possible from a top-of-league sample, and what it would actually mean' },
    reasoning: { type: 'string' },
    refuted: { type: 'boolean', description: 'True if you conclude a calibrated live rank is NOT achievable this way' },
    caveats: { type: 'array', items: { type: 'string' } },
  },
}

const stats = await parallel([
  () => agent(`${RULES}\n\nMEASURED EVIDENCE:\n${evidence}\n\n` +
    `You are a statistician. Two questions, with arithmetic shown.\n` +
    `(1) EO: to estimate a player's effective ownership within about 1 percentage point, how many ` +
    `sampled squads are needed? Use the binomial standard error. Note that EO for a TIER (e.g. top ` +
    `10k) is a population parameter of that tier, so sampling the tier's own members is the right ` +
    `frame and the tier is only 10,000 managers — discuss the finite-population correction.\n` +
    `(2) LIVE RANK: livefpl reports a live overall rank out of ~9.1M. A sample drawn from the TOP of ` +
    `league 314 is not representative of all 9.1M managers. State plainly whether a calibrated ` +
    `overall live rank is achievable from such a sample, what it would take instead, and what a ` +
    `defensible weaker claim would be (e.g. rank WITHIN the top 10k, or a points-to-rank curve ` +
    `anchored on the manager's own last known overall rank). Prefer an honest weaker claim over an ` +
    `impressive number that would be wrong.`,
    { label: 'stats:sizing', phase: 'Statistics', schema: STATS_SCHEMA, effort: 'high' }),
  () => agent(`${RULES}\n\nMEASURED EVIDENCE:\n${evidence}\n\n` +
    `Adversarial pass. Someone is about to propose: "fetch picks for N sampled managers once after ` +
    `the deadline, then rescore all N locally from a single event/{gw}/live/ request per refresh, ` +
    `and interpolate our own score onto the resulting points-to-rank curve to show a live rank".\n\n` +
    `Try to REFUTE that this yields a trustworthy live rank. Attack specifically: sample ` +
    `representativeness; auto-substitutions and captain-to-vice fallback changing a squad's score ` +
    `mid-gameweek without any new fetch; chips (Bench Boost, Triple Captain) that alter the ` +
    `multiplier set; provisional vs confirmed bonus; transfers made mid-gameweek by other managers; ` +
    `and price/value drift. For each, say whether it is fatal, correctable, or ignorable, and how it ` +
    `would be corrected. Default to refuted=true if the resulting number would mislead its reader.`,
    { label: 'stats:refute', phase: 'Statistics', schema: STATS_SCHEMA, effort: 'high' }),
])

phase('Verdict')

const verdict = await agent(
  `${RULES}\n\nMEASURED PROBES:\n${evidence}\n\nSTATISTICS AND REFUTATION:\n${JSON.stringify(stats.filter(Boolean), null, 1)}\n\n` +
  `Write the feasibility verdict, for an engineer who will act on it this week. Structure it as three ` +
  `tiers, and be ruthless about which tier each livefpl feature falls into:\n` +
  `  TIER 1 — buildable with data we ALREADY fetch, no new collection.\n` +
  `  TIER 2 — needs a once-per-gameweek sample of squads; state the request count, the cadence, and ` +
  `           what the resulting numbers may honestly be CALLED.\n` +
  `  TIER 3 — not honestly achievable; say what livefpl must be doing instead that we cannot.\n` +
  `For every number a tier would put on screen, state its provenance and its error. This project's ` +
  `house rule is that a number whose uncertainty is hidden is a defect, so a feature that cannot ` +
  `state its own error belongs in tier 3 until it can.`,
  { label: 'verdict', phase: 'Verdict', effort: 'high' }
)

return { probes: found, statistics: stats.filter(Boolean), verdict }
