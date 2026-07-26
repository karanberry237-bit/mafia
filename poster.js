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
const PHOTO_SIZE = WIDTH - MARGIN * 2 - 16;

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

  // Big bold "WANTED"/"BOUNTY" headline
  ctx.font = "bold 84px PosterFont, sans-serif";
  ctx.fillText(headerText, WIDTH / 2, 108);

  // White photo box
  const photoX = MARGIN + 8;
  const photoY = 138;
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

  let y = photoY + PHOTO_SIZE + 58;

  // "DEAD OR ALIVE" with flourishes on either side
  ctx.fillStyle = "#3a2a18";
  ctx.font = "32px PosterFont, sans-serif";
  drawSpacedText(ctx, subtitle || "DEAD OR ALIVE", WIDTH / 2, y, 6);
  drawFlourish(ctx, MARGIN + 30, y - 10, false);
  drawFlourish(ctx, WIDTH - MARGIN - 30, y - 10, true);

  y += 52;

  // Name
  ctx.font = "bold 40px PosterFont, sans-serif";
  ctx.fillText((name || "").toUpperCase(), WIDTH / 2, y);

  // Big bounty number — the focal point, full digits, no shorthand
  y = HEIGHT - 110;
  ctx.font = "bold 56px PosterFont, sans-serif";
  ctx.fillText(`$${highlightValue}`, WIDTH / 2, y);

  // Bottom row — tiny fine print bottom-left, bold word bottom-right
  ctx.textAlign = "left";
  ctx.font = "10px PosterFont, sans-serif";
  ctx.fillStyle = "#4a3520";
  ctx.fillText("THIS POSTER IS PROPERTY OF THE COSA FAMILY.", MARGIN + 10, HEIGHT - 42);
  ctx.fillText("UNAUTHORIZED REMOVAL WILL BE MET WITH CONSEQUENCE.", MARGIN + 10, HEIGHT - 30);

  ctx.textAlign = "right";
  ctx.font = "bold 28px PosterFont, sans-serif";
  ctx.fillStyle = "#3a2a18";
  ctx.fillText((footerText || "COSA FAMILY").toUpperCase(), WIDTH - MARGIN - 10, HEIGHT - 34);

  return canvas.toBuffer("image/png");
}

module.exports = { renderPoster, formatFullAmount };
