#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Print lines 2364-2395 (0-indexed: 2363-2394)
for i in range(2363, min(2395, len(lines))):
    num = i + 1
    line = lines[i]
    print(f"{num}: {line.rstrip()}")