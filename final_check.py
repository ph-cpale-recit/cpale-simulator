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

# Check for required functions
functions = ['cardSignature', 'cardTokenSimilarity', 'mergeCards', 'cardMashPass']
for func in functions:
    if f'function {func}' in content or f'const {func}' in content:
        print(f"{func}: Found")
    else:
        print(f"{func}: MISSING")

print("\nDone!")