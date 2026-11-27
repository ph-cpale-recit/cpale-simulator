#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Print lines 2375-2390 (the second function)
for i in range(2374, min(2390, len(lines))):
    num = i + 1
    line = lines[i]
    print(f"{num}: |{line.rstrip()}|")