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
// Loads the actual reference template image and only draws THREE things on
// top of it: the avatar (into the transparent photo-box cutout), the name,
// and the bounty amount. All geometry below was measured directly from the
// template's own pixels (transparent cutout bounds, ink color, the "JB"
// monogram mark, and the "MARINE" text) rather than guessed.
const TEMPLATE_PATH = path.join(__dirname, "wanted_template.png");
const INK = "rgb(83, 63, 36)";

const PHOTO_BOX = { left: 0.0926, right: 0.9071, top: 0.2143, bottom: 0.6307 };

// The blank band between "DEAD OR ALIVE" and the monogram/fine-print row —
// the name gets this whole band to itself now (the bounty number moved down
// next to the monogram instead of sharing this space), so it can render
// noticeably bigger.
const TEXT_BAND_TOP_FRAC = 0.702;
const TEXT_BAND_BOTTOM_FRAC = 0.856;
const TEXT_SAFE_LEFT_FRAC = 0.15;
const TEXT_SAFE_RIGHT_FRAC = 0.85;

// The template's own "JB" monogram mark (measured bounding box, border
// excluded) — the bounty number is placed immediately to its right, on the
// same vertical center, instead of a hand-drawn currency symbol.
const MONOGRAM_BOX = { left: 0.035, right: 0.170, top: 0.819, bottom: 0.909 };
// "MARINE" (also baked into the template) starts here — the number's
// available width is capped before this so it can never run into it.
const MARINE_LEFT_FRAC = 0.665;

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

// Curated surnames pulled from across the series, used for the
// "displayName•D•[surname]" naming gimmick (mirrors how canon characters
// like Monkey D. Luffy or Portgas D. Ace are named).
const D_SURNAMES = [
  "ROGER", "NEWGATE", "TEACH", "DRAGON", "GARP", "KUROHIGE", "SHANKS",
  "MIHAWK", "KAIDO", "LINLIN", "DOFLAMINGO", "CROCODILE", "MORIA", "KUMA",
  "HANCOCK", "REVOLUTIONARY", "WHITEBEARD", "BUGGY", "RAYLEIGH", "OARS",
];
function randomDSurname() {
  return D_SURNAMES[Math.floor(Math.random() * D_SURNAMES.length)];
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

  ctx.textAlign = "center";
  ctx.fillStyle = INK;

  // ── Name — gets the full band now, so it can render bigger ────────────────
  const safeLeft = TEXT_SAFE_LEFT_FRAC * W;
  const safeRight = TEXT_SAFE_RIGHT_FRAC * W;
  const safeWidth = safeRight - safeLeft;
  const centerX = W / 2;

  const bandTop = TEXT_BAND_TOP_FRAC * H;
  const bandBottom = TEXT_BAND_BOTTOM_FRAC * H;
  const bandPadding = (bandBottom - bandTop) * 0.08;
  const usableTop = bandTop + bandPadding;
  const usableBottom = bandBottom - bandPadding;
  const usableHeight = usableBottom - usableTop;
  const nameMaxByHeight = usableHeight * 0.72;

  const rawName = (name || "").toUpperCase().trim();
  const nameText = `${rawName} D ${randomDSurname()}`.split(/\s+/).join("•");
  const nameSize = fitFontSize(ctx, nameText, "bold", Math.min(100, nameMaxByHeight), 16, safeWidth);
  ctx.font = `bold ${nameSize}px PosterFont, sans-serif`;
  // textBaseline "middle" centers on the true vertical midpoint of the font's
  // own metrics, so the gap above and below ends up equal — the previous
  // fixed 0.78 offset was pushing it down, leaving way more space above than
  // below.
  ctx.textBaseline = "middle";
  ctx.fillText(nameText, centerX, usableTop + usableHeight / 2);
  ctx.textBaseline = "alphabetic"; // reset for what follows

  // ── Bounty number — right next to the template's own monogram mark ────────
  const monoLeft = MONOGRAM_BOX.left * W;
  const monoRight = MONOGRAM_BOX.right * W;
  const monoTop = MONOGRAM_BOX.top * H;
  const monoBottom = MONOGRAM_BOX.bottom * H;
  const monoCenterY = (monoTop + monoBottom) / 2;
  const monoHeight = monoBottom - monoTop;

  // Sits directly next to the monogram, centered within the space it has
  // between the monogram and "MARINE" — this stays close to the mark (as
  // asked) rather than centered on the whole page, which pushed it away from
  // the monogram entirely. Capped so it can never reach "MARINE".
  const marginPx = W * 0.02;
  const numberAreaLeft = monoRight + marginPx;
  const numberAreaRight = MARINE_LEFT_FRAC * W - marginPx;
  const numberMaxWidth = numberAreaRight - numberAreaLeft;
  const numberCenterX = (numberAreaLeft + numberAreaRight) / 2;
  const numberMaxByHeight = monoHeight * 1.4; // a bit bigger than the mark itself, but proportional

  ctx.textAlign = "center";
  const numberSize = fitFontSize(ctx, highlightValue, "bold", Math.min(64, numberMaxByHeight), 18, numberMaxWidth);
  ctx.font = `bold ${numberSize}px PosterFont, sans-serif`;
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(highlightValue, numberCenterX, monoCenterY);
  ctx.lineWidth = Math.max(1, numberSize * 0.035);
  ctx.strokeStyle = INK;
  ctx.strokeText(highlightValue, numberCenterX, monoCenterY);
  ctx.textBaseline = "alphabetic";

  return canvas.toBuffer("image/png");
}

module.exports = { renderPoster, formatFullAmount };
