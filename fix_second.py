#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find line 2370-2371 - these have duplicate MASHED ADDITION entries
# Need to remove line 2371 and also check if second function needs fixing

# Print lines around 2364-2380
lines = content.split('\n')
for i in range(2363, min(2382, len(lines))):
    print(f"{i+1}: {lines[i][:80]}")

# Check the second function (around line 2376)
for i in range(2375, min(2385, len(lines))):
    if 'sanitizeQuestionPrompt' in lines[i]:
        print(f"\n=== Second function starts at line {i+1} ===")
        for j in range(i, min(i+15, len(lines))):
            print(f"{j+1}: {lines[j][:80]}")