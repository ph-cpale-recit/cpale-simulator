#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

lines = content.split('\n')

# Print lines 2364-2390 to see current state
print("Current state of lines 2364-2390:")
for i in range(2363, min(2390, len(lines))):
    line = lines[i]
    print(f"{i+1}: |{line}|")