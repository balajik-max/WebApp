import os
import glob
import numpy as np
from PIL import Image

frames_dir = "E:\\Naksha_Urban_project\\temp_frames"
frame_paths = sorted(glob.glob(os.path.join(frames_dir, "frame_*.png")))

bg_color = np.array([1, 10, 23])
rotate_angle = 14.5

max_bg_dist = 0
for idx in range(0, len(frame_paths), 5):
    img = Image.open(frame_paths[idx])
    rotated = img.rotate(rotate_angle, resample=Image.Resampling.BILINEAR, fillcolor=(1, 10, 23))
    arr = np.array(rotated).astype(float)
    
    # Check guaranteed background regions:
    # 1. Left border: X in [0, 400], Y in [0, 1200]
    # 2. Right border: X in [1200, 1600], Y in [0, 1200]
    # 3. Top border: X in [0, 1600], Y in [0, 100]
    # 4. Bottom border: X in [0, 1600], Y in [0, 1100]
    
    h, w, c = arr.shape
    dist = np.linalg.norm(arr[:, :, :3] - bg_color, axis=2)
    
    # Left border
    max_bg_dist = max(max_bg_dist, dist[:, :400].max())
    # Right border
    max_bg_dist = max(max_bg_dist, dist[:, 1200:].max())
    # Top border
    max_bg_dist = max(max_bg_dist, dist[:100, :].max())
    # Bottom border
    max_bg_dist = max(max_bg_dist, dist[1050:, :].max())

print(f"Maximum background color distance in guaranteed background zones: {max_bg_dist:.2f}")
