#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find the second sanitizeQuestionPrompt function
# It's the one that doesn't have MASHED ADDITION

# Find positions of both functions
first_idx = content.find('function sanitizeQuestionPrompt')
second_idx = content.find('function sanitizeQuestionPrompt', first_idx + 1)

if second_idx != -1:
    print(f"First function at: {first_idx}")
    print(f"Second function at: {second_idx}")

    # Extract second function content
    second_func_end = content.find('function checkConcordanceNote', second_idx)
    if second_func_end == -1:
        second_func_end = content.find('}', second_idx + 300)

    second_func = content[second_idx:second_func_end]

    # Check if it needs MASHED ADDITION
    if 'MASHED ADDITION' not in second_func:
        print("Second function needs MASHED ADDITION stripping")

        # Find the Prompt Tag line and insert after it
        # Pattern: .replace(/\[\s*(?:Note|Instruction|Directive|Prompt Tag):[^\]]*\]/gi, '')
        # Followed by .replace(/\n\s*\n\s*\n+/g, '\n\n')

        old_pattern = """.replace(/\\[\\s*(?:Note|Instruction|Directive|Prompt Tag):[^\\]]*\\]/gi, '')
        .replace(/\\n\\s*\\n\\s*\\n\\n+/g, '\\n\\n')
        .trim();"""

        new_pattern = """.replace(/\\[\\s*(?:Note|Instruction|Directive|Prompt Tag):[^\\]]*\\]/gi, '')
        .replace(/---\\s*MASHED ADDITION\\s*---/gi, '\\n\\n')
        .replace(/\\n\\s*\\n\\s*\\n\\n+/g, '\\n\\n')
        .trim();"""

        # Check if old pattern exists in second function
        if old_pattern in second_func:
            print("Found old pattern in second function, replacing...")
            content = content[:second_idx] + content[second_idx:].replace(old_pattern, new_pattern, 1)
        else:
            print("Old pattern not found, checking actual content:")
            # Find the lines
            for line in second_func.split('\n'):
                if 'Prompt Tag' in line:
                    print(f"  Found: {line[:80]}")

        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print("File updated")
    else:
        print("Second function already has MASHED ADDITION stripping")