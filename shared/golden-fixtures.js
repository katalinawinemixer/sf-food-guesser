export const goldenAnalysisFixtures = [
  {
    id: 'placeholder-and-no-source',
    label: 'Placeholder and no-source candidates',
    analysis: {
      summary: 'Matcha latte in a small cafe with brown retail bags and an open service counter.',
      imageEvidence: ['iced matcha latte', 'brown retail bags', 'open service counter'],
      candidates: [
        {
          name: 'Other Inner Richmond Cafe',
          confidence: 92,
          evidenceCategories: ['interior_match', 'dish_match'],
          reasons: ['Looks like an Inner Richmond cafe.'],
        },
        {
          name: 'Kissaten HiFi',
          confidence: 86,
          evidenceCategories: ['web_source_match', 'interior_match'],
          reasons: ['A source-backed cafe candidate with similar matcha and interior clues.'],
          sourceUrls: ['https://example.com/kissaten-hifi-review'],
        },
        {
          name: 'Invented Matcha Bar',
          confidence: 78,
          evidenceCategories: ['dish_match'],
          reasons: ['The image has an iced matcha.'],
        },
      ],
    },
    expectedShown: ['Kissaten HiFi'],
    expectedFiltered: 2,
  },
  {
    id: 'visible-text-identity',
    label: 'Visible text identity clue',
    analysis: {
      summary: 'Tray liner and packaging text visibly read Souvla.',
      imageEvidence: ['readable Souvla text', 'Greek food tray', 'blue-rim plates'],
      candidates: [
        {
          id: 'souvla',
          name: 'Souvla',
          confidence: 74,
          evidenceCategories: ['visible_text', 'packaging_logo'],
          reasons: ['Readable packaging text says Souvla.'],
        },
      ],
    },
    options: {
      seedVenueIds: ['souvla'],
      ocrVisibleText: ['Souvla'],
    },
    expectedShown: ['Souvla'],
    expectedFiltered: 0,
  },
  {
    id: 'source-backed-new-cafe',
    label: 'Source-backed new cafe',
    analysis: {
      summary: 'New cafe candidate backed by a public article source.',
      imageEvidence: ['wood counter', 'new cafe interior'],
      candidates: [
        {
          name: 'Hidden Blue Cup Cafe',
          confidence: 76,
          evidenceCategories: ['web_source_match', 'interior_match'],
          externalEvidence: ['A public article describes the new cafe interior.'],
          reasons: ['The public article and uploaded photo share interior details.'],
          sourceUrls: ['https://example.com/new-sf-cafes-hidden-blue-cup'],
        },
      ],
    },
    expectedShown: ['Hidden Blue Cup Cafe'],
    expectedFiltered: 0,
  },
  {
    id: 'dish-only-without-source',
    label: 'Dish-only candidate without source',
    analysis: {
      summary: 'Burger and fries, with no readable venue identity.',
      imageEvidence: ['burger', 'fries', 'counter seating'],
      candidates: [
        {
          name: 'Burger Lead',
          confidence: 84,
          evidenceCategories: ['dish_match'],
          reasons: ['The uploaded image shows a burger.'],
        },
      ],
    },
    expectedShown: [],
    expectedFiltered: 1,
  },
]
