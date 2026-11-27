
import re

file_path = 'src/index.html'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

def check_braces(func_name, content):
    pattern = rf'function {func_name}\(.*?\)\s*\{{'
    match = re.search(pattern, content, re.DOTALL)
    if not match:
        return False, "Function definition not found"

    start = match.start()
    depth = 0
    in_func = False
    for i in range(start, len(content)):
        if content[i] == '{':
            depth += 1
            in_func = True
        elif content[i] == '}':
            depth -= 1

        if in_func and depth == 0:
            return True, "Braces balanced"
    return False, "Unbalanced braces"

funcs = ['cardSignature', 'cardTokenSimilarity', 'mergeCards', 'cardMashPass']
for f in funcs:
    balanced, msg = check_braces(f, content)
    print(f"{f}: {balanced} - {msg}")
