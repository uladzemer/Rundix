# Rundix mark

The mark is a pair of curly braces enclosing the letter R: `{R}`. The owner selected this direction on 18 October 2026, replacing the initial terminal cursor with R for Rundix.

`rundix-concept.png` is the initial transparent cursor concept produced with the built-in image generation tool. It is retained as historical source material. The production SVGs use the same curly-brace direction with R replacing the cursor, with matching paths across the dark, light and theme-aware variants. R is drawn as a path, so it does not depend on installed fonts. These assets contain no OpenAI blossom geometry.

- `../rundix-dark.svg`: blue mark for dark surfaces and the source for the 256×256 extension-list PNG.
- `../rundix-light.svg`: darker blue mark for light surfaces.
- `../icons/rundix.svg`: `currentColor` version for the chat, generated into `ui/icons.js` by `node build.cjs`.
- `../extension-icon.png`: transparent raster export of `rundix-dark.svg`.

The concept and production assets are included under the project's MIT license. This folder is source material and is excluded from the VSIX.

## Initial concept generation prompt (historical)

Use case: logo-brand. Final standalone production app icon for Rundix, an independent coding assistant. Transparent background with genuine alpha. The mark is exactly `{ | }`: two curly braces enclosing one vertical solid terminal cursor bar. Curly brace on the left, mirrored curly brace on the right, with characteristic inward pinched midpoints. Not round parentheses or square brackets. Exactly three separate bold blue shapes, smoothly rounded corners, consistent weight, bilateral symmetry and balanced spacing. Flat minimal geometric vector-like logo. Solid bright azure blue, approximately `#58B5F5`. No gradients, shadows, glow, 3D, decorative pixels or texture. Center the mark on a square transparent canvas with generous padding. Legible at 16px and 32px. No words, letters, title, mockups, tile background or extra symbols. Do not resemble the OpenAI knot or blossom.
