const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path = require("path");
const fs = require("fs");

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
const TEMPLATE_PATH = path.join(__dirname, "wanted_template.png");
const INK = "rgb(83, 63, 36)";

// Fractions of the template's own width/height — these stay correct no
// matter what pixel size we ultimately render at.
const PHOTO_BOX = { left: 0.0926, right: 0.9071, top: 0.2143, bottom: 0.6307 };
// The blank band between "DEAD OR ALIVE" (baked into the template) and the
// fine-print/MARINE row at the bottom (also baked in) — measured directly
// from the template's own pixels. Name + bounty share this band, and their
// font sizes are capped so they can never grow past its edges no matter how
// short the text is.
const TEXT_BAND_TOP_FRAC = 0.702;
const TEXT_BAND_BOTTOM_FRAC = 0.856;
const TEXT_SAFE_LEFT_FRAC = 0.15;   // stays clear of the flourish curls on both
const TEXT_SAFE_RIGHT_FRAC = 0.85;  // sides of "DEAD OR ALIVE"

const RENDER_WIDTH = 700;

let cachedTemplate = null;
async function getTemplate() {
  // Read the file into memory and hand loadImage() the raw bytes rather than
  // the path string — passing a bare filesystem path can make loadImage()
  // attempt to parse it as a URL internally and throw "Invalid URL", since a
  // plain path has no scheme (file://, https://, etc). A Buffer sidesteps
  // that entirely.
  if (!cachedTemplate) {
    let fileBuffer;
    try {
      fileBuffer = fs.readFileSync(TEMPLATE_PATH);
    } catch (e) {
      throw new Error(`Wanted poster template not found at ${TEMPLATE_PATH} — make sure wanted_template.png is deployed alongside poster.js and font.ttf.`);
    }
    cachedTemplate = await loadImage(fileBuffer);
  }
  return cachedTemplate;
}

// Full digit amount WITH comma separators — e.g. 9_500_000 -> "9,500,000".
function formatFullAmount(n) {
  const num = Math.max(0, Math.floor(Number(n) || 0));
  return num.toLocaleString("en-US");
}

// Picks the largest font size (down from maxSize, in 2px steps) at which
// `text` still fits within `maxWidth`.
function fitFontSize(ctx, text, weight, maxSize, minSize, maxWidth) {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px PosterFont, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

// One Piece style wanted poster, composited onto the real template:
//   avatarUrl      — Discord avatar URL, placed into the template's photo box
//   name           — printed under "DEAD OR ALIVE" (spaces become "•")
//   highlightValue — the comma-formatted Cash number (use formatFullAmount())
async function renderPoster({ avatarUrl, name, highlightValue }) {
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

  // Text overlay — name, then the bounty amount below it (no currency mark,
  // just the plain comma-formatted number). Both share the blank band
  // between "DEAD OR ALIVE" and the fine print — name gets the top ~55%,
  // bounty the bottom ~45%, each capped so its own line can't grow past its
  // slice of the band even if the text is short enough to want to.
  ctx.textAlign = "center";
  ctx.fillStyle = INK;
  const safeLeft = TEXT_SAFE_LEFT_FRAC * W;
  const safeRight = TEXT_SAFE_RIGHT_FRAC * W;
  const safeWidth = safeRight - safeLeft;
  const centerX = W / 2;

  const bandTop = TEXT_BAND_TOP_FRAC * H;
  const bandBottom = TEXT_BAND_BOTTOM_FRAC * H;
  const bandHeight = bandBottom - bandTop;
  const nameSlotH = bandHeight * 0.55;
  const bountySlotH = bandHeight * 0.45;
  // Cap height (the visible glyph height for bold caps/digits) is roughly
  // 72% of the nominal font size, so divide by that to get a size that
  // actually fits its slot rather than just guessing a pixel number.
  const nameMaxByHeight = nameSlotH * 0.72;
  const bountyMaxByHeight = bountySlotH * 0.72;

  const nameText = (name || "").toUpperCase().trim().split(/\s+/).join("•");
  const nameSize = fitFontSize(ctx, nameText, "bold", Math.min(90, nameMaxByHeight), 18, safeWidth);
  ctx.font = `bold ${nameSize}px PosterFont, sans-serif`;
  ctx.fillStyle = INK;
  ctx.fillText(nameText, centerX, bandTop + nameSlotH * 0.82);

  const bountySize = fitFontSize(ctx, highlightValue, "bold", Math.min(70, bountyMaxByHeight), 22, safeWidth);
  ctx.font = `bold ${bountySize}px PosterFont, sans-serif`;
  ctx.fillStyle = INK;
  ctx.fillText(highlightValue, centerX, bandTop + nameSlotH + bountySlotH * 0.78);

  return canvas.toBuffer("image/png");
}

module.exports = { renderPoster, formatFullAmount };
