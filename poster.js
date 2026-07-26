const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path = require("path");

// Reuses the same bundled font chess.js registers — safe to call again even
// if it's already registered (both wrap it in try/catch).
try {
  GlobalFonts.registerFromPath(path.join(__dirname, "font.ttf"), "PosterFont");
} catch (e) {
  console.error("Poster font registration failed:", e.message);
}

const WIDTH = 640;
const HEIGHT = 860;
const PHOTO_SIZE = 380;

// Seeded RNG so a given poster's "aging" texture is stable across re-renders
// of the exact same inputs, instead of jittering every time it's regenerated.
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
  return Math.abs(h) || 1;
}

// Converts the loaded avatar to a warm sepia tone in-place so it reads like
// an old ink/photo print instead of a flat color Discord PFP.
function applySepia(ctx, x, y, w, h) {
  const imageData = ctx.getImageData(x, y, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    d[i]     = Math.min(255, gray * 1.08 + 18);
    d[i + 1] = Math.min(255, gray * 0.86 + 8);
    d[i + 2] = Math.min(255, gray * 0.60);
  }
  ctx.putImageData(imageData, x, y);
}

// Hand-inked-looking border: several slightly offset rectangles instead of
// one clean stroke, plus small torn notches at the corners.
function drawRoughBorder(ctx, rng) {
  ctx.save();
  ctx.strokeStyle = "#2a1a0d";
  for (let i = 0; i < 4; i++) {
    const jitter = () => (rng() - 0.5) * 4;
    ctx.lineWidth = 8 - i * 1.2;
    ctx.strokeRect(14 + jitter(), 14 + jitter(), WIDTH - 28 + jitter(), HEIGHT - 28 + jitter());
  }
  ctx.lineWidth = 2;
  ctx.strokeRect(30, 30, WIDTH - 60, HEIGHT - 60);

  // Torn corner bites — small arcs cut with the background tone
  ctx.fillStyle = "#e9d6a8";
  const corners = [[14, 14], [WIDTH - 14, 14], [14, HEIGHT - 14], [WIDTH - 14, HEIGHT - 14]];
  for (const [cx, cy] of corners) {
    ctx.beginPath();
    ctx.arc(cx, cy, 10 + rng() * 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// One Piece style wanted/bounty poster. opts:
//   headerText     — "WANTED" or "BOUNTY"
//   avatarUrl      — Discord avatar URL (falls back to a plain silhouette box)
//   name           — printed big and bold under the photo
//   subtitle       — small line under the name, e.g. "DEAD OR ALIVE"
//   highlightValue — the big number at the bottom, e.g. "950,000" (no $ needed, added automatically)
//   lines          — smaller stat lines between name and the big number
//   footerText     — tiny stamp-style line at the very bottom, e.g. "COSA FAMILY"
async function renderPoster({ headerText, avatarUrl, name, subtitle, highlightValue, lines, footerText }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const rng = seededRandom(hashString(`${headerText}:${name}:${highlightValue}`));

  // Aged parchment background
  const grad = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  grad.addColorStop(0, "#f0dfb0");
  grad.addColorStop(0.5, "#e8d29a");
  grad.addColorStop(1, "#ecd8a8");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Faint age spots
  for (let i = 0; i < 90; i++) {
    const x = rng() * WIDTH;
    const y = rng() * HEIGHT;
    const r = 2 + rng() * 10;
    ctx.fillStyle = `rgba(90, 60, 25, ${0.04 + rng() * 0.06})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  drawRoughBorder(ctx, rng);

  ctx.textAlign = "center";

  // Big bold "WANTED" banner with a subtle stamped double-print look
  ctx.fillStyle = "#1c1006";
  ctx.font = "bold 90px PosterFont, sans-serif";
  ctx.fillText(headerText, WIDTH / 2 + 2, 122 + 2);
  ctx.fillStyle = "#000000";
  ctx.fillText(headerText, WIDTH / 2, 120);

  // Thin rule under the banner
  ctx.strokeStyle = "#1c1006";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(70, 148);
  ctx.lineTo(WIDTH - 70, 148);
  ctx.stroke();

  // Photo — sepia-toned, thick ink border
  const photoX = (WIDTH - PHOTO_SIZE) / 2;
  const photoY = 168;
  ctx.fillStyle = "#000000";
  ctx.fillRect(photoX - 8, photoY - 8, PHOTO_SIZE + 16, PHOTO_SIZE + 16);
  try {
    const img = await loadImage(avatarUrl);
    ctx.drawImage(img, photoX, photoY, PHOTO_SIZE, PHOTO_SIZE);
    applySepia(ctx, photoX, photoY, PHOTO_SIZE, PHOTO_SIZE);
  } catch (e) {
    ctx.fillStyle = "#8a7752";
    ctx.fillRect(photoX, photoY, PHOTO_SIZE, PHOTO_SIZE);
  }
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 3;
  ctx.strokeRect(photoX, photoY, PHOTO_SIZE, PHOTO_SIZE);

  let y = photoY + PHOTO_SIZE + 50;

  // "DEAD OR ALIVE" / subtitle banner
  if (subtitle) {
    ctx.fillStyle = "#1c1006";
    ctx.font = "italic bold 30px PosterFont, sans-serif";
    ctx.fillText(subtitle, WIDTH / 2, y);
    y += 46;
  }

  // Name, big bold caps
  ctx.fillStyle = "#000000";
  ctx.font = "bold 44px PosterFont, sans-serif";
  ctx.fillText(name.toUpperCase(), WIDTH / 2, y);
  y += 40;

  // Stat lines (optional, smaller)
  ctx.font = "20px PosterFont, sans-serif";
  ctx.fillStyle = "#2b1d10";
  for (const line of lines || []) {
    y += 28;
    ctx.fillText(line, WIDTH / 2, y);
  }

  // Big bounty number at the bottom — the centerpiece, One Piece style
  y = HEIGHT - 110;
  ctx.fillStyle = "#1c1006";
  ctx.font = "bold 58px PosterFont, sans-serif";
  ctx.fillText(`$ ${highlightValue}`, WIDTH / 2, y);

  // Small stamp-style footer, slightly rotated like a mail stamp
  ctx.save();
  ctx.translate(WIDTH / 2, HEIGHT - 55);
  ctx.rotate(-0.03);
  ctx.font = "bold 16px PosterFont, sans-serif";
  ctx.fillStyle = "#5c4324";
  ctx.fillText((footerText || "").toUpperCase(), 0, 0);
  ctx.restore();

  return canvas.toBuffer("image/png");
}

module.exports = { renderPoster };
