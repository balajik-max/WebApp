import numpy as np
from PIL import Image

img = Image.open("E:\\Naksha_Urban_project\\temp_frames\\frame_045.png")
arr = np.array(img).astype(float)

# We want to check pixels in a horizontal slice at Y = 600 (middle of the screen)
# Let's print pixel values from X = 0 to 1600 at step 50
print("Y=600 horizontal profile (X, R, G, B):")
for x in range(0, 1600, 50):
    p = arr[600, x]
    print(f"X={x:04d}: R={p[0]:.1f}, G={p[1]:.1f}, B={p[2]:.1f}")
