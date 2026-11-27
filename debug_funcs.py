#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Count occurrences
count = content.count('function sanitizeQuestionPrompt')
print(f"Total occurrences: {count}")

# Find all positions
idx = 0
positions = []
while True:
    idx = content.find('function sanitizeQuestionPrompt', idx)
    if idx == -1:
        break
    positions.append(idx)
    idx += 1

print(f"Positions: {positions}")

# Check content around each position
for i, pos in enumerate(positions):
    snippet = content[pos:pos+200]
    has_ma = 'MASHED ADDITION' in snippet
    print(f"Function {i+1} at byte {pos}: MASHED_ADDITION={has_ma}")