"""
The Understat join, on the names that actually break it.

Every fixture here is a real spelling taken from FPL's bootstrap and Understat on
2026-08-24. The four that matter are named in the module docstring of
`pipeline/data/understat.py`; a fifth (`Kadıoğlu`) is here because Turkish dotless
i does not decompose under NFKD and a naive fold drops him silently.

No network. `fetch_player_season_stats` is not exercised — its failure paths all
return None by design, and a test that asserts None is reached is a test of a
try/except, not of a join.
"""
import unittest

from pipeline.data.understat import fold, match_to_fpl


def _norm(name):
    """A stand-in for normalize_team_name: enough to make the clubs agree."""
    table = {
        "Coventry": "Coventry City", "Coventry City": "Coventry City",
        "Spurs": "Tottenham", "Tottenham": "Tottenham",
        "Man Utd": "Man Utd", "Manchester United": "Man Utd",
        "Liverpool": "Liverpool", "Brighton": "Brighton", "Chelsea": "Chelsea",
    }
    return table.get(str(name).strip(), str(name).strip())


#: FPL side, verbatim field values.
ELEMENTS = [
    {"id": 1, "first_name": "Alexander", "second_name": "Isak",
     "web_name": "Isak", "team": 10},
    {"id": 2, "first_name": "Bruno", "second_name": "Borges Fernandes",
     "web_name": "B.Fernandes", "team": 13},
    {"id": 3, "first_name": "João Pedro", "second_name": "Junqueira de Jesus",
     "web_name": "João Pedro", "team": 6},
    {"id": 4, "first_name": "Virgil", "second_name": "van Dijk",
     "web_name": "Virgil", "team": 10},
    {"id": 5, "first_name": "Ferdi", "second_name": "Kadıoğlu",
     "web_name": "F.Kadıoğlu", "team": 4},
    {"id": 6, "first_name": "Pascal", "second_name": "Groß",
     "web_name": "Groß", "team": 4},
    {"id": 7, "first_name": "Cody", "second_name": "Gakpo",
     "web_name": "Gakpo", "team": 10},
]

TEAM_OF = {10: "Liverpool", 13: "Man Utd", 6: "Chelsea", 4: "Brighton",
           7: "Coventry City"}


class Folding(unittest.TestCase):
    def test_accents_decompose(self):
        self.assertEqual(fold("João Pedro"), "joaopedro")

    def test_turkish_dotless_i_is_mapped_explicitly(self):
        # NFKD leaves U+0131 alone, so without the fold map this returns
        # "kadoglu" and the player never matches.
        self.assertEqual(fold("Kadıoğlu"), "kadioglu")

    def test_eszett_becomes_ss(self):
        self.assertEqual(fold("Groß"), "gross")

    def test_punctuation_and_case_are_dropped(self):
        self.assertEqual(fold("F.Kadıoğlu"), fold("f kadioglu"))

    def test_empty_is_empty(self):
        self.assertEqual(fold(""), "")
        self.assertEqual(fold(None), "")


class Matching(unittest.TestCase):
    def match(self, rows):
        return match_to_fpl(rows, ELEMENTS, TEAM_OF, _norm)

    def test_plain_first_and_last(self):
        matched, unmatched = self.match(
            [{"player": "Alexander Isak", "team": "Liverpool", "shots": 4}])
        self.assertEqual(unmatched, [])
        self.assertEqual(matched[1]["shots"], 4)

    def test_a_middle_name_fpl_carries_and_understat_does_not(self):
        # FPL second_name is "Borges Fernandes"; Understat says "Bruno Fernandes".
        matched, unmatched = self.match(
            [{"player": "Bruno Fernandes", "team": "Manchester United", "shots": 3}])
        self.assertEqual(unmatched, [])
        self.assertIn(2, matched)

    def test_a_player_whose_whole_name_is_the_fpl_first_name(self):
        # "João Pedro" is first_name; second_name is unrelated.
        matched, unmatched = self.match(
            [{"player": "João Pedro", "team": "Chelsea", "shots": 2}])
        self.assertEqual(unmatched, [])
        self.assertIn(3, matched)

    def test_a_lowercase_particle_surname(self):
        matched, unmatched = self.match(
            [{"player": "Virgil van Dijk", "team": "Liverpool", "shots": 1}])
        self.assertEqual(unmatched, [])
        self.assertIn(4, matched)

    def test_the_two_characters_nfkd_will_not_fold(self):
        matched, unmatched = self.match([
            {"player": "Ferdi Kadıoğlu", "team": "Brighton", "shots": 1},
            {"player": "Pascal Groß", "team": "Brighton", "shots": 2},
        ])
        self.assertEqual(unmatched, [])
        self.assertIn(5, matched)
        self.assertIn(6, matched)

    def test_clubs_are_canonicalised_before_the_join(self):
        # Understat says "Manchester United" where FPL says "Man Utd". Without
        # normalisation the club bucket is empty and every United player is lost.
        matched, _ = self.match(
            [{"player": "Bruno Fernandes", "team": "Manchester United"}])
        self.assertIn(2, matched)

    def test_an_unknown_club_is_reported_not_dropped(self):
        _, unmatched = self.match(
            [{"player": "Someone Else", "team": "Real Madrid"}])
        self.assertEqual(len(unmatched), 1)
        self.assertIn("club", unmatched[0]["reason"])

    def test_an_unknown_player_is_reported_with_the_club_it_looked_in(self):
        _, unmatched = self.match(
            [{"player": "Nobody At All", "team": "Liverpool"}])
        self.assertEqual(len(unmatched), 1)
        self.assertEqual(unmatched[0]["team"], "Liverpool")
        self.assertEqual(unmatched[0]["player"], "Nobody At All")

    def test_an_ambiguous_surname_is_left_unmatched_rather_than_guessed(self):
        elements = [
            {"id": 20, "first_name": "Aaron", "second_name": "Smith",
             "web_name": "A.Smith", "team": 10},
            {"id": 21, "first_name": "Ben", "second_name": "Smith",
             "web_name": "B.Smith", "team": 10},
        ]
        matched, unmatched = match_to_fpl(
            [{"player": "Smith", "team": "Liverpool"}], elements, TEAM_OF, _norm)
        self.assertEqual(matched, {})
        self.assertEqual(len(unmatched), 1)
        self.assertIn("share the key", unmatched[0]["reason"])

    def test_a_full_name_still_resolves_when_the_surname_is_shared(self):
        elements = [
            {"id": 20, "first_name": "Aaron", "second_name": "Smith",
             "web_name": "A.Smith", "team": 10},
            {"id": 21, "first_name": "Ben", "second_name": "Smith",
             "web_name": "B.Smith", "team": 10},
        ]
        matched, unmatched = match_to_fpl(
            [{"player": "Ben Smith", "team": "Liverpool"}], elements, TEAM_OF, _norm)
        self.assertEqual(unmatched, [])
        self.assertIn(21, matched)

    def test_fpls_own_display_name_breaks_a_shared_first_name(self):
        """
        Arsenal, live on 2026-08-24. Understat calls Gabriel Magalhães simply
        "Gabriel", and three Arsenal players are named Gabriel — so the folded
        key is ambiguous and the first run refused the match. But only one of
        them has `web_name == "Gabriel"`; FPL already made that call and
        deferring to it beats both guessing and giving up.
        """
        elements = [
            {"id": 30, "first_name": "Gabriel", "second_name": "Magalhães",
             "web_name": "Gabriel", "team": 1},
            {"id": 31, "first_name": "Gabriel", "second_name": "Martinelli",
             "web_name": "Martinelli", "team": 1},
            {"id": 32, "first_name": "Gabriel", "second_name": "Jesus",
             "web_name": "G.Jesus", "team": 1},
        ]
        matched, unmatched = match_to_fpl(
            [{"player": "Gabriel", "team": "Arsenal"}],
            elements, {1: "Arsenal"}, _norm)
        self.assertEqual(unmatched, [], f"unmatched: {unmatched}")
        self.assertIn(30, matched)
        self.assertNotIn(31, matched)

    def test_a_shared_surname_with_no_web_name_tiebreak_is_still_refused(self):
        # The web_name tier must not become a licence to guess: when it does not
        # single anybody out, ambiguity is still ambiguity.
        elements = [
            {"id": 40, "first_name": "Aaron", "second_name": "Smith",
             "web_name": "A.Smith", "team": 10},
            {"id": 41, "first_name": "Ben", "second_name": "Smith",
             "web_name": "B.Smith", "team": 10},
        ]
        matched, unmatched = match_to_fpl(
            [{"player": "Smith", "team": "Liverpool"}], elements, TEAM_OF, _norm)
        self.assertEqual(matched, {})
        self.assertEqual(len(unmatched), 1)

    def test_a_compound_surname_used_by_its_first_token(self):
        """
        Live on 2026-08-24, and the hardest name in the league: FPL has
        `Yéremy` / `Pino Santos`; Understat says `Yeremi Pino`. The first names
        disagree on a vowel (i vs y) so nothing built from them can match, and
        FPL's commonly-used surname is the FIRST token of second_name while
        Understat puts it last. `pino` is the only common ground.
        """
        elements = [{"id": 50, "first_name": "Yéremy",
                     "second_name": "Pino Santos", "web_name": "Yeremy",
                     "team": 7}]
        matched, unmatched = match_to_fpl(
            [{"player": "Yeremi Pino", "team": "Crystal Palace"}],
            elements, {7: "Crystal Palace"}, lambda n: "Crystal Palace")
        self.assertEqual(unmatched, [], f"unmatched: {unmatched}")
        self.assertIn(50, matched)

    def test_every_squad_name_from_the_live_data_matches(self):
        """The regression that matters: the real spellings, all at once."""
        rows = [
            {"player": "Alexander Isak", "team": "Liverpool"},
            {"player": "Cody Gakpo", "team": "Liverpool"},
            {"player": "Virgil van Dijk", "team": "Liverpool"},
            {"player": "Bruno Fernandes", "team": "Manchester United"},
            {"player": "João Pedro", "team": "Chelsea"},
            {"player": "Ferdi Kadıoğlu", "team": "Brighton"},
            {"player": "Pascal Groß", "team": "Brighton"},
        ]
        matched, unmatched = self.match(rows)
        self.assertEqual(unmatched, [], f"unmatched: {unmatched}")
        self.assertEqual(len(matched), 7)


if __name__ == "__main__":
    unittest.main()
