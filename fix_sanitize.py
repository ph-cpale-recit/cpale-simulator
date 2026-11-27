#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find and replace in sanitizeQuestionPrompt - add MASHED ADDITION stripping
# Replace the pattern that ends with .trim()
old = """.replace(/\\n\\s*\\n\\s*\\n\\n+/g, '\\n\\n')
        .trim();"""

new = """.replace(/---\\s*MASHED ADDITION\\s*---/gi, '\\n\\n')
        .replace(/\\n\\s*\\n\\s*\\n\\n+/g, '\\n\\n')
        .trim();"""

content = content.replace(old, new)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Updated sanitizeQuestionPrompt function(s)")