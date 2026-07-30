import re

# Check the AI detection service for category assignments
with open('E:/Naksha_Urban_project/backend/app/services/ai/__init__.py', 'r') as f:
    try:
        content = f.read()
        print(content[:2000])
    except:
        print("File not found")

# Check detection services
import os
services_dir = 'E:/Naksha_Urban_project/backend/app/services'
for root, dirs, files in os.walk(services_dir):
    for f in files:
        if 'detect' in f.lower() or 'ai' in f.lower() or 'pole' in f.lower() or 'drain' in f.lower() or 'manhole' in f.lower() or 'pothole' in f.lower() or 'standing' in f.lower() or 'powerline' in f.lower() or 'road' in f.lower():
            print(os.path.join(root, f))
