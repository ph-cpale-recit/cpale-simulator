#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Count sanitizeQuestionPrompt occurrences
count = content.count('function sanitizeQuestionPrompt')
print(f"Total sanitizeQuestionPrompt functions: {count}")

# Count MASHED ADDITION occurrences
ma_count = content.count('MASHED ADDITION')
print(f"Total MASHED ADDITION occurrences: {ma_count}")

# Check SIMILARITY_THRESHOLD
threshold_match = re.search(r'const SIMILARITY_THRESHOLD\s*=\s*([\d.]+)', content)
if threshold_match:
    print(f"SIMILARITY_THRESHOLD = {threshold_match.group(1)}")

# Check for cardSignature function
if 'function cardSignature(card)' in content:
    print("cardSignature function found")

# Check for cardTokenSimilarity function
if 'function cardTokenSimilarity(a, b)' in content:
    print("cardTokenSimilarity function found")

# Check for mergeCards function
if 'function mergeCards(survivor, donor)' in content:
    print("mergeCards function found")

# Check for cardMashPass function
if 'function cardMashPass(cards' in content:
    print("cardMashPass function found")

print("\nDone!")