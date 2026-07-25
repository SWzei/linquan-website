# Photo Structure

Use this folder for all website images that should be served directly by URL.

## Folder layout

```text
public/photos/
├── hero/               # Homepage hero image
├── brand/              # Site identity used by the header and browser icon
├── club/               # Club daily photos (practice, rehearsal, group photos)
├── events/             # Activity photos
└── concerts/           # Concert-related photos
```

## Recommended file names

These files are bundled with the application and used by the public shell:

- `brand/linquan-logo.jpg` — browser icon and top-left identity.
- `hero/home-hero.jpg` — responsive homepage hero.

Gallery media is not stored in this public source folder. Administrators upload and
archive gallery items through the protected Gallery API, which applies the
application's validation and public/private storage rules.

## Image recommendations

- Prefer JPEG or WebP for photographic content.
- Keep the hero close to 1600 × 900 and under 500 KB.
- Keep the square brand image at 320 × 320 or smaller.
- Preserve meaningful alternative text for content images. Decorative logo
  instances should have an empty `alt` when the surrounding link is already
  labelled.
