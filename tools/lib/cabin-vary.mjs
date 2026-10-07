/* cabin-vary: the seeded variation behind `cabin-black --seed <uint32>` --
   the lab's "Random" / "Try another" on the Cabin tab. Without --seed
   nothing here runs and cabin-black takes the calibrated classification
   (deterministic: the same input gives the same file).

   Why vary at all: "the cabin" has an edge, and where exactly it runs is
   taste. The dash top under the windscreen, the A-pillar trims, the door
   cards' top rail at the window line and the parcel shelf are seen through
   the glass, but each also meets the outside (the cowl, the window frame,
   the rear screen's black border); some exports model them as one piece
   with the outside part. The calibrated rule takes a straddling piece when
   most of what it faces is cabin air; a variant moves that line.

   What a variant draws (lib/variation.mjs Draw, in this order, so a fixed
   parameter never shifts the others):
     straddle  the share of a straddling shell's exposed surface that must
               face cabin air for it to go black (calibrated 0.6). 0.5 takes
               a piece half in and half out; 0.75 keeps only pieces that are
               mostly inside. Below 0.5 the window frames and the cowl panels
               come in (they face outside air more than cabin air), above
               0.75 the parcel shelves and the door-card tops drop out on
               every car measured.
     envelope  how far (voxels of L/300, ~1.6 cm) a HIDDEN shell (one that
               faces no air: a bracket inside the dash, the inner layers of a
               seat) may lie from the cabin's air and still count as cabin
               (calibrated 8, ~13 cm: the thickness of a door or a dash).
               5..11.
     dash, aPillar, doorTops, parcel   each "default" (the rule above),
               "in" (take every piece of that zone that faces the cabin at
               all and is at least 30% inside) or "out" (leave every piece
               of it as it is). The zones, in the cabin's own frame (its air
               from the rear end q = 0 to the front q = 1, height h in H,
               |width| w in W from the centre plane), a shell belonging to a
               zone when 60% of its area lies there:
                 dash      q >= 0.75, h >= 0.5, w <= 0.36  (under the windscreen)
                 aPillar   q >= 0.6,  h >= 0.58, w >= 0.3  (beside it)
                 doorTops  0.15 <= q <= 0.85, 0.48 <= h <= 0.72, w >= 0.33
                 parcel    q <= 0.25, 0.5 <= h <= 0.85, w <= 0.36
   What is NEVER varied: the exclusions (the seat, glass, paint, lights,
   --keep), the air analysis itself (which space is the cabin), and the
   checks: every variant is judged by the same seat/glass/paint/lights
   gates, inside-cabin, cabin-covered and exterior-unchanged as the
   calibrated cut, and a piece seen straight on from outside is never taken
   whatever a zone says. */

export const CALIBRATED = Object.freeze({ straddle: 0.6, envelope: 8, dash: "default", aPillar: "default", doorTops: "default", parcel: "default" });
export const RANGES = Object.freeze({ straddle: [0.5, 0.75], envelope: [5, 11] });
export const ZONES = Object.freeze(["dash", "aPillar", "doorTops", "parcel"]);
const MODES = ["default", "in", "out"];

/* The draws of one attempt. `fixed` holds nothing today (no cabin-black
   flag fixes a parameter), but the slot is kept so the draw order and the
   variation summary read like the other tools'. */
export function drawCabinParams(draw, fixed = {}) {
  const P = {};
  P.straddle = draw.uniform("straddle", RANGES.straddle[0], RANGES.straddle[1], { step: 0.01, fixed: fixed.straddle });
  P.envelope = draw.int("envelope", RANGES.envelope[0], RANGES.envelope[1], { fixed: fixed.envelope });
  for (const z of ZONES) P[z] = draw.choice(z, MODES, { fixed: fixed[z] });
  return P;
}

const ZONE_WORDS = { dash: "dash top", aPillar: "A-pillar trims", doorTops: "door tops", parcel: "parcel shelf" };

/* A few words on how a variant differs from the calibrated cut, e.g.
   "door tops in, parcel shelf out, straddlers from 52% inside". `effect`
   (optional) names the zones that actually changed something on this car:
   a zone toggle that moved no shell is not mentioned. */
export function describeCabin(P, effect = null) {
  const parts = [];
  for (const z of ZONES) if (P[z] !== "default" && (!effect || effect.has(z))) parts.push(ZONE_WORDS[z] + " " + P[z]);
  if (Math.abs(P.straddle - CALIBRATED.straddle) >= 0.04) parts.push((P.straddle < CALIBRATED.straddle ? "loose" : "strict") + " straddlers (" + Math.round(P.straddle * 100) + "% inside)");
  if (P.envelope !== CALIBRATED.envelope) parts.push((P.envelope < CALIBRATED.envelope ? "tight" : "wide") + " envelope (" + P.envelope + " vox)");
  return parts.length ? parts.join(", ") : "calibrated rules";
}
