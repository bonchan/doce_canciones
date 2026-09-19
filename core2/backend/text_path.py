"""Converts arbitrary text into a list of pen strokes in a polargraph's
physical mm coordinate system, anchored wherever the gondola currently is
— for the "write text" feature.

Uses Hershey fonts (the classic single-stroke plotter font family from the
Hershey-Fonts PyPI package) rather than a normal outline font: a TTF/OTF
glyph defines the *boundary* of an ink shape meant to be filled, so tracing
it with a real pen produces a hollow, double-outlined letter instead of a
natural stroke. Hershey glyphs are already just a handful of line segments
tracing a centerline, the way an actual pen stroke looks — and this
package's "cursive" font specifically comes with joined/connected
letterforms, which is what actually matters for a plotter: fewer strokes
means fewer pen lifts, and pen lifts are the slow, wear-prone part (see
drawing.py's SERVO_SET / pen-lift integration).

A "stroke" here is any polyline meant to be drawn pen-down without lifting
(a Hershey glyph's own connected segments, or several joined letters in a
cursive font). drawing.py no longer treats the gap between strokes
specially — it flattens every stroke into one continuous point list and
draws straight through the gaps too (crossing a "t", dotting an "i", the
space between words), so the whole thing comes out as a single unbroken
line with the pen never lifting mid-drawing.
"""
from HersheyFonts import HersheyFonts

DEFAULT_FONT = "cursive"
DEFAULT_LETTER_HEIGHT_MM = 30.0


def text_to_strokes_mm(
    text: str,
    start_x: float,
    start_y: float,
    letter_height_mm: float = DEFAULT_LETTER_HEIGHT_MM,
    font: str = DEFAULT_FONT,
) -> list[list[tuple[float, float]]]:
    """Returns an ordered list of strokes — each stroke itself an ordered
    list of (x, y) mm points — for `text`, anchored so the very first point
    of the very first stroke lands exactly at (start_x, start_y). The
    caller (drawing.py) is expected to pass the gondola's live telemetry
    position here, which is what makes "start wherever the gondola already
    is" true rather than anchored to some fixed frame the way the solar
    path is.

    No attempt is made to keep the result within the polargraph's physical
    working rectangle — long text starting near an edge can run past it.
    That's a deliberate simplification for now, not an oversight.

    Coordinates come out already in the firmware's own x/y convention
    (matching PolargraphPage.jsx's toPixel/toMm — both axes mirrored
    relative to "visually rightward"/"visually upward") rather than
    Hershey's own coordinate space, so these can be handed straight to
    QUEUE_ADD/MOVE_ABS same as anywhere else in this codebase. Note this
    is a different mirroring than solar_path.py's (which only flips x) —
    Hershey's y increases upward, unlike solar_path.py's own elevation-
    based y formula, which already increases downward on its own. If the
    frontend's toPixel/toMm convention ever changes, both flips below need
    to change with it.
    """
    if not text:
        return []

    hf = HersheyFonts()
    hf.load_default_font(font)
    hf.normalize_rendering(letter_height_mm)  # sets scale so full glyph height = letter_height_mm

    raw_strokes = [list(stroke) for stroke in hf.strokes_for_text(text) if len(stroke) >= 1]
    if not raw_strokes:
        return []

    # Anchor = the very first point of the very first stroke, in Hershey's
    # own (not yet x-mirrored or y-flipped) coordinate space — every point
    # gets shifted by the same amount so this exact point ends up at
    # (start_x, start_y).
    anchor_x, anchor_y = raw_strokes[0][0]

    strokes = []
    for raw_stroke in raw_strokes:
        stroke = []
        for hx, hy in raw_stroke:
            dx = hx - anchor_x  # visually-rightward offset from the anchor
            dy = hy - anchor_y  # visually-UPWARD offset from the anchor — confirmed by rendering
                                 # "T": the top bar comes out at a *larger* y than the descending
                                 # stem's bottom, i.e. normalize_rendering()'s y increases upward,
                                 # not downward like the rest of this codebase assumes. Both x and y
                                 # need mirroring here, not just x.
            x = start_x - dx    # firmware x is mirrored relative to "visually rightward"
            y = start_y - dy    # firmware y is mirrored relative to "visually upward"
            stroke.append((round(x, 2), round(y, 2)))
        strokes.append(stroke)
    return strokes
