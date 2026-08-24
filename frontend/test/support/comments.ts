/**
 * Source text with its comments removed, for guards that scan for a literal.
 *
 * Extracted so the two scans that need it cannot drift. Both exist to catch a
 * value being TYPED where it should be imported or computed —
 * `lib/margin/margin.test.ts` looks for the design prototype's hand-written
 * numbers, `lib/margin/counting-rule.test.ts` looks for a retyped copy of
 * `COUNTING_RULE` — and both face the same problem, which `margin.test.ts` states
 * best:
 *
 *   A prototype number quoted in a docstring to explain why the screen does NOT
 *   draw it is the documentation this repo wants; the same number in an
 *   expression is the defect. Scanning raw text cannot tell them apart and would
 *   push authors to delete the explanation to get to green, which is the worst
 *   outcome available.
 *
 * So a comment quoting the thing is documentation and passes; an expression
 * containing it is the defect and fails.
 *
 * `//` is only treated as a line comment when it is not preceded by a colon, so
 * a `https://` inside a string survives.
 */
export function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
