import os
import glob
import numpy as np
from PIL import Image
from scipy.ndimage import binary_fill_holes, distance_transform_edt, binary_dilation

frames_dir = "E:\\Naksha_Urban_project\\temp_frames"
out_dir = "E:\\Naksha_Urban_project\\processed_frames"
os.makedirs(out_dir, exist_ok=True)

frame_paths = sorted(glob.glob(os.path.join(frames_dir, "frame_*.png")))
print(f"Loaded {len(frame_paths)} frames for processing.")

# Background model
bg_color = np.array([1.0, 10.0, 23.0]) # R=1, G=10, B=23

# Crop parameters centered at the robot (X=821, Y=577) with size 960x960
crop_center_x = 821
crop_center_y = 577
crop_size = 960

# Rotation parameters to level the eyes and keep body vertical
rotate_angle = 14.5 # counter-clockwise 

for idx, path in enumerate(frame_paths):
    img = Image.open(path)
    
    # 1. Rotate counter-clockwise to level the eyes, filling the rotated padding with background color
    rotated = img.rotate(rotate_angle, resample=Image.Resampling.BILINEAR, fillcolor=(1, 10, 23))
    
    # 2. Crop centered around the robot
    left = crop_center_x - crop_size // 2
    top = crop_center_y - crop_size // 2
    right = crop_center_x + crop_size // 2
    bottom = crop_center_y + crop_size // 2
    cropped = rotated.crop((left, top, right, bottom))
    
    # 3. Mirror horizontally (hflip)
    mirrored = cropped.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    
    # 4. Downscale to 512x512
    scaled = mirrored.resize((512, 512), resample=Image.Resampling.LANCZOS)
    scaled_np = np.array(scaled).astype(float)
    
    # Extract RGB
    rgb = scaled_np[:, :, :3]
    
    # Color distance from background
    col_dist = np.linalg.norm(rgb - bg_color, axis=2)
    
    # Binary subject mask - using 12.0 threshold since max noise floor is 8.66
    # This captures all metallic edges and faces correctly
    subject_mask = col_dist > 12.0
    
    # Use binary fill holes to completely protect the black face screen and shadows
    protected_mask = binary_fill_holes(subject_mask)
    
    # Distance transform from the protected subject mask
    dist_to_subject = distance_transform_edt(1 - protected_mask)
    
    # Soft keying threshold for color
    bg_thresh_low = 10.0
    bg_thresh_high = 25.0
    
    alpha_color = (col_dist - bg_thresh_low) / (bg_thresh_high - bg_thresh_low) * 255.0
    alpha_color = np.clip(alpha_color, 0.0, 255.0)
    
    # Distance-based alpha cleanup:
    # Full glow within 4px of subject, then decay to 0 at 14px (very tight, natural glow)
    # This removes outer background patches completely
    glow_inner = 4.0
    glow_outer = 14.0
    
    dist_falloff = 1.0 - (dist_to_subject - glow_inner) / (glow_outer - glow_inner)
    dist_falloff = np.clip(dist_falloff, 0.0, 1.0)
    
    # Final alpha
    alpha = alpha_color * dist_falloff
    
    # Unpremultiply and clean background spill
    alpha_norm = alpha / 255.0
    alpha_norm_expanded = alpha_norm[:, :, None]
    
    # Remove color spill by subtracting background contribution
    rgb_clean = (rgb - (1.0 - alpha_norm_expanded) * bg_color)
    # Re-normalize/unpremultiply with a safe divisor to avoid clipping edge glows
    rgb_clean = rgb_clean / np.maximum(alpha_norm_expanded, 0.1)
    rgb_clean = np.clip(rgb_clean, 0.0, 255.0)
    
    # Merge back to RGBA PIL Image
    rgba = np.zeros((512, 512, 4), dtype=np.uint8)
    rgba[:, :, :3] = rgb_clean.astype(np.uint8)
    rgba[:, :, 3] = alpha.astype(np.uint8)
    
    out_img = Image.fromarray(rgba, "RGBA")
    out_name = f"frame_{idx:03d}.png"
    out_img.save(os.path.join(out_dir, out_name))
    
    if idx % 10 == 0:
        print(f"Processed frame {idx:02d}/{len(frame_paths)}")

print("Done processing all frames successfully.")
