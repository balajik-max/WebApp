# Ward Water-Demand Report — Feature Report

**Prepared for:** Davangere Smart Urban Survey & Architecture Dashboard
**Date:** 2026-07-15
**Status:** Proposed — pending sign-off on the open decisions in Section 6

---

## 1. What this feature is

Today the platform tells the client *what infrastructure exists* (buildings, drains,
manholes, lights, roads) ward by ward. This feature adds a second question on top
of that: **given how many people live in a ward, how much water does that ward
need — and for what?**

The important part: **the user doesn't type population numbers into a form.**
They just load a ward in the webapp — same as they already do today for any other
report — and the backend already has what it needs to answer the water-demand
question immediately.

---

## 2. What happens the instant a ward is loaded

This is the core mechanic, spelled out step by step:

1. Someone opens a ward in the webapp — picks it in Analytics, or uploads/tags a
   survey dataset to it. This is the *only* action they take.
2. In that same backend call, the platform looks that ward up against a census
   table that already lives in its own database — it was put there once, at
   setup time (Section 3), the same way the platform already seeds its
   admin/architect logins on first boot. No live call to any outside website
   happens per request.
3. Still in that one call, the backend counts whatever building footprints have
   already been surveyed for that ward from the existing map data.
4. It runs the water-demand calculation (Section 5) on those two numbers.
5. The screen shows population, buildings, and the full demand breakdown —
   all in the one load. Nothing extra to click, nothing extra to import.

Manual entry still exists, but only as a **correction**, for the rare case a ward
has no surveyed buildings yet, or the department has newer numbers than the
seeded census. It is never the primary path.

---

## 3. Why it matters to the client

- **Turns a survey tool into a planning tool.** This makes the platform *justify
  budgets* — the same numbers a water department needs to size a treatment
  plant, apply for a grant, or defend a proposal to the municipal council.
- **Zero extra work for whoever's using the dashboard day to day.** They load a
  ward the way they already do for everything else and the water numbers are
  just there — nobody is asked to go find and re-type population data.
- **Starts from numbers the client already trusts.** The seeded baseline is the
  Corporation's *own published* ward census — nothing to dispute about where it
  came from.
- **One number, defensibly broken down.** Every figure ships with a
  plain-language methodology line, the same way the existing Quality and
  Readiness reports already do.
- **Cross-checks itself.** Declared/legacy building counts (if any exist) get
  compared against what's actually been surveyed on the map, catching mismatches
  before a client ever sees them.

---

## 4. Where the seeded baseline comes from

The page you pointed me at — checked live just now:

**Source:** [davanagerecity.mrc.gov.in/en/census_info](http://www.davanagerecity.mrc.gov.in/en/census_info)
— "Census Information," Davanagere City Corporation, Government of Karnataka.
**Last updated (per the site):** Thu 26 Oct 2023.
**Structure:** one row per ward, 45 wards total:

| Ward No. | Ward Name | Males | Females | Persons | Area (sq km) | Population/sq km |
|---|---|---|---|---|---|---|
| 1 | Gandhi Nagar | 6,462 | 6,587 | 13,049 | 0.300 | *(blank on their site)* |
| 2 | S.S.M and Mustafa Nagara | 7,205 | 5,604 | 12,809 | 0.720 | *(blank)* |
| 6 | Kurubara Kere, Shibara & Vijaya Nagara Badavane | 5,620 | 5,370 | 10,990 | 0.820 | *(blank)* |
| 36 | Lenin Nagara | *(blank)* | *(blank)* | 10,299 | 0.460 | *(blank)* |
| 45 | S J M Nagara, Yaragunte, Karuru | 5,227 | 5,207 | 10,434 | 4.670 | *(blank)* |
| ... | (45 wards total) | | | | | |

**This entire table gets seeded into the backend once, at setup** — not
re-fetched live on every ward load. Reasoning: it's a census-cycle publication
(last touched Oct 2023, not a daily feed), so hitting their website on every
single ward load in our app would mean depending on an external site's uptime
and exact page layout for something that barely changes. Seeding it once into
our own database means every ward load afterward is instant and never depends on
their site being up.

Two free wins worth showing the client, found while pulling this:

1. **Every one of the 45 rows has an empty "Population per Sq Km" column on the
   Corporation's own site** — they publish area and population but never divide
   the two. Our platform computes this automatically the instant a ward loads.
   Citywide, summing all 45 wards: **≈434,971 people across ≈88.27 sq km ≈ 4,930
   people/sq km** — not shown anywhere on their own portal.
2. **Ward 36 (Lenin Nagara) is missing its Males/Females split**, even on the
   official site. The platform's existing data-completeness engine (today it
   flags surveyed manholes missing a depth value the same way) flags this ward
   the same way, automatically, instead of silently showing a blank.

**Buildings are not part of this government data at all** — the census only
tracks people. Building counts come entirely from this platform's own survey
data (counted automatically the instant the ward loads, per step 3 in Section 2).

---

## 5. What the client will actually see

Using **Ward 1 — Gandhi Nagar** (real figures from Section 4; likely the same
locality as this project's existing "Ghandinagar Ward" 3D/LIDAR survey data,
given the name match — worth you confirming):

```
┌─────────────────────────────────────────────────────────────────┐
│  WARD WATER-DEMAND REPORT — Ward 1, Gandhi Nagar                 │
│  Loaded automatically · population: seeded census (26-Oct-2023)  │
│  · buildings: counted from surveyed footprints                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│   Males    Females    Persons     Area        Density            │
│   6,462     6,587     13,049    0.300 km²   43,497 /km² (we      │
│                                              compute this; the   │
│                                              source leaves it     │
│                                              blank)               │
│                                                                   │
│   Buildings surveyed on map: [ auto-counted, no entry needed ]   │
│                                                                   │
│   TOTAL ESTIMATED WATER DEMAND:   1.76 MLD  (1,762,000 L/day)    │
│                                                                   │
├─────────────────────────────────────────────────────────────────┤
│  BREAKDOWN                                                       │
│                                                                   │
│   Drinking & cooking            ▓                     65,000 L  │
│   Other household use           ▓▓▓▓▓▓▓▓▓▓▓▓        1,696,000 L │
│   Institutional & commercial    ▓▓▓                   340,000 L  │
│   Distribution losses (UFW)     ▓▓                    255,000 L  │
│  ─────────────────────────────────────────────────────────────  │
│   Fire-fighting provision (shown separately, not in daily total) │
│                                                                   │
├─────────────────────────────────────────────────────────────────┤
│  Methodology: [plain-language explanation, see Sec. 5]           │
│  [ Export PDF ]  [ Export Excel ]  [ Export CSV ]                │
└─────────────────────────────────────────────────────────────────┘
```

This sits as a new panel next to the existing Quality and Readiness panels the
client already uses, and exports through the same Export button they already
know — it just appears the moment the ward is loaded, nothing more to trigger.

---

## 6. How the number is worked out (plain language, no code)

1. **Start with population** — resolved automatically from the seeded ward
   census (Section 4) the instant the ward loads.
2. **Apply a per-person daily water allowance.** India's standard planning
   reference (the CPHEEO Manual on Water Supply, used across Indian municipal
   engineering) ties this to city size — roughly 135 litres/person/day for a
   city Davanagere's size. This is a *planning default*, adjustable, not a
   number locked into the software.
3. **Split that into drinking water vs. everything else.** Only a small slice of
   daily household water is for drinking and cooking — the rest is bathing,
   laundry, cleaning, flushing. Both shown, clearly labeled as an estimate (see
   Section 7, point 1 — this split isn't an official published figure anywhere).
4. **Add institutional and commercial demand** — schools, offices, shops — as a
   percentage on top of household use.
5. **Add distribution losses** — every water system loses some share of what it
   produces to leakage; standard planning practice adds this back so the total
   reflects what actually needs to be *produced*.
6. **Show fire-fighting demand separately** — an emergency provision, reported
   alongside the total rather than folded into it.
7. **Cross-check building counts** — compares any declared/legacy count against
   what's actually surveyed, and flags a mismatch.

Every step is deterministic — same inputs always produce the same report, and
the report states exactly which rule produced which number. Nothing here is
guessed by an AI model.

---

## 7. The open decisions — resolved

### 1. Should "drinking water" be its own line item?
**Yes, but labeled as an estimate.** No manual gives an official drinking-only
figure — CPHEEO gives one combined household number. We show a drinking/cooking
split using a reasonable planning assumption (~5 litres/person/day), stated as
an assumption up front rather than implying a citation that doesn't exist.

### 2. Ward totals vs. per-building numbers?
**Ward totals — confirmed by the Corporation's own census**, which also only
ever reports at ward level. Per-building granularity (a population heat-map on
the 3D map view) stays a good-looking Phase 2 feature, not a v1 requirement.

### 3. Floating/transient population (markets, bus stand, festivals)?
**Add it now as an optional override field**, not later. Cheap to add today;
shipping without it invites the first question a client asks: "what about
market days?"

### 4. Multi-year growth projection?
**Phase 2.** Needs a population growth-rate assumption that's a bigger policy
conversation on its own — a strong next-quarter pitch, not a v1 blocker.

### 5. Residential vs. non-residential building split?
**Single building total for v1** — a known, explainable simplification, flagged
as a v2 refinement.

### 6. Should this feed the AI-written ward narrative report?
**Yes.** One added line — "estimated water demand is Z MLD, driven by a
population of N" — costs little to wire up and makes the number land in a
sentence a non-technical reader will actually read.

---

## 8. Rollout

| Phase | Scope |
|---|---|
| **v1 (now)** | Corporation's 45-ward census seeded into the backend once at setup · automatically resolved the instant any ward is loaded in the webapp (no form, no per-use import) · buildings auto-counted from surveyed footprints · computed density (filled in where the source leaves it blank) · full demand breakdown (drinking/household/institutional/losses/fire) · optional floating-population override · manual correction path for edge cases · export via existing PDF/Excel/CSV · all assumptions editable, not hardcoded |
| **v2** | Per-building granularity + map heat-map, growth projections (5yr/20yr), residential/commercial building split, AI narrative integration, refresh path if the Corporation republishes an updated census |

**Effort:** Small. One seed of data already in the exact shape needed, one
calculation module, one new panel next to the reports that already exist. No
new action for the person using the dashboard — the whole point.

---

## 9. Bottom line

The client loads a ward the way they already do today, and the water-demand
picture is just there — population and buildings resolved automatically in the
backend, nothing to type in. It starts from the Corporation's own published
census, fills in the gaps their own portal leaves blank, adds what their portal
never tracked at all (buildings, water demand), and shows exactly how it got
from those inputs to a figure they can defend in a council or state review.
