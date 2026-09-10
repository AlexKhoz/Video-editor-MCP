/**
 * The chat bubbles' typeface.
 *
 * ## This is a substitute, and swapping back is one line
 *
 * The source renders in **Pangea Text**, Replika's licensed brand face. This repository is
 * public and the terms for redistributing that font here are unresolved, so the actual
 * .woff2 is deliberately NOT vendored — the same call orbit-headline-Rep makes when it
 * stands Archivo Black in for the commercial Widescreen-Bold.
 *
 * DM Sans (SIL Open Font License 1.1) is the substitute, chosen by measurement rather than
 * by eye. Against Pangea Text Regular, per 1000 em:
 *
 *              x-height   cap-height   n     o     H
 *   Pangea         505        700      575   610   735
 *   DM Sans        504        700      574   593   681
 *
 * It was the closest of the 46 weight-400 upright faces already vendored in this repo, and
 * it is the same class of design — a geometric-humanist sans with a generous x-height. The
 * x-height and `n` advance matching to within a unit matters more than it sounds: bubble
 * geometry is driven by measured text width, so a face that wraps differently changes the
 * silhouette, not just the texture.
 *
 * To go back to the real thing once licensing and repo visibility are settled: drop
 * PangeaText-Regular.woff2 into assets/ and change the two constants below. Nothing else
 * refers to the font by name.
 */

// A plain asset import: Vite serves it in dev and copies it into the bundle at build time,
// so the render harness and the dev server get it from the same place. Deliberately NOT
// "?url" — this package's Motion Canvas plugin turns that into a request that serves the
// raw binary as a module, and the font then 404s. The brand JPEGs in
// turbulent-background-Rep load the same plain way.
import fontUrl from "../assets/fonts/DMSans-Regular-latin.woff2";

/** The family name the bubbles ask for. */
export const FONT_FAMILY = "DM Sans Rep";

/** Where the face is loaded from. */
export const FONT_URL: string = fontUrl;

/** The real thing, for the note in meta.json and NOTES.md to stay honest about. */
export const SUBSTITUTE_FOR = "Pangea Text";
