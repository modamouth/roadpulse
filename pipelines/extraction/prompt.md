# Incident extraction prompt

Tested against a real example (an Informanté Facebook post about a fatal
crash on the Okahandja–Otjiwarongo road). Reliably extracts structured
fields and flags ambiguity rather than guessing.

## Prompt

```
You are extracting structured road accident data from Namibian news/social
media posts for a road safety database. Given the post text below, extract
the following fields as JSON. If a field isn't stated, use null. Do not guess
or infer numbers that aren't explicitly mentioned.

Fields:
- date_reported (the date the post was made, if inferable)
- date_occurred (when the accident happened, may be relative e.g. "this morning")
- road (name of the road)
- location_description (any distance/landmark reference)
- accident_type (collision, rollover, pedestrian, hit-and-run, other)
- vehicles_involved (list, e.g. ["bakkie", "16-seater bus"])
- fatalities (number, or null if unspecified)
- injuries_count (number, or null if only described vaguely)
- injuries_description (raw text if count isn't given)
- source_name
- confidence_notes (flag anything ambiguous, e.g. vague injury counts,
  relative dates, non-precise locations)

Post text:
"<paste post text here>"

Source: <source name>, posted <relative time>.
```

## Known-good example output

Input: the Informanté Facebook post ("UPDATE: A collision between a small
bakkie and a 16-seater bus has resulted in the deaths of four people...").

```json
{
  "date_reported": "<post date>",
  "date_occurred": "<post date> (morning, relative - 'this morning' as of a 2h-old post)",
  "road": "Okahandja-Otjiwarongo road",
  "location_description": "approximately 120km from Otjiwarongo",
  "accident_type": "collision",
  "vehicles_involved": ["bakkie", "16-seater bus"],
  "fatalities": 4,
  "injuries_count": null,
  "injuries_description": "several others were injured",
  "source_name": "Informanté (Facebook)",
  "confidence_notes": [
    "injuries_count is vague ('several') - needs manual estimate or leave null",
    "date_occurred inferred from post age + 'this morning', not an explicit date - verify against post timestamp",
    "location is distance-along-road, not a fixed point - requires route-based geocoding, not standard address lookup",
    "no lat/lng derivable directly from text"
  ]
}
```

## Implementation notes

- The `confidence_notes` field is doing real work — it's what should drive
  a `needs_review: true` flag on the resulting `incidents` row, not a
  separate heuristic.
- Add a `needs_review: boolean` derived field (non-empty `confidence_notes`
  → true) so a review dashboard can filter to just the ambiguous rows.
- This prompt assumes the post text is already extracted from its source
  (scraped HTML, Facebook post text, etc.) — the extraction step itself
  (getting the text) is a separate, unsolved piece. See the open question
  in `CLAUDE.md` about Facebook Graph API restrictions vs. news-site
  scraping as the source.
- Model used when this was tested: Claude (see project conversation
  history). Any reasonably capable LLM should handle this task; the prompt
  itself is the reusable artifact, not a specific model dependency.
