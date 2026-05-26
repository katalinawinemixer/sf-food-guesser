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

The app should not claim certainty unless it has strong venue-specific evidence.

Minimum target for an early usable version:

- Returned candidates should include a venue name or exact location when found.
- The top candidate should show why it is likely, not just a confidence score.
- Ambiguous results should show multiple candidates and say what evidence is
  missing instead of presenting a confident wrong answer.

Stronger target before broader sharing:

- The top result should be backed by at least one strong evidence type whenever
  possible: visible text/logo, matching interior/storefront, packaging, GPS, or
  corroborating source URLs.
- Generic dish-only matches should be marked as weak unless another evidence
  type supports the same venue.

## Uncertainty Behavior

When confidence is low, the app should:

- Show several candidates instead of pretending certainty.
- Explain what evidence is missing.
- Ask for no manual clue entry by default.
- Keep the user flow focused on identification, not data-labeling.

## Privacy Rule

Uploaded photos should be treated as transient by default. Do not store user
photos unless the user explicitly opts into a future saved-history feature.
