import re

# Check backend analytics.py for all category-related code
with open('E:/Naksha_Urban_project/backend/app/api/v1/analytics.py', 'r') as f:
    content = f.read()

# Find category references
print('=== Category references in analytics.py ===')
for m in re.finditer(r'category', content):
    start = max(0, m.start() - 150)
    end = min(len(content), m.end() + 200)
    snippet = content[start:end].replace('\n', ' ')
    print(snippet[:300])
    print('---')

print('\n\n=== Looking for road_inspection or Road_Inspection ===')
with open('E:/Naksha_Urban_project/backend/app/services/road_inspection.py', 'r') as f:
    content2 = f.read()
for m in re.finditer(r'category|categor', content2):
    start = max(0, m.start() - 100)
    end = min(len(content2), m.end() + 200)
    snippet = content2[start:end].replace('\n', ' ')
    print(snippet[:300])
    print('---')
