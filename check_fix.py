#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find sanitizeQuestionPrompt and check if it has MASHED ADDITION
idx = 0
count = 0
while True:
    idx = content.find('function sanitizeQuestionPrompt', idx)
    if idx == -1:
        break
    count += 1
    # Get 600 chars after function
    snippet = content[idx:idx+600]

    if 'MASHED ADDITION' in snippet:
        print(f"Function {count}: Contains MASHED ADDITION stripping - OK")
    else:
        print(f"Function {count}: Missing MASHED ADDITION stripping - NEEDS FIX")

    idx += 1

print(f"\nTotal: {count} functions")