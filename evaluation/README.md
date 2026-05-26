# Evaluation Dataset

This folder is for measuring whether SF Food Guesser is actually accurate.

Private photos go in `evaluation/photos/`. That directory is ignored by git.
Commit only the dataset schema/example and aggregate notes that do not reveal
private images.

## Setup

Copy the example file:

```bash
cp evaluation/labeled-photos.example.json evaluation/labeled-photos.json
```

Add cases to `evaluation/labeled-photos.json`:

```json
{
  "cases": [
    {
      "id": "case-001",
      "imagePath": "evaluation/photos/case-001.jpg",
      "photoType": "interior-only",
      "expected": {
        "id": "breadbelly",
        "name": "Breadbelly",
        "address": "1408 Clement St"
      },
      "notes": "Known answer from original poster."
    }
  ]
}
```

Then run:

```bash
npm run evaluate
```

## Metrics

The evaluation script reports:

- Total runnable cases.
- Top-1 accuracy.
- Top-3 accuracy.
- How often the model asked for more evidence.
- Misses with the top candidates returned.

Use misses to improve search, prompts, ranking, and the venue database.
