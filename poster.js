const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path = require("path");

// Reuses the same bundled font chess.js registers — safe to call again even
// if it's already registered (both wrap it in try/catch).
try {
  GlobalFonts.registerFromPath(path.join(__dirname, "font.ttf"), "PosterFont");
} catch (e) {
  console.error("Poster font registration failed:", e.message);
}

const WIDTH = 620;
const HEIGHT = 878;
const MARGIN = 24;
const INK = "#3a2a18";

const PHOTO_SIZE = WIDTH - MARGIN * 2 - 20;

// Full digit amount WITH comma separators — e.g. 9_500_000 -> "9,500,000".
function formatFullAmount(n) {
  const num = Math.max(0, Math.floor(Number(n) || 0));
  return num.toLocaleString("en-US");
}

// Draws text with manual letter-spacing (canvas has no native letter-spacing
// support). Returns the total rendered width so callers can position things
// (like flourishes) relative to the actual text edges instead of guessing.
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
  return totalWidth;
}

// Ornamental "S"-curve flourish flanking "DEAD OR ALIVE", matching the small
// filigree marks in the reference. Bigger and bolder than before so it
// actually reads at this size, and positioned by the caller relative to the
// real text width instead of a fixed guess.
function drawFlourish(ctx, x, y, flip) {
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.bezierCurveTo(12, -16, 12, 0, 0, 0);
  ctx.bezierCurveTo(-12, 0, -12, 16, 0, 16);
  ctx.stroke();
  ctx.restore();
}

// Hand-drawn "Beli" mark (One Piece's currency symbol) — a "P" with a double
// horizontal strike through the stem. Drawn with paths rather than relying on
// the bundled font having that glyph (font.ttf is a narrow display font meant
// for chess coordinate labels, and can't be assumed to cover it). Returns the
// total width consumed so callers can lay out what comes after it.
function drawBeliMark(ctx, x, y, fontSizePx) {
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  ctx.fillText("P", x, y);
  const pWidth = ctx.measureText("P").width;

  const stemX = x + pWidth * 0.12;
  const strikeW = pWidth * 0.62;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = Math.max(2, fontSizePx * 0.055);
  ctx.beginPath();
  ctx.moveTo(stemX, y - fontSizePx * 0.52);
  ctx.lineTo(stemX + strikeW, y - fontSizePx * 0.52);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(stemX, y - fontSizePx * 0.34);
  ctx.lineTo(stemX + strikeW, y - fontSizePx * 0.34);
  ctx.stroke();

  ctx.textAlign = prevAlign;
  return pWidth;
}

// Picks the largest font size (down from maxSize, in 2px steps) at which
// `text` still fits within `maxWidth`.
function fitFontSize(ctx, text, family, weight, maxSize, minSize, maxWidth) {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px ${family}, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

// Draws the Beli mark + comma-formatted number as one centered group,
// auto-shrinking together so a huge bounty never overflows the poster.
function drawBountyLine(ctx, centerX, y, numberStr, maxWidth, maxSize, minSize) {
  let size = maxSize;
  let pWidth = 0, numWidth = 0, gap = 0, totalWidth = 0;
  while (size > minSize) {
    ctx.font = `bold ${size}px PosterFont, sans-serif`;
    pWidth = ctx.measureText("P").width;
    numWidth = ctx.measureText(numberStr).width;
    gap = size * 0.14;
    totalWidth = pWidth + gap + numWidth;
    if (totalWidth <= maxWidth) break;
    size -= 2;
  }
  ctx.font = `bold ${size}px PosterFont, sans-serif`;
  const startX = centerX - totalWidth / 2;
  drawBeliMark(ctx, startX, y, size);
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  ctx.fillText(numberStr, startX + pWidth + gap, y);
  ctx.textAlign = prevAlign;
}

// One Piece style wanted/bounty poster:
//   headerText     — "WANTED" or "BOUNTY"
//   avatarUrl      — Discord avatar URL, placed in the big photo box as-is
//   name           — printed right under "DEAD OR ALIVE" (spaces become "•")
//   subtitle       — defaults to "DEAD OR ALIVE" if omitted
//   highlightValue — the comma-formatted Cash number (use formatFullAmount())
async function renderPoster({ headerText, avatarUrl, name, subtitle, highlightValue }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // Flat aged-paper tan background
  ctx.fillStyle = "#c9b78f";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(120, 95, 55, ${0.02 + (i % 5) * 0.008})`;
    ctx.fillRect(0, (i / 40) * HEIGHT, WIDTH, HEIGHT / 40 + 2);
  }

  // Clean double-line border, close to the edge
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.strokeRect(12, 12, WIDTH - 24, HEIGHT - 24);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(19, 19, WIDTH - 38, HEIGHT - 38);

  ctx.textAlign = "center";
  ctx.fillStyle = INK;

  // Big bold "WANTED"/"BOUNTY" headline, tight to the top
  const headerY = 92;
  ctx.font = "bold 82px PosterFont, sans-serif";
  ctx.fillText(headerText, WIDTH / 2, headerY);

  // White photo box — starts right under the headline, minimal gap
  const photoX = (WIDTH - PHOTO_SIZE) / 2;
  const photoY = headerY + 26;
  ctx.fillStyle = INK;
  ctx.fillRect(photoX - 4, photoY - 4, PHOTO_SIZE + 8, PHOTO_SIZE + 8);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(photoX, photoY, PHOTO_SIZE, PHOTO_SIZE);
  try {
    const img = await loadImage(avatarUrl);
    ctx.drawImage(img, photoX, photoY, PHOTO_SIZE, PHOTO_SIZE);
  } catch (e) {
    // leave it blank white on failure, matching the template's own placeholder look
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(photoX, photoY, PHOTO_SIZE, PHOTO_SIZE);

  // IMPORTANT: fillStyle was set to white for the photo box above — every
  // fillText call from here on MUST explicitly reset it first, or the text
  // silently renders invisible-on-tan (the exact bug that shipped last time).
  ctx.fillStyle = INK;

  const photoBottom = photoY + PHOTO_SIZE;

  // "DEAD OR ALIVE" — tight against the photo's bottom edge. Flourishes are
  // positioned relative to the ACTUAL rendered text width, so they bracket
  // the words directly instead of floating at a fixed guessed offset.
  const subtitleY = photoBottom + 40;
  ctx.font = "30px PosterFont, sans-serif";
  const subtitleText = (subtitle || "DEAD OR ALIVE").toUpperCase();
  const subtitleWidth = drawSpacedText(ctx, subtitleText, WIDTH / 2, subtitleY, 5);
  drawFlourish(ctx, WIDTH / 2 - subtitleWidth / 2 - 26, subtitleY - 9, false);
  drawFlourish(ctx, WIDTH / 2 + subtitleWidth / 2 + 26, subtitleY - 9, true);

  // Name — dots between words like "MONKEY•D•LUFFY", auto-shrinks to fit.
  const nameY = subtitleY + 46;
  const nameMaxWidth = WIDTH - MARGIN * 2 - 30;
  const nameText = (name || "").toUpperCase().trim().split(/\s+/).join("•");
  const nameSize = fitFontSize(ctx, nameText, "PosterFont", "bold", 42, 22, nameMaxWidth);
  ctx.fillStyle = INK;
  ctx.font = `bold ${nameSize}px PosterFont, sans-serif`;
  ctx.fillText(nameText, WIDTH / 2, nameY);

  // Big bounty number — Beli mark + comma-formatted digits, near the bottom.
  ctx.fillStyle = INK;
  const bountyY = Math.max(HEIGHT - 46, nameY + 64);
  const bountyMaxWidth = WIDTH - MARGIN * 2 - 30;
  drawBountyLine(ctx, WIDTH / 2, bountyY, highlightValue, bountyMaxWidth, 58, 28);

  return canvas.toBuffer("image/png");
}

module.exports = { renderPoster, formatFullAmount };
