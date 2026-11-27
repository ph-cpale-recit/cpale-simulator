#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Count lines with MASHED ADDITION
lines_with_ma = 0
for line in content.split('\n'):
    if 'MASHED ADDITION' in line:
        lines_with_ma += 1

print(f"Lines with MASHED ADDITION: {lines_with_ma}")

# Find each sanitizeQuestionPrompt and check
first_idx = content.find('function sanitizeQuestionPrompt')
second_idx = content.find('function sanitizeQuestionPrompt', first_idx + 1)

if second_idx != -1:
    second_func_end = content.find('function checkConcordanceNote', second_idx)
    if second_func_end == -1:
        second_func_end = content.find('}', second_idx + 300)
    second_func = content[second_idx:second_func_end]

    if 'MASHED ADDITION' in second_func:
        print("Second function: Now has MASHED ADDITION stripping")
    else:
        print("Second function: Still missing MASHED ADDITION stripping")