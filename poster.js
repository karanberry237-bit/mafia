const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path = require("path");

// Reuses the same bundled font chess.js registers — safe to call again even
// if it's already registered (both wrap it in try/catch).
try {
  GlobalFonts.registerFromPath(path.join(__dirname, "font.ttf"), "PosterFont");
} catch (e) {
  console.error("Poster font registration failed:", e.message);
}

// Matches the reference template's proportions (~414x586 → scaled up 1.5x).
const WIDTH = 620;
const HEIGHT = 878;
const MARGIN = 30;

// Photo box is now a fixed, smaller square (instead of "fill the whole
// width"), and gets centered horizontally. This is the actual fix for the
// overlap bug: the old PHOTO_SIZE (WIDTH - MARGIN*2 - 16 ≈ 544px) left almost
// no vertical room between the photo and the bounty number, so
// "DEAD OR ALIVE" / the name / the bounty all got crushed into the same band.
const PHOTO_SIZE = 420;

// Full digit amount, no compact k/m/b shorthand and no comma separators —
// e.g. 1_000_000 -> "1000000". This is what goes after the "$" on the poster.
function formatFullAmount(n) {
  return String(Math.max(0, Math.floor(Number(n) || 0)));
}

// Draws text with manual letter-spacing (canvas has no native letter-spacing
// support), used for the "DEAD OR ALIVE" line to match the reference's
// spaced-out lettering.
function drawSpacedText(ctx, text, centerX, y, spacing) {
  const widths = [...text].map(ch => ctx.measureText(ch).width);
  const totalWidth = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
  let x = centerX - totalWidth / 2;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i], x, y);
    x += widths[i] + spacing;
  }
  ctx.textAlign = prevAlign;
}

// Small ornamental flourish (an "S"-curve squiggle), drawn to either side of
// the "DEAD OR ALIVE" line the way the reference template has small filigree
// marks flanking it.
function drawFlourish(ctx, x, y, flip) {
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  ctx.strokeStyle = "#4a3520";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -14);
  ctx.bezierCurveTo(10, -14, 10, 0, 0, 0);
  ctx.bezierCurveTo(-10, 0, -10, 14, 0, 14);
  ctx.stroke();
  ctx.restore();
}

// Picks the largest font size (down from maxSize, in 2px steps) at which
// `text` still fits within `maxWidth` using `weight`/`family`. This is what
// keeps a long Discord display name from overflowing the poster width or,
// worse, from being shrunk so unpredictably that it collides with neighboring
// text — every size step still respects the same baseline.
function fitFontSize(ctx, text, family, weight, maxSize, minSize, maxWidth) {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px ${family}, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

// One Piece style wanted/bounty poster, matching the reference template:
//   headerText     — "WANTED" or "BOUNTY"
//   avatarUrl      — Discord avatar URL, placed in the big photo box as-is
//   name           — printed below "DEAD OR ALIVE"
//   subtitle       — defaults to "DEAD OR ALIVE" if omitted
//   highlightValue — the full-digit Cash number (use formatFullAmount())
//   footerText     — bold word in the bottom-right corner, e.g. "COSA FAMILY"
async function renderPoster({ headerText, avatarUrl, name, subtitle, highlightValue, footerText }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // Flat aged-paper tan background (matches the reference's plain khaki tone)
  ctx.fillStyle = "#c9b78f";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  // Very subtle marbling so it isn't perfectly flat
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(120, 95, 55, ${0.02 + (i % 5) * 0.008})`;
    ctx.fillRect(0, (i / 40) * HEIGHT, WIDTH, HEIGHT / 40 + 2);
  }

  // Clean double-line border, close to the edge
  ctx.strokeStyle = "#4a3520";
  ctx.lineWidth = 5;
  ctx.strokeRect(14, 14, WIDTH - 28, HEIGHT - 28);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(22, 22, WIDTH - 44, HEIGHT - 44);

  ctx.textAlign = "center";
  ctx.fillStyle = "#3a2a18";

  // ----- Fixed zones, top and bottom, laid out first -----
  // Header sits in a fixed band at the top.
  const headerY = 108;

  // Footer (fine print + bold family name) is a fixed band at the bottom.
  const footerLine1Y = HEIGHT - 42;
  const footerLine2Y = HEIGHT - 30;
  const footerBoldY = HEIGHT - 34;

  // The bounty number sits just above the footer, with a fixed gap.
  const bountyY = footerLine1Y - 46;

  // ----- Everything else derives from what came before it, so it can never -----
  // ----- overlap the fixed zones above or the fixed bounty number below.   -----

  // Big bold "WANTED"/"BOUNTY" headline
  ctx.font = "bold 84px PosterFont, sans-serif";
  ctx.fillText(headerText, WIDTH / 2, headerY);

  // White photo box, fixed size, centered horizontally
  const photoX = (WIDTH - PHOTO_SIZE) / 2;
  const photoY = headerY + 40;
  ctx.fillStyle = "#3a2a18";
  ctx.fillRect(photoX - 4, photoY - 4, PHOTO_SIZE + 8, PHOTO_SIZE + 8);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(photoX, photoY, PHOTO_SIZE, PHOTO_SIZE);
  try {
    const img = await loadImage(avatarUrl);
    ctx.drawImage(img, photoX, photoY, PHOTO_SIZE, PHOTO_SIZE);
  } catch (e) {
    // leave it blank white on failure, matching the template's own placeholder look
  }
  ctx.strokeStyle = "#3a2a18";
  ctx.lineWidth = 2;
  ctx.strokeRect(photoX, photoY, PHOTO_SIZE, PHOTO_SIZE);

  const photoBottom = photoY + PHOTO_SIZE;

  // "DEAD OR ALIVE" with flourishes on either side
  const subtitleY = photoBottom + 50;
  ctx.fillStyle = "#3a2a18";
  ctx.font = "32px PosterFont, sans-serif";
  drawSpacedText(ctx, subtitle || "DEAD OR ALIVE", WIDTH / 2, subtitleY, 6);
  drawFlourish(ctx, MARGIN + 30, subtitleY - 10, false);
  drawFlourish(ctx, WIDTH - MARGIN - 30, subtitleY - 10, true);

  // Name — auto-shrinks to fit the available width so long names never
  // spill past the border or crowd the bounty number below.
  const nameY = subtitleY + 52;
  const nameMaxWidth = WIDTH - MARGIN * 2 - 40;
  const nameText = (name || "").toUpperCase();
  const nameSize = fitFontSize(ctx, nameText, "PosterFont", "bold", 40, 22, nameMaxWidth);
  ctx.font = `bold ${nameSize}px PosterFont, sans-serif`;
  ctx.fillText(nameText, WIDTH / 2, nameY);

  // Safety net: if a very tall stack of content above ever pushed the name
  // past where the bounty number starts, clamp the bounty number down so it
  // never renders on top of the name. In the normal (fixed layout) case this
  // is a no-op since bountyY already sits comfortably below nameY.
  const bountyYSafe = Math.max(bountyY, nameY + 60);

  // Big bounty number — the focal point, full digits, no shorthand
  ctx.font = "bold 56px PosterFont, sans-serif";
  ctx.fillText(`$${highlightValue}`, WIDTH / 2, bountyYSafe);

  // Bottom row — tiny fine print bottom-left, bold word bottom-right
  ctx.textAlign = "left";
  ctx.font = "10px PosterFont, sans-serif";
  ctx.fillStyle = "#4a3520";
  ctx.fillText("THIS POSTER IS PROPERTY OF THE COSA FAMILY.", MARGIN + 10, footerLine1Y);
  ctx.fillText("UNAUTHORIZED REMOVAL WILL BE MET WITH CONSEQUENCE.", MARGIN + 10, footerLine2Y);

  ctx.textAlign = "right";
  ctx.font = "bold 28px PosterFont, sans-serif";
  ctx.fillStyle = "#3a2a18";
  ctx.fillText((footerText || "COSA FAMILY").toUpperCase(), WIDTH - MARGIN - 10, footerBoldY);

  return canvas.toBuffer("image/png");
}

module.exports = { renderPoster, formatFullAmount };
