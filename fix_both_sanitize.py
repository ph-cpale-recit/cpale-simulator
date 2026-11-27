#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Pattern for the first sanitizeQuestionPrompt function
# We need to add the MASHED ADDITION stripping after the Prompt Tag replacement

# Find both occurrences and add MASHED ADDITION stripping
# Replace the pattern: .replace(/\\[\\s*(?:Note|Instruction|Directive|Prompt Tag):[^\\]]*\\]/gi, '')
# Followed by .replace(/\\n\\s*\\n\\s*\\n\\n+/g, '\\n\\n')

old_pattern1 = """.replace(/\\[\\s*(?:Note|Instruction|Directive|Prompt Tag):[^\\]]*\\]/gi, '')
        .replace(/\\n\\s*\\n\\s*\\n\\n+/g, '\\n\\n')
        .trim();"""

new_pattern1 = """.replace(/\\[\\s*(?:Note|Instruction|Directive|Prompt Tag):[^\\]]*\\]/gi, '')
        .replace(/---\\s*MASHED ADDITION\\s*---/gi, '\\n\\n')
        .replace(/\\n\\s*\\n\\s*\\n\\n+/g, '\\n\\n')
        .trim();"""

# Count occurrences
orig_count = content.count(old_pattern1)
print(f"Found {orig_count} occurrences of the pattern to replace")

# Replace them
content = content.replace(old_pattern1, new_pattern1)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Updated sanitizeQuestionPrompt function(s)")

# Verify
new_count = content.count(new_pattern1)
print(f"Now have {new_count} occurrences of the new pattern")
existing_count = content.count("MASHED ADDITION")
print(f"Total MASHED ADDITION occurrences: {existing_count}")