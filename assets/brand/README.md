# 拾传 / PickDrop · A「拾点」

Original vector artwork redrawn from the approved A concept in
`docs/ui-concepts/2026-10-05-logo/A-pickup.png`. The asymmetric cupped shape
receives a rounded square rotated −24°. There are no embedded raster images,
fonts, filters, gradients, or third-party logo assets in the SVGs.

## Assets

| File | Usage |
| --- | --- |
| `mark.svg`, `mark.png` | Teal hand and mint square; transparent, PNG 1024×1024 |
| `mark-mono.svg`, `mark-mono.png` | Black one-color mark; transparent, PNG 1024×1024 |
| `app-icon.svg`, `app-icon.png` | Ivory mark on rounded teal tile; transparent outer corners, PNG 1024×1024 |
| `app-icon-{512,256,128,64,32,16}.png` | Raster exports at the named sizes |
| `mac-icon.svg`, `mac-icon.png`, `mac-icon-{512,256,128,64,32,16}.png` | macOS Dock tile occupies 420/512 of the canvas, with transparent margins and a subtle offset shadow |
| `mobile-icon.svg`, `mobile-icon.png` | Fully opaque square tile, PNG 1024×1024; platform applies its own mask |
| `adaptive-foreground.svg`, `adaptive-foreground.png` | Transparent Android foreground; 1024×1024 with reduced central symbol |
| `monochrome-icon.svg`, `monochrome-icon.png` | White Android themed-icon mask; same alignment as adaptive foreground |
| `trayTemplate.svg`, `trayTemplate.png`, `trayTemplate@2x.png` | Black transparent macOS template; PNG 18×18 and 36×36 |
| `manifest.json` | Palette and exported PNG dimensions |

Use `#126A5A` as the Android adaptive background. The foreground's visible
bounds are 512×467 px on its 1024×1024 canvas, inside the central safe area.
The foreground and monochrome mask deliberately share exactly the same geometry.
Do not add a second background or rounded mask to either one.

Palette: teal `#126A5A`, mint `#32C6A2`, ivory `#F3F5EE`.
Keep the two shapes and their gap intact. Use the mono mark on backgrounds
where the teal mark has insufficient contrast; macOS template rendering handles
tray appearance. The application icon uses an ivory symbol for contrast.

## Rebuild

`scripts/generate-brand-assets.js` is the canonical geometry and export script.
It uses the Sharp SVG rasterizer as a tooling dependency; it does not add Sharp
to this application's production dependencies or access a browser.

```sh
PICKDROP_SHARP_MODULE=/absolute/path/to/sharp node scripts/generate-brand-assets.js
```

The variable is optional when `sharp` is resolvable by Node or is supplied beside
the bundled tooling Node runtime. SVG files remain independently editable and
renderable by any conforming SVG renderer.
