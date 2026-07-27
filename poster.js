const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path = require("path");

// Reuses the same bundled font chess.js registers — safe to call again even
// if it's already registered (both wrap it in try/catch).
try {
  GlobalFonts.registerFromPath(path.join(__dirname, "font.ttf"), "PosterFont");
} catch (e) {
  console.error("Poster font registration failed:", e.message);
}

// ── Real template compositing ───────────────────────────────────────────────
// Instead of hand-drawing the border/headline/"DEAD OR ALIVE"/flourishes with
// canvas primitives (which never quite matched a real design), this loads the
// actual reference template image and only draws THREE things on top of it:
//   1. the avatar, into the template's transparent photo-box cutout
//   2. the name
//   3. the bounty amount
// Geometry below was measured directly from the template file's own pixels
// (the transparent cutout's exact bounding box, and the ink color sampled
// from its "WANTED" headline) rather than guessed.
const TEMPLATE_PATH = path.join(__dirname, "assets", "wanted_template.png");
const INK = "rgb(83, 63, 36)";

// Fractions of the template's own width/height — these stay correct no
// matter what pixel size we ultimately render at.
const PHOTO_BOX = { left: 0.0926, right: 0.9071, top: 0.2143, bottom: 0.6307 };
const BOUNTY_Y_FRAC = 0.79; // centered in the blank gap between "DEAD OR ALIVE" and the fine print
const TEXT_SAFE_LEFT_FRAC = 0.15;   // stays clear of the flourish curls on both
const TEXT_SAFE_RIGHT_FRAC = 0.85;  // sides of "DEAD OR ALIVE"

const RENDER_WIDTH = 700;

let cachedTemplate = null;
async function getTemplate() {
  if (!cachedTemplate) cachedTemplate = await loadImage(TEMPLATE_PATH);
  return cachedTemplate;
}

// Full digit amount WITH comma separators — e.g. 9_500_000 -> "9,500,000".
function formatFullAmount(n) {
  const num = Math.max(0, Math.floor(Number(n) || 0));
  return num.toLocaleString("en-US");
}

// Hand-drawn "Beli" mark (One Piece's currency symbol) — a "P" with a double
// horizontal strike through the stem, drawn with paths rather than relying on
// the bundled display font having that glyph. Returns its rendered width.
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

// Draws the Beli mark + comma-formatted number as one centered group,
// auto-shrinking together so a huge bounty never overflows.
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

// One Piece style wanted poster, composited onto the real template:
//   avatarUrl      — Discord avatar URL, placed into the template's photo box
//   highlightValue — the comma-formatted Cash number (use formatFullAmount())
async function renderPoster({ avatarUrl, highlightValue }) {
  const template = await getTemplate();
  const W = RENDER_WIDTH;
  const H = Math.round(RENDER_WIDTH * (template.height / template.width));

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Photo goes in FIRST, underneath the template, so the template's cutout
  // border sits cleanly on top of it with no seams.
  const boxX = PHOTO_BOX.left * W;
  const boxY = PHOTO_BOX.top * H;
  const boxW = (PHOTO_BOX.right - PHOTO_BOX.left) * W;
  const boxH = (PHOTO_BOX.bottom - PHOTO_BOX.top) * H;
  try {
    const avatar = await loadImage(avatarUrl);
    // Cover-fit: scale to fill the box without distorting, cropping overflow.
    const scale = Math.max(boxW / avatar.width, boxH / avatar.height);
    const drawW = avatar.width * scale;
    const drawH = avatar.height * scale;
    const drawX = boxX + (boxW - drawW) / 2;
    const drawY = boxY + (boxH - drawH) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(boxX, boxY, boxW, boxH);
    ctx.clip();
    ctx.drawImage(avatar, drawX, drawY, drawW, drawH);
    ctx.restore();
  } catch (e) {
    ctx.fillStyle = "#e5e0d5";
    ctx.fillRect(boxX, boxY, boxW, boxH);
  }

  // Template on top — its transparent cutout now shows the avatar underneath.
  ctx.drawImage(template, 0, 0, W, H);

  // Text overlay — just the bounty amount, centered in the blank space.
  ctx.textAlign = "center";
  ctx.fillStyle = INK;
  const safeLeft = TEXT_SAFE_LEFT_FRAC * W;
  const safeRight = TEXT_SAFE_RIGHT_FRAC * W;
  const safeWidth = safeRight - safeLeft;
  const centerX = W / 2;

  drawBountyLine(ctx, centerX, BOUNTY_Y_FRAC * H, highlightValue, safeWidth, 52, 22);

  return canvas.toBuffer("image/png");
}

module.exports = { renderPoster, formatFullAmount };
