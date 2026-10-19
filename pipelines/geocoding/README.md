# Geocoding: "distance from town" references

Namibian news/crash reports frequently describe a location as a distance
along a named road from a town, e.g. "approximately 120 kilometres from
Otjiwarongo" on the Okahandja–Otjiwarongo road. This isn't a geocodable
address — Nominatim (or any standard geocoder) can't resolve "120km from X"
directly. This needs its own helper.

## The approach

1. **Resolve the two endpoint towns** to coordinates (Nominatim or a
   lookup table — the towns involved are a small, known set: Namibia's
   major towns don't change).
2. **Confirm the route is unambiguous.** If there's more than one road
   between the towns, or other towns on the same route (which would make
   "120km from X" ambiguous — could be measured from a different
   reference point), this step needs a human to confirm which route is
   meant. Don't guess silently — flag `needs_review`.
3. **Pull the real road geometry.** Query the Overpass API for the OSM
   `way`(s) making up that road between the two towns. This gives an
   actual polyline, not a straight line.
4. **Walk the line to the target distance.** Standard linear-referencing /
   "point along a line" operation — e.g. Turf.js's `along()` function (JS)
   or GeoPandas/Shapely's interpolation (Python) if the geocoding step runs
   server-side in Python. Walk from the reference town along the real
   polyline for the stated distance; the point you land on is the
   coordinate.

## What the prototype does instead (known simplification)

`docs/prototype-dashboard.html`'s one incident record was geocoded by
**straight-line interpolation** between Otjiwarongo and Okahandja's
coordinates — i.e. step 4 above, but using a straight line instead of real
road geometry from step 3. This was flagged at the time as introducing
error: the real B1 road distance between these towns is roughly 190km, vs.
~170km straight-line, so "120km along the real road" and "120km along the
straight-line approximation" land a few kilometres apart. Fine for a
one-off "drop a pin near the right stretch" use case; not accurate enough
to build the real pipeline on.

## Why this matters more at scale

The Okahandja–Otjiwarongo stretch is unusually direct (the B1 barely
curves), which is why the straight-line approximation was only a few km
off. Other roads curve much more — the error from skipping real road
geometry would be worse elsewhere. Build the Overpass + linear-referencing
version from the start rather than extending the straight-line shortcut.

## Implementation sketch

```
GET https://overpass-api.de/api/interpreter
  ?data=[out:json];way["name"="B1"](bbox);out geom;
```

(Namibian road names/refs vary — some are known by route number like "B1",
others by local name. Worth building a small lookup table of Namibia's
major routes and their OSM identifiers rather than re-querying Overpass by
name every time.)

Then, with the geometry as a list of lat/lng points:

```ts
import { lineString, along, length } from '@turf/turf';

const line = lineString(roadCoordinates); // [[lng,lat], ...] from Overpass
const point = along(line, distanceKm, { units: 'kilometers' });
// point.geometry.coordinates is [lng, lat]
```

Respect Overpass's usage policy (it's a shared public service) — cache
road geometry locally once fetched rather than re-querying per incident.
