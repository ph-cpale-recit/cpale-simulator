#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Remove stray ') lines
# Pattern: line that is just ')', possibly with whitespace
lines = content.split('\n')
new_lines = []
for line in lines:
    stripped = line.strip()
    if stripped == "')":
        continue  # Skip this line
    new_lines.append(line)

content = '\n'.join(new_lines)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Removed stray ') lines")

# Verify
lines = content.split('\n')
ma_count = content.count('MASHED ADDITION')
print(f"MASHED ADDITION occurrences: {ma_count}")