#!/usr/bin/env python3
import re

file_path = 'src/index.html'

with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

# Find script tags and extract JS, replacing problematic unicode chars
# Simple approach: extract content and try to parse

scripts = re.findall(r'<script>([\s\S]*?)</script>', content)

# Combine all scripts except the first (empty) one
js_content = ''
for i, script in enumerate(scripts):
    if i > 0:
        js_content += script + '\n'

# Replace problematic unicode chars with safe alternatives
js_content = js_content.replace('�', '?')

# Write to a file that node can check
output_path = '/c/Users/User/AppData/Local/Temp/check_mash.js'
try:
    with open(output_path, 'w', encoding='utf-8', errors='replace') as f:
        f.write(js_content)
    print(f"Wrote JS to {output_path}")
    print(f"Size: {len(js_content)} chars")
except Exception as e:
    print(f"Error writing file: {e}")
    # Try another path
    output_path = 'src/mash_check.js'
    with open(output_path, 'w', encoding='utf-8', errors='replace') as f:
        f.write(js_content)
    print(f"Wrote JS to {output_path}")
    print(f"Size: {len(js_content)} chars")