# n8n orchestration

The user already runs n8n (n8n Cloud, `adaire.app.n8n.cloud`) for other
projects (Chocnotes, facilities, eBay/Takealot pipelines — see their other
repos/notes if available). This project's extraction pipeline is intended
to live there too, rather than as a standalone script, so it's consistent
with the rest of their automation stack.

## Planned workflow shape

1. **Trigger** — scheduled (e.g. every few hours) or webhook-triggered from
   a source check.
2. **Source fetch** — pull new posts from whichever source is settled on
   (see the open question in `CLAUDE.md` about news sites vs. Facebook
   Graph API access).
3. **Extraction** — call an LLM (Claude) with the prompt in
   `pipelines/extraction/prompt.md`, passing the post text.
4. **Geocoding** — if the extracted `location_description` is a "distance
   from town" reference, call the linear-referencing helper
   (`pipelines/geocoding/`); if it's a normal address, use Nominatim
   directly.
5. **Write to review queue** — insert into the `incidents` table via the
   backend API (`POST /api/incidents`) with `verified: false,
   needs_review: true`. Never write directly to the database from n8n if
   the API exists — keep the API as the single write path so validation
   logic lives in one place.
6. **Notify** — optional: ping the user (email, Slack, whatever they
   already use) when new items land in the review queue.

## Why this isn't built yet

This was scoped in conversation (prompt tested, geocoding approach
designed) but never wired into an actual n8n workflow — that's real
remaining work, not a trivial wrapper. Whoever picks this up should build
the workflow directly in n8n (there's an MCP-based workflow builder tool
available in some sessions) once the backend API from step 5 exists to
write to.
