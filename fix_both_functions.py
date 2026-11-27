#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Fix line 2370 - add correct indentation
# Line 2370 (index 2369): has no indentation, needs 8 spaces
if not lines[2369].startswith('        '):
    lines[2369] = '        .replace(/---\\s*MASHED ADDITION\\s*---/gi, \'\\n\\n\')\n'
    print("Fixed line 2370 indentation")
else:
    print("Line 2370 already has correct indentation")

# Remove duplicate line 2371
if lines[2370].strip() == lines[2369].strip():
    del lines[2370]
    print("Removed duplicate line 2371")

# Now fix the second function - insert MASHED ADDITION stripping after Prompt Tag line
# After deletion, line 2370 now points to .replace(/\n\s*\n\s*\n+/g, '\n\n')
# We need to insert before that

# Find the new line index for the second function's Prompt Tag line
# Second function starts at line 2376 (index 2375)
# After removing one duplicate, line numbers shift

# Rebuild by finding the second function
content = ''.join(lines)

# Find the second occurrence of the pattern that needs fixing
# Pattern: .replace(/\[\s*(?:Note|Instruction|Directive|Prompt Tag):[^\]]*\]/gi, '')
# Followed by .replace(/\n\s*\n\s*\n+/g, '\n\n')

# Insert MASHED ADDITION stripping after Prompt Tag in second function
old_second = """.replace(/\\[\\s*(?:Note|Instruction|Directive|Prompt Tag):[^\\]]*\\]/gi, '')
        .replace(/\\n\\s*\\n\\s*\\n\\n+/g, '\\n\\n')
        .trim();"""

new_second = """.replace(/\\[\\s*(?:Note|Instruction|Directive|Prompt Tag):[^\\]]*\\]/gi, '')
        .replace(/---\\s*MASHED ADDITION\\s*---/gi, '\\n\\n')
        .replace(/\\n\\s*\\n\\s*\\n\\n+/g, '\\n\\n')
        .trim();"""

count = content.count(new_second)
print(f"Already have {count} correct patterns")

if count < 2:
    # Add the missing one
    content = content.replace(old_second, new_second, 1)  # Replace only first occurrence
    print("Added MASHED ADDITION to second function")

# Save
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Done fixing sanitizeQuestionPrompt functions")