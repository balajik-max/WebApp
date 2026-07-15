import os
import glob
import numpy as np
from PIL import Image

processed_dir = "E:\\Naksha_Urban_project\\processed_frames"
frame_paths = sorted(glob.glob(os.path.join(processed_dir, "frame_*.png")))

print(f"Verifying {len(frame_paths)} processed frames transparency...")

border_alphas = []
for idx in [0, 22, 45, 67, 90]:
    p = frame_paths[idx]
    img = Image.open(p)
    arr = np.array(img)
    alpha = arr[:, :, 3]
    
    # Check corners alpha
    tl = alpha[0, 0]
    tr = alpha[0, 511]
    bl = alpha[511, 0]
    br = alpha[511, 511]
    
    # Outer border region alpha sum
    # 10 pixels margin from all edges
    border_mask = np.ones((512, 512), dtype=bool)
    border_mask[12:-12, 12:-12] = False
    max_border_alpha = alpha[border_mask].max()
    mean_border_alpha = alpha[border_mask].mean()
    
    # Bounding box of non-transparent pixels
    nonzero_y, nonzero_x = np.where(alpha > 0)
    if len(nonzero_y) > 0:
        ymin, ymax = nonzero_y.min(), nonzero_y.max()
        xmin, xmax = nonzero_x.min(), nonzero_x.max()
        bbox = (xmin, ymin, xmax, ymax)
        width_px = xmax - xmin
        height_px = ymax - ymin
    else:
        bbox = None
        width_px, height_px = 0, 0
        
    print(f"Frame {idx:02d}: Corners={tl, tr, bl, br}, MaxBorderAlpha={max_border_alpha}, BBox={bbox} (size {width_px}x{height_px})")

print("Verification complete.")
