export const meta = {
  name: 'seal-audit',
  description: 'Find ways this repo could lose a gameweek seal, then adversarially verify each before reporting it',
  whenToUse: 'Before a deadline, after changing the phase machine or fpl_agent.yml, or when asked whether a seal is at risk',
  phases: [
    { title: 'Find', detail: 'independent lenses on how a seal could be lost' },
    { title: 'Verify', detail: 'three skeptics per finding, prompted to refute' },
    { title: 'Report', detail: 'what survived, ranked by cost' },
  ],
}

const REPO = '/Users/tusk-jvb/dev/pl-prediction-engine'

// `args` may carry a scope, e.g. a commit range or a specific file. Absent = audit the whole area.
const SCOPE = typeof args === 'string' && args.trim()
  ? `Scope this audit to: ${args}`
  : 'Audit the whole seal path as it currently stands on this branch.'

const RULES = `
Repo: ${REPO}. READ-ONLY: do not edit files, and run no git command that mutates state.
Tests: PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -q
  (the repo venv, NOT bare python3 which lacks scipy; never pipe to tail, which masks the exit code).

${SCOPE}

WHAT A LOST SEAL MEANS. pipeline/learning/ledger.py seal_forecast writes
predictions/fpl/ledger/gwNN/forecast.jsonl once per gameweek. It is the only artifact proving a
forecast predated kickoff, there are 38 a season, and a missed one is permanent. The window opens at
deadline-SEAL_WINDOW (4h) and closes at deadline-LOCKOUT_BEFORE_DEADLINE (30min).

ESTABLISHED, do not re-derive — but DO verify any line you cite yourself:
  - Phases derive from files on disk, not the clock (pipeline/learning/schedule.py header), so a
    failed or delayed tick is survivable: a later tick re-derives the same phase.
  - .github/workflows/fpl_agent.yml runs hourly plus '0,30 13-16 * * 5'. Its 'work' job is gated on
    needs.decide.outputs.needs_work == 'true'. The commit step is 'if: always()'.
  - run_agent.py calls seal_forecast BEFORE _decide_for_entries, the latter inside
    try/except Exception, so a decision failure cannot un-seal a forecast.
  - Dry runs are quarantined to ledger/dryrun/gwNN by gameweek_dir, and _gameweeks_with uses
    re.fullmatch plus a non-recursive iterdir so 'dryrun' cannot read as sealed.
  - Three writers share main via disjoint pathspecs enforced by FORBID_PATHS in
    .github/scripts/commit_and_push.sh, which exits 1 on a match and retries three times.

A finding is only worth reporting if it ends in a gameweek with no forecast.jsonl, or a forecast.jsonl
that is wrong. "Untidy", "could be clearer" and "lacks a test" are not seal losses — say so and move on.
`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'chain', 'endsInLostSeal', 'citation'],
        properties: {
          title: { type: 'string' },
          chain: { type: 'string', description: 'Each step from trigger to lost or wrong seal' },
          endsInLostSeal: { type: 'boolean' },
          citation: { type: 'string', description: 'file:line plus the quoted line' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'reasoning', 'citationHolds'],
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
    citationHolds: { type: 'boolean', description: 'False if the cited line does not say what was claimed' },
  },
}

phase('Find')

const LENSES = [
  { key: 'gate', prompt: `The decide job and its outputs. What makes 'work' skip when it should run? Consider anything that could leave needs_work unset, empty or false while a seal is genuinely due, and anything that makes the decide step exit zero without emitting outputs.` },
  { key: 'window', prompt: `Timing and cron. Enumerate the actual seal-capable ticks for a real deadline by running determine_phase against the live calendar, and find any deadline slot where the count is dangerously low. Check whether concurrency settings, queueing, or cancel-in-progress could reduce the effective count below the nominal one.` },
  { key: 'write', prompt: `The write itself. What could make seal_forecast raise, write a short file, or write to the wrong path? Include the universe filter, the in-progress marker, freeze_inputs, and anything that could leave a partial forecast.jsonl that later reads as a completed seal.` },
  { key: 'commit', prompt: `Getting the seal off the runner. The forecast exists on disk before the commit step; what could stop it reaching main? Read commit_and_push.sh in full: retries, autostash, the FORBID_PATHS guard, the ancestor verification, and the interaction with the other two writers.` },
  { key: 'masking', prompt: `False positives — anything that could make the machine believe a gameweek is ALREADY sealed when it is not, so it goes idle instead of sealing. Include the dryrun quarantine, directory-name matching, and any path where a non-seal artifact could satisfy the sealed check.` },
]

const audited = await pipeline(
  LENSES,
  (l) => agent(`${RULES}\n\nYOUR LENS (${l.key}):\n${l.prompt}\n\nReport only findings that end in a ` +
    `lost or wrong seal. An empty findings array is a good result, not a failure to try.`,
    { label: `find:${l.key}`, phase: 'Find', schema: FINDING_SCHEMA, effort: 'high' }),
  (r) => r == null ? null : parallel(
    r.findings.filter((f) => f.endsInLostSeal).flatMap((f) =>
      ['mechanism', 'already-mitigated', 'citation'].map((angle) => () =>
        agent(`${RULES}\n\nA colleague claims this can cost a seal:\n\nTITLE: ${f.title}\n` +
          `CHAIN: ${f.chain}\nCITATION: ${f.citation}\n\n` +
          `REFUTE it from the angle "${angle}". For "mechanism", find the step that does not actually ` +
          `follow. For "already-mitigated", find the existing guard they missed. For "citation", open ` +
          `the cited line and check it says what they claim — a fabricated or drifted citation is the ` +
          `most serious thing you can report. Default to refuted=true when uncertain.`,
          { label: `verify:${f.title.slice(0, 24)}:${angle}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' })
          .then((v) => v == null ? null : ({ finding: f, angle, ...v }))
      )
    )
  ).then((votes) => ({ lens: r.lens, votes: votes.filter(Boolean) }))
)

phase('Report')

// Group votes by finding title, then keep findings a majority of skeptics failed to kill.
const byTitle = new Map()
for (const r of audited.filter(Boolean)) {
  for (const v of r.votes) {
    const key = v.finding.title
    if (!byTitle.has(key)) byTitle.set(key, { finding: v.finding, votes: [] })
    byTitle.get(key).votes.push(v)
  }
}

const confirmed = []
for (const { finding, votes } of byTitle.values()) {
  const kills = votes.filter((v) => v.refuted).length
  const badCitation = votes.some((v) => !v.citationHolds)
  log(`${finding.title.slice(0, 44)} — ${kills}/${votes.length} refuted${badCitation ? ' (CITATION FAILED)' : ''}`)
  if (kills < Math.ceil(votes.length / 2) && !badCitation) {
    confirmed.push({ ...finding, refuted: `${kills}/${votes.length}` })
  }
}

return {
  confirmed,
  summary: confirmed.length === 0
    ? 'No seal-loss path survived adversarial verification.'
    : `${confirmed.length} path(s) survived. Each ends in a gameweek with no forecast, or a wrong one.`,
}
