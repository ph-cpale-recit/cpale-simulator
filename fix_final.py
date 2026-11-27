#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

lines = content.split('\n')

# Fix 1: Line 2370 has wrong indentation - should be 8 spaces like other .replace lines
# Current: ".replace(/---\\s*MASHED ADDITION\\s*---/gi, '\\n\\n')"
# Should be: "        .replace(/---\\s*MASHED ADDITION\\s*---/gi, '\\n\\n')"

# Fix 2: The second function (line 2376 area) needs MASHED ADDITION stripping

# Let me print the raw content around line 2364-2384
for i in range(2363, min(2384, len(lines))):
    line = lines[i]
    print(f"{i+1}: |{line}|")