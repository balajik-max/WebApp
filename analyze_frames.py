import os
import glob
import numpy as np
from PIL import Image

frames_dir = "E:\\Naksha_Urban_project\\temp_frames"
frame_paths = sorted(glob.glob(os.path.join(frames_dir, "frame_*.png")))

print(f"Analyzing {len(frame_paths)} frames...")

# We will sample background color at corners to establish a threshold
bg_samples = []
for p in [frame_paths[0], frame_paths[len(frame_paths)//2], frame_paths[-1]]:
    img = Image.open(p)
    w, h = img.size
    bg_samples.append(np.array(img.getpixel((5, 5))))
    bg_samples.append(np.array(img.getpixel((w - 5, 5))))
    bg_samples.append(np.array(img.getpixel((5, h - 5))))
    bg_samples.append(np.array(img.getpixel((w - 5, h - 5))))

bg_mean = np.mean(bg_samples, axis=0)
print(f"Sampled background mean color: {bg_mean}")

# Analyze some frames for eye position and orientation
# Magenta eyes will have very high Red and Blue, but low Green.
# We look for pixels where R > 150, B > 150, G < 100
for i in [1, 23, 45, 67, 90]:
    p = frame_paths[i]
    img = Image.open(p)
    img_np = np.array(img)
    
    # Bounding box of non-background
    h, w, c = img_np.shape
    dist_from_bg = np.linalg.norm(img_np - bg_mean, axis=2)
    # Mask of subject
    subject_mask = dist_from_bg > 30
    
    y_idx, x_idx = np.where(subject_mask)
    if len(y_idx) > 0:
        ymin, ymax = y_idx.min(), y_idx.max()
        xmin, xmax = x_idx.min(), x_idx.max()
        bbox = (xmin, ymin, xmax, ymax)
    else:
        bbox = None
        
    # Find magenta eye pixels
    r, g, b = img_np[:,:,0], img_np[:,:,1], img_np[:,:,2]
    # Magenta eyes: high R and B, low G
    eye_mask = (r > 160) & (b > 160) & (g < 120)
    ey, ex = np.where(eye_mask)
    
    if len(ex) > 10:
        # Group into left and right eyes by x-coordinate split (around the median X of eye pixels)
        median_x = np.median(ex)
        left_eye_mask = eye_mask & (np.indices(eye_mask.shape)[1] < median_x)
        right_eye_mask = eye_mask & (np.indices(eye_mask.shape)[1] >= median_x)
        
        ley, lex = np.where(left_eye_mask)
        rey, rex = np.where(right_eye_mask)
        
        le_center = (np.mean(lex), np.mean(ley)) if len(lex) > 0 else (0, 0)
        re_center = (np.mean(rex), np.mean(rey)) if len(rex) > 0 else (0, 0)
        
        eye_y_diff = abs(le_center[1] - re_center[1])
        eye_line_angle = np.degrees(np.arctan2(re_center[1] - le_center[1], re_center[0] - le_center[0]))
    else:
        le_center, re_center = (0,0), (0,0)
        eye_y_diff = 0
        eye_line_angle = 0.0
        
    print(f"Frame {i:02d}: BBox={bbox}, LeftEye={le_center}, RightEye={re_center}, YDiff={eye_y_diff:.2f}px, Angle={eye_line_angle:.2f}deg")

print("Done analysis.")
