import os
import numpy as np
from PIL import Image

p = "E:\\Naksha_Urban_project\\processed_frames\\frame_045.png"
img = Image.open(p)
arr = np.array(img)

# Print stats of image
rgb = arr[:, :, :3]
alpha = arr[:, :, 3]

print(f"Alpha channel stats: min={alpha.min()}, max={alpha.max()}, mean={alpha.mean():.2f}")
print(f"Number of transparent pixels (alpha=0): {np.sum(alpha == 0)}")
print(f"Number of fully opaque pixels (alpha=255): {np.sum(alpha == 255)}")
print(f"Number of semi-transparent pixels (0 < alpha < 255): {np.sum((alpha > 0) & (alpha < 255))}")

# Look at a slice of the face plate below the eyes
# The center of the robot is around 256. Center of screen is 256, 256.
# Let's inspect X range [200, 310] at Y = 240, 250, 260
for y in [200, 220, 240, 260, 280]:
    row_alpha = alpha[y, 200:310:10]
    row_rgb = rgb[y, 200:310:10]
    print(f"Y={y}:")
    for idx, x_val in enumerate(range(200, 310, 10)):
        print(f"  X={x_val}: RGB={row_rgb[idx]}, Alpha={row_alpha[idx]}")
