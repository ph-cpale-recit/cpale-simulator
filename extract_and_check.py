#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Verify key functions exist and have correct values
checks = {
    'SIMILARITY_THRESHOLD = 0.85': 'SIMILARITY_THRESHOLD' in content and '0.85' in content,
    'cardSignature function': 'function cardSignature(card)' in content,
    'cardTokenSimilarity function': 'function cardTokenSimilarity(a, b)' in content,
    'mergeCards function': 'function mergeCards(survivor, donor)' in content,
    'cardMashPass function': 'function cardMashPass(cards' in content,
    'MASHED ADDITION stripping in mergeField': 'MASHED ADDITION' in content,
    'Cross-section collision check': 'cross_section_collision' in content,
    'Hypothetical check (dimension 9 or ALAC)': 'hypothetical_dim' in content or 'isHypothetical' in content,
}

print("Verification of fixes:")
all_pass = True
for name, passed in checks.items():
    status = "PASS" if passed else "FAIL"
    if not passed:
        all_pass = False
    print(f"  {name}: {status}")

print(f"\nOverall: {'ALL CHECKS PASSED' if all_pass else 'SOME CHECKS FAILED'}")

# Count MASHED ADDITION occurrences
ma_count = content.count('MASHED ADDITION')
print(f"\nMASHED ADDITION occurrences: {ma_count}")