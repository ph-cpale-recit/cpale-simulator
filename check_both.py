#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find each sanitizeQuestionPrompt and check if it has MASHED ADDITION
pos = 0
funcs_found = 0
funcs_with_ma = 0

while True:
    idx = content.find('function sanitizeQuestionPrompt', pos)
    if idx == -1:
        break

    funcs_found += 1
    # Get content until next function or closing brace depth
    func_content = content[idx:idx+400]

    if 'MASHED ADDITION' in func_content:
        funcs_with_ma += 1
        print(f"Function {funcs_found}: Has MASHED ADDITION stripping")
    else:
        print(f"Function {funcs_found}: Missing MASHED ADDITION stripping")

    pos = idx + 1

print(f"\nTotal: {funcs_found} functions, {funcs_with_ma} with MASHED ADDITION")

# Write result to file
with open('verify_result.txt', 'w') as f:
    f.write(f"Functions: {funcs_found}, With MASHED: {funcs_with_ma}\n")