#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Print lines 2375-2400 to see both sanitizeQuestionPrompt functions
for i in range(2374, min(2400, len(lines))):
    print(f"{i+1}: {lines[i].rstrip()}")