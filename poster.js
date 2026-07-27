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

// Photo box is large and fills most of the frame width, like the reference —
// this poster is mostly photo, with everything else packed tight underneath
// it instead of spread out with big gaps.
const PHOTO_SIZE = WIDTH - MARGIN * 2 - 20;

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
// the "DEAD OR ALIVE" line, matching the small filigree marks flanking it in
// the reference.
function drawFlourish(ctx, x, y, flip) {
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  ctx.strokeStyle = "#4a3520";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.bezierCurveTo(9, -12, 9, 0, 0, 0);
  ctx.bezierCurveTo(-9, 0, -9, 12, 0, 12);
  ctx.stroke();
  ctx.restore();
}

// Picks the largest font size (down from maxSize, in 2px steps) at which
// `text` still fits within `maxWidth`. Keeps a long Discord display name
// from overflowing the poster width or getting crushed unpredictably.
function fitFontSize(ctx, text, family, weight, maxSize, minSize, maxWidth) {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px ${family}, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

// One Piece style wanted/bounty poster:
//   headerText     — "WANTED" or "BOUNTY"
//   avatarUrl      — Discord avatar URL, placed in the big photo box as-is
//   name           — printed right under "DEAD OR ALIVE" (spaces become "•",
//                     matching "MONKEY•D•LUFFY" style name-plates)
//   subtitle       — defaults to "DEAD OR ALIVE" if omitted
//   highlightValue — the full-digit Cash number (use formatFullAmount())
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
  ctx.strokeStyle = "#4a3520";
  ctx.lineWidth = 5;
  ctx.strokeRect(12, 12, WIDTH - 24, HEIGHT - 24);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(19, 19, WIDTH - 38, HEIGHT - 38);

  ctx.textAlign = "center";
  ctx.fillStyle = "#3a2a18";

  // Big bold "WANTED"/"BOUNTY" headline, tight to the top
  const headerY = 92;
  ctx.font = "bold 82px PosterFont, sans-serif";
  ctx.fillText(headerText, WIDTH / 2, headerY);

  // White photo box — starts right under the headline, minimal gap
  const photoX = (WIDTH - PHOTO_SIZE) / 2;
  const photoY = headerY + 26;
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

  // "DEAD OR ALIVE" — tight against the photo's bottom edge, like a caption
  // bar directly under the frame instead of floating with a big gap.
  const subtitleY = photoBottom + 40;
  ctx.font = "30px PosterFont, sans-serif";
  drawSpacedText(ctx, (subtitle || "DEAD OR ALIVE").toUpperCase(), WIDTH / 2, subtitleY, 5);
  drawFlourish(ctx, MARGIN + 26, subtitleY - 9, false);
  drawFlourish(ctx, WIDTH - MARGIN - 26, subtitleY - 9, true);

  // Name — dots between words like "MONKEY•D•LUFFY", auto-shrinks to fit.
  const nameY = subtitleY + 46;
  const nameMaxWidth = WIDTH - MARGIN * 2 - 30;
  const nameText = (name || "").toUpperCase().trim().split(/\s+/).join("•");
  const nameSize = fitFontSize(ctx, nameText, "PosterFont", "bold", 42, 22, nameMaxWidth);
  ctx.font = `bold ${nameSize}px PosterFont, sans-serif`;
  ctx.fillText(nameText, WIDTH / 2, nameY);

  // Big bounty number, close to the bottom of the poster — no footer text
  // underneath it anymore, so it just sits near the bottom edge.
  const bountyY = HEIGHT - 46;
  const bountyMaxWidth = WIDTH - MARGIN * 2 - 30;
  const bountyText = `$${highlightValue}`;
  const bountySize = fitFontSize(ctx, bountyText, "PosterFont", "bold", 58, 28, bountyMaxWidth);
  ctx.font = `bold ${bountySize}px PosterFont, sans-serif`;
  ctx.fillText(bountyText, WIDTH / 2, Math.max(bountyY, nameY + 64));

  return canvas.toBuffer("image/png");
}

module.exports = { renderPoster, formatFullAmount };
