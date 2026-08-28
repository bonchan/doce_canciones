import os
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

# Register HEIF/HEIC support with Pillow
register_heif_opener()

def invert_images_in_folder(input_folder, output_folder):
    # Added .heic and .heif to supported extensions
    valid_extensions = ('.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp', '.heic', '.heif')
    
    if not os.path.exists(output_folder):
        os.makedirs(output_folder)

    for filename in os.listdir(input_folder):
        if filename.lower().endswith(valid_extensions):
            input_path = os.path.join(input_folder, filename)
            
            # Change output extension to .png or .jpg when saving HEIC files
            base_name, ext = os.path.splitext(filename)
            out_ext = '.jpg' if ext.lower() in ('.heic', '.heif') else ext
            output_path = os.path.join(output_folder, f"inverted_{base_name}{out_ext}")

            try:
                with Image.open(input_path) as img:
                    if img.mode in ('RGBA', 'LA'):
                        r, g, b, alpha = img.convert('RGBA').split()
                        rgb_img = Image.merge('RGB', (r, g, b))
                        inverted_rgb = ImageOps.invert(rgb_img)
                        r_inv, g_inv, b_inv = inverted_rgb.split()
                        inverted_img = Image.merge('RGBA', (r_inv, g_inv, b_inv, alpha))
                    else:
                        rgb_img = img.convert('RGB')
                        inverted_img = ImageOps.invert(rgb_img)

                    inverted_img.save(output_path)
                    print(f"Processed: {filename} -> {os.path.basename(output_path)}")

            except Exception as e:
                print(f"Error processing {filename}: {e}")

# Usage
input_dir = "."
output_dir = "./output_images"

invert_images_in_folder(input_dir, output_dir)