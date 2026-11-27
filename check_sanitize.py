#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find sanitizeQuestionPrompt occurrences
idx = 0
count = 0
while True:
    idx = content.find('function sanitizeQuestionPrompt', idx)
    if idx == -1:
        break
    count += 1
    # Get 500 chars after function
    snippet = content[idx:idx+400]
    print(f"\n=== Function {count} at byte {idx} ===")
    print(snippet)
    print("...")
    idx += 1

print(f"\nTotal: {count} functions")