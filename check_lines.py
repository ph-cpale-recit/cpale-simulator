#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Print lines 2364-2400 to see both functions
for i in range(2363, min(2400, len(lines))):
    line = lines[i]
    print(f"{i+1}: {line.rstrip()}")