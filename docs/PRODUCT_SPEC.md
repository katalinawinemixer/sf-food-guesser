# Product Spec

## User Promise

SF Food Guesser helps someone upload a gatekept San Francisco food, cafe,
restaurant, storefront, or interior photo and get the most likely venue with
evidence.

The app should not require the user to manually describe visible dish, sign,
street, or decor clues. The system is responsible for inspecting the uploaded
photo, searching for corroborating public evidence, and explaining why each
candidate was ranked.

## Initial Scope

- Geography: San Francisco only.
- Venue types: restaurants, cafes, bakeries, counters, bars, dessert shops, and
  late-night food spots.
- Input: one uploaded image at a time.
- Output: ranked venue candidates with confidence, address/neighborhood when
  known, evidence reasons, source URLs, and a map query.

## Correct Answer Definition

A result counts as correct only when it identifies the exact venue represented
by the uploaded photo.

The answer should include:

- Venue name.
- Address or sufficiently specific San Francisco location.
- Evidence that ties the uploaded photo to that venue.
- Source URLs when web evidence was used.

Neighborhood-only, cuisine-only, or similar-dish answers do not count as
correct.

## Evidence Strength

Strongest evidence:

- Visible venue name, logo, menu text, receipt, packaging, cup, bag, or plate.
- Matching interior/storefront details from public photos or venue pages.
- GPS EXIF metadata close to the venue.
- Multiple independent source URLs supporting the same venue.

Medium evidence:

- Distinctive dish strongly associated with a venue.
- Distinctive decor, wall art, counter, tile, display case, lighting, seating,
  window view, or tableware.
- Neighborhood clues plus venue-specific menu or interior details.

Weak evidence:

- Generic food category only.
- Cuisine only.
- Broad neighborhood vibes without venue-specific support.
- Similar-looking dishes from many possible venues.

## Accuracy Targets

The app should not claim to be accurate until it is measured against a private
labeled photo set.

Minimum target for an early usable version:

- Top-1 accuracy: 60% or better on the labeled set.
- Top-3 accuracy: 80% or better on the labeled set.
- Low-confidence behavior: at least 80% of ambiguous or failed cases should be
  marked as needing more evidence instead of presenting a confident wrong
  answer.

Stronger target before broader sharing:

- Top-1 accuracy: 75% or better.
- Top-3 accuracy: 90% or better.
- False-confident wrong answers below 10%.

## Uncertainty Behavior

When confidence is low, the app should:

- Show several candidates instead of pretending certainty.
- Explain what evidence is missing.
- Ask for no manual clue entry by default.
- Let the user mark the result as incorrect and optionally provide the known
  venue for evaluation.

## Privacy Rule

Uploaded photos should be treated as transient by default. Do not store user
photos unless the user explicitly opts into saving a miss for evaluation.

Private evaluation photos belong under `evaluation/photos/`, which is ignored by
git.
