import os
import glob
import numpy as np
from PIL import Image

frames_dir = "E:\\Naksha_Urban_project\\temp_frames"
frame_paths = sorted(glob.glob(os.path.join(frames_dir, "frame_*.png")))

bg_color = np.array([1, 10, 23])
rotate_angle = 14.5

global_min_x = 9999
global_max_x = -9999
global_min_y = 9999
global_max_y = -9999

for idx, path in enumerate(frame_paths):
    img = Image.open(path)
    # Fill rotated padding with background color so it doesn't skew bounds
    rotated = img.rotate(rotate_angle, resample=Image.Resampling.BILINEAR, fillcolor=(1, 10, 23))
    arr = np.array(rotated)
    
    # Calculate color distance to background
    dist = np.linalg.norm(arr[:, :, :3] - bg_color, axis=2)
    
    # Threshold to find subject (including glow)
    mask = dist > 35
    
    y_indices, x_indices = np.where(mask)
    if len(y_indices) > 0:
        min_y, max_y = y_indices.min(), y_indices.max()
        max_y = max_y
        min_x, max_x = x_indices.min(), x_indices.max()
        
        global_min_x = min(global_min_x, min_x)
        global_max_x = max(global_max_x, max_x)
        global_min_y = min(global_min_y, min_y)
        global_max_y = max(global_max_y, max_y)

print(f"Global bounds of rotated subject:")
print(f"X: {global_min_x} to {global_max_x} (width: {global_max_x - global_min_x})")
print(f"Y: {global_min_y} to {global_max_y} (height: {global_max_y - global_min_y})")

center_x = (global_max_x + global_min_x) // 2
center_y = (global_max_y + global_min_y) // 2
print(f"Calculated center: ({center_x}, {center_y})")
