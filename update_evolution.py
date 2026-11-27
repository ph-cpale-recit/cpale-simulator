#!/usr/bin/env python3
from datetime import datetime

file_path = 'EVOLUTION.md'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find where to insert the new entry (after [Unreleased] section)
today = datetime.now().strftime('%Y-%m-%d')

new_entry = f"""## {today} — Card Mashing Engine Overhaul

### Bug Fixes & Safety Controls

* **(mashing)** Fixed cross-section & cross-hypothetical collision bugs in `cardSignature`, `cardTokenSimilarity`, `mergeCards`, and `cardMashPass`. Cards with different section/article numbers now correctly remain separate during deduplication.
* **(mashing)** Raised `SIMILARITY_THRESHOLD` from 0.72 to 0.85 for general cards to prevent over-aggressive merging of distinct legal provisions.
* **(mashing)** Added 0.88 similarity threshold requirement for hypothetical/problem cards (`dimensionId === 9`, `schemaType === 'ALAC'`, or prompts starting with "During the trial", "A filed", "Suppose", or "X and Y").
* **(mashing)** Prevented `--- MASHED ADDITION ---` from being appended to `question_text` / `question` fields. Cleaned up existing markers in `mergeField` and `sanitizeCardText`.
* **(mashing)** Strip `--- MASHED ADDITION ---` markers during `sanitizeQuestionPrompt` to ensure clean exports.

### Code Changes

* Added `extractSectionNumber()` helper to parse "Section #\d+", "Sec. #\d+", "Article #\d+", "Art. #\d+" patterns from topic/citation/prompt text.
* Added `extractRuleReference()` helper for rule number extraction.
* Implemented `cardSignature(card)` with section-aware signature generation to prevent cross-section collisions.
* Implemented `cardTokenSimilarity(a, b)` for token-based similarity calculation with Jaccard-like metric.
* Implemented `mergeField(a, b)` with MASHED ADDITION marker stripping and smart content merging.
* Implemented `mergeCards(survivor, donor)` for non-destructive card merging with metadata preservation.
* Implemented `cardMashPass(cards, threshold)` as the main deduplication engine with cross-section/hypothetical detection.
* Added `sanitizeCardText(card)` function to strip MASHED ADDITION markers from cards.

"""

# Insert after ## [Unreleased]
if '## [Unreleased]' in content:
    content = content.replace('## [Unreleased]', new_entry + '## [Unreleased]', 1)
else:
    # Insert before the first ## line
    content = new_entry + content

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Updated EVOLUTION.md")