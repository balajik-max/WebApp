import re

with open('E:/Naksha_Urban_project/backend/app/services/ai.py', 'r') as f:
    content = f.read()

# Search for this_category or category assignment patterns
for m in re.finditer(r'this_category|\"category\"|\"categor\"', content):
    start = max(0, m.start() - 150)
    end = min(len(content), m.end() + 200)
    snippet = content[start:end].replace('\n', ' ')
    print(snippet[:400])
    print('---')
    print()
