#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Count lines
lines = content.split('\n')
print(f"Total lines: {len(lines)}")

# Find lines containing "Active Recall Cloze Enhanced"
for i, line in enumerate(lines):
    if 'Active Recall Cloze Enhanced' in line and i > 2300:
        print(f"Line {i+1}: {line[:100]}")

# Check MASHED ADDITION count before
ma_count_before = content.count('MASHED ADDITION')
print(f"\nMASHED ADDITION count before: {ma_count_before}")

# Simple string replacement - add after the Prompt Tag line
# Find all occurrences of the pattern and insert after it
old_pattern = ".replace(/\\[\\s*(?:Note|Instruction|Directive|Prompt Tag):[^\\]]*\\]/gi, '')"
new_addition = """.replace(/---\\s*MASHED ADDITION\\s*---/gi, '\\n\\n')"""

# Count occurrences
occurrences = content.count(old_pattern)
print(f"Found {occurrences} occurrences of Prompt Tag pattern")

# Add MASHED ADDITION stripping after each Prompt Tag line
for i in range(occurrences):
    content = content.replace(old_pattern, old_pattern + '\n' + new_addition, 1)

# Save
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"MASHED ADDITION count after: {content.count('MASHED ADDITION')}")
print("Done")