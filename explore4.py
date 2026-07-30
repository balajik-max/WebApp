import re

# Check how features get their category in the AI detection
with open('E:/Naksha_Urban_project/backend/app/api/v1/ai.py', 'r') as f:
    content = f.read()

# Look for category/class assignment during detection
# Focus on finding patterns where category is set based on detection mode
patterns = ['this_category', 'feature.category', 'classification', 'DetectionMode', 'DETECTION_MODE']
for pat in patterns:
    print(f'=== Pattern: {pat} ===')
    count = 0
    for m in re.finditer(pat, content):
        if count > 5:
            break
        count += 1
        start = max(0, m.start() - 150)
        end = min(len(content), m.end() + 300)
        snippet = content[start:end].replace('\n', ' ')
        print(snippet[:400])
        print()

print('\n\n=== Looking for category in feature creation ===')
# Search for where Feature objects are created with category
for m in re.finditer(r'Feature\(', content):
    start = max(0, m.start() - 200)
    end = min(len(content), m.end() + 200)
    snippet = content[start:end].replace('\n', ' ')
    if 'category' in snippet.lower():
        print(snippet[:400])
        print()
