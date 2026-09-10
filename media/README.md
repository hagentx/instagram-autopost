# 📸 media/ — drop your collection photos here

This is the only folder you touch. Add photos, the machine does the rest.

Every new photo is analyzed by Gemini for the caption, while the published image remains a clean, untouched copy of the original photo. No text, drawing, or overlay is burned onto the image.

The system remembers scheduled/published filenames in `../content/queue.json`, so a photo is normally used only once.

## Photo rules

- JPEG or PNG (`.jpg` / `.jpeg` / `.png`).
- Keep files under ~4.5 MB.
- The original image is preserved for publication.

## Order

Photos are scheduled according to the configured posting cadence.
