#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find line number of second sanitizeQuestionPrompt
second_func_line = -1
for i, line in enumerate(lines):
    if 'function sanitizeQuestionPrompt' in line:
        if second_func_line == -1:
            first_func_line = i
        else:
            second_func_line = i
            break

print(f"First function at line {first_func_line + 1}")
print(f"Second function at line {second_func_line + 1}")

if second_func_line != -1:
    # Find the Prompt Tag line in second function
    # It should be around second_func_line + 8-10
    for i in range(second_func_line, min(second_func_line + 20, len(lines))):
        line = lines[i]
        if 'Prompt Tag' in line:
            print(f"Found Prompt Tag line at {i+1}")
            print(f"Current: {line.strip()}")

            # Insert MASHED ADDITION stripping after this line
            mashed_line = "        .replace(/---\\s*MASHED ADDITION\\s*---/gi, '\\n\\n')\n"
            lines.insert(i + 1, mashed_line)
            print(f"Inserted MASHED ADDITION stripping after line {i+1}")
            break

    with open(file_path, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    print("File updated")