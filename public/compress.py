from PIL import ImageSequence
from PIL import Image

# Path to the uploaded GIF file
gif_path = "demo.gif"

# Open the GIF file to extract information
img = Image.open(gif_path)
# Define the target size in bytes (10 MB)
target_size = 10 * 1024 * 1024

# Open the GIF and extract frames
frames = [frame.copy() for frame in ImageSequence.Iterator(img)]

# Compress by resizing and reducing colors
def compress_gif(frames, scale_factor=0.8, colors=128):
    # Resize each frame and reduce the number of colors
    compressed_frames = []
    for frame in frames:
        # Resize frame
        new_size = (int(frame.width * scale_factor), int(frame.height * scale_factor))
        frame = frame.resize(new_size, Image.ANTIALIAS)
        
        # Reduce colors
        frame = frame.convert("P", palette=Image.ADAPTIVE, colors=colors)
        compressed_frames.append(frame)
    return compressed_frames

# Compress the frames
compressed_frames = compress_gif(frames)

# Save the compressed GIF
compressed_gif_path = "compressed_demo.gif"
compressed_frames[0].save(
    compressed_gif_path,
    save_all=True,
    append_images=compressed_frames[1:],
    loop=0,
    duration=img.info['duration'],
    optimize=True,
    quality=85
)

# Check the compressed file size
compressed_size = os.path.getsize(compressed_gif_path) / (1024 * 1024)  # Convert bytes to MB
print(compressed_size)
