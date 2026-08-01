import re

# Explore datasets.py for category references
with open('E:/Naksha_Urban_project/backend/app/api/v1/datasets.py', 'r') as f:
    content = f.read()
count = 0
for m in re.finditer(r'category', content):
    if count > 5:
        break
    count += 1
    start = max(0, m.start() - 100)
    end = min(len(content), m.end() + 200)
    snippet = content[start:end].replace('\n', ' ')
    print(f'--- MATCH {count} ---')
    print(snippet[:300])
    print()

# Explore analytics.py for features endpoint
print('=== ANALYTICS FEATURES ENDPOINT ===')
with open('E:/Naksha_Urban_project/backend/app/api/v1/analytics.py', 'r') as f:
    content = f.read()
idx = content.find('"/features"')
if idx >= 0:
    print(content[idx:idx+800])
else:
    print('Not found, trying /features')
    idx = content.find('/features')
    if idx >= 0:
        print(content[idx:idx+800])

# Find feature_conditions call
print('=== FEATURE CONDITIONS ===')
idx = content.find('feature_conditions(')
if idx >= 0:
    print(content[idx:idx+600])
