const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path = require("path");

// Reuses the same bundled font chess.js registers — safe to call again even
// if it's already registered (both wrap it in try/catch).
try {
  GlobalFonts.registerFromPath(path.join(__dirname, "font.ttf"), "PosterFont");
} catch (e) {
  console.error("Poster font registration failed:", e.message);
}

const WIDTH = 600;
const HEIGHT = 800;
const AVATAR_SIZE = 260;

// Shared "old West wanted poster" frame — used for both the rap-sheet Wanted
// Poster and the Bounty Poster. opts:
//   headerText     — big top banner, e.g. "WANTED" or "BOUNTY"
//   avatarUrl      — Discord avatar URL (falls back to a plain box on failure)
//   name           — display name under the photo
//   subtitle       — small italic line under the name
//   highlightLabel / highlightValue — the big dollar-amount line
//   lines          — array of smaller stat lines below that
//   footerText     — small italic line at the very bottom
async function renderPoster({ headerText, avatarUrl, name, subtitle, highlightLabel, highlightValue, lines, footerText }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // Parchment background
  const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  grad.addColorStop(0, "#f4e4bc");
  grad.addColorStop(1, "#e8d29a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Double border frame
  ctx.strokeStyle = "#3d2914";
  ctx.lineWidth = 10;
  ctx.strokeRect(15, 15, WIDTH - 30, HEIGHT - 30);
  ctx.lineWidth = 2;
  ctx.strokeRect(28, 28, WIDTH - 56, HEIGHT - 56);

  ctx.textAlign = "center";

  // Header banner
  ctx.fillStyle = "#3d2914";
  ctx.font = "bold 64px PosterFont, sans-serif";
  ctx.fillText(headerText, WIDTH / 2, 100);

  // Avatar
  const avatarX = (WIDTH - AVATAR_SIZE) / 2;
  const avatarY = 130;
  try {
    const img = await loadImage(avatarUrl);
    ctx.strokeStyle = "#3d2914";
    ctx.lineWidth = 6;
    ctx.strokeRect(avatarX - 3, avatarY - 3, AVATAR_SIZE + 6, AVATAR_SIZE + 6);
    ctx.drawImage(img, avatarX, avatarY, AVATAR_SIZE, AVATAR_SIZE);
  } catch (e) {
    ctx.fillStyle = "#c9b183";
    ctx.fillRect(avatarX, avatarY, AVATAR_SIZE, AVATAR_SIZE);
    ctx.strokeStyle = "#3d2914";
    ctx.lineWidth = 6;
    ctx.strokeRect(avatarX - 3, avatarY - 3, AVATAR_SIZE + 6, AVATAR_SIZE + 6);
  }

  // Name + subtitle
  ctx.fillStyle = "#3d2914";
  ctx.font = "bold 38px PosterFont, sans-serif";
  ctx.fillText(name, WIDTH / 2, avatarY + AVATAR_SIZE + 52);

  if (subtitle) {
    ctx.font = "italic 20px PosterFont, sans-serif";
    ctx.fillText(subtitle, WIDTH / 2, avatarY + AVATAR_SIZE + 80);
  }

  // Big highlight line (the dollar amount)
  ctx.font = "bold 30px PosterFont, sans-serif";
  ctx.fillStyle = "#7a1f1f";
  ctx.fillText(`${highlightLabel}: ${highlightValue}`, WIDTH / 2, avatarY + AVATAR_SIZE + 130);

  // Stat lines
  ctx.font = "22px PosterFont, sans-serif";
  ctx.fillStyle = "#2b1d10";
  let y = avatarY + AVATAR_SIZE + 172;
  for (const line of lines || []) {
    ctx.fillText(line, WIDTH / 2, y);
    y += 32;
  }

  // Footer
  ctx.font = "italic 18px PosterFont, sans-serif";
  ctx.fillStyle = "#5c4324";
  ctx.fillText(footerText || "", WIDTH / 2, HEIGHT - 40);

  return canvas.toBuffer("image/png");
}

module.exports = { renderPoster };
