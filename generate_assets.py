"""
Generate PWA icons (192x192 and 512x512) and a deployment QR code.

Requirements:
    pip install Pillow qrcode[pil]

Usage:
    python generate_assets.py --url https://yourusername.github.io/crop-disease-edge-ai/
"""

import argparse
from pathlib import Path

# ── PWA Icon Generation ──────────────────────────────────────
def generate_icons():
    """Create simple PNG icons for the PWA manifest."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("⚠  Pillow not installed. Run: pip install Pillow")
        print("   Skipping icon generation.")
        return

    for size in (192, 512):
        img = Image.new("RGBA", (size, size), (18, 18, 18, 255))
        draw = ImageDraw.Draw(img)

        # Draw a simple leaf shape
        cx, cy = size // 2, size // 2 - size // 10
        r = size // 3
        draw.ellipse(
            [cx - r, cy - r // 2, cx + r, cy + r // 2],
            fill=(76, 175, 80, 255),
        )

        # Label
        try:
            font = ImageFont.truetype("arial.ttf", size // 8)
        except (OSError, IOError):
            font = ImageFont.load_default()

        text = "CropAI"
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        draw.text(
            ((size - tw) // 2, cy + r // 2 + size // 12),
            text,
            fill=(224, 224, 224, 255),
            font=font,
        )

        path = Path(__file__).parent / f"icon-{size}.png"
        img.save(path)
        print(f"✅ Created {path.name} ({size}×{size})")


# ── QR Code Generation ───────────────────────────────────────
def generate_qr(url: str):
    """Generate a QR code PNG for the deployment URL."""
    try:
        import qrcode
    except ImportError:
        print("⚠  qrcode not installed. Run: pip install qrcode[pil]")
        print("   Skipping QR code generation.")
        return

    img = qrcode.make(url)
    path = Path(__file__).parent / "offline_crop_ai_qr.png"
    img.save(path)
    print(f"✅ QR code saved to {path.name}")
    print(f"   URL encoded: {url}")


# ── CLI ───────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate PWA assets")
    parser.add_argument(
        "--url",
        default="https://yourusername.github.io/crop-disease-edge-ai/",
        help="Deployment URL for QR code",
    )
    args = parser.parse_args()

    print("── Generating PWA Icons ──")
    generate_icons()
    print()
    print("── Generating QR Code ──")
    generate_qr(args.url)
    print()
    print("Done! Don't forget to update the --url flag with your actual GitHub Pages URL.")
