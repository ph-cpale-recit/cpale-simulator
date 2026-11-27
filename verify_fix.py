#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Check if MASHED ADDITION stripping is in sanitizeQuestionPrompt
sanitizers = re.findall(r'function sanitizeQuestionPrompt\(text\) \{[^}]+\}', content, re.MULTILINE)

print(f"Found {len(sanitizers)} sanitizeQuestionPrompt function(s)")

for i, fn in enumerate(sanitizers):
    if 'MASHED ADDITION' in fn:
        print(f"Function {i+1}: Contains MASHED ADDITION stripping - OK")
    else:
        print(f"Function {i+1}: Missing MASHED ADDITION stripping - NEEDS FIX")
        print(f"Content preview: {fn[:200]}...")

# Check SIMILARITY_THRESHOLD value
threshold_match = re.search(r'const SIMILARITY_THRESHOLD\s*=\s*([\d.]+)', content)
if threshold_match:
    print(f"\nSIMILARITY_THRESHOLD = {threshold_match.group(1)}")
    if threshold_match.group(1) == '0.85':
        print("Threshold correctly set to 0.85 - OK")
    else:
        print("Threshold NOT 0.85 - NEEDS FIX")

print("\nDone!")