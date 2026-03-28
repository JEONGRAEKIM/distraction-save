const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function drawShield(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const s = size / 128; // 128 기준 스케일

  // 배경 투명
  ctx.clearRect(0, 0, size, size);

  // 방패 경로 (128 기준 좌표)
  ctx.save();
  ctx.scale(s, s);

  ctx.beginPath();
  ctx.moveTo(64, 8);
  ctx.lineTo(112, 28);
  ctx.lineTo(112, 68);
  ctx.quadraticCurveTo(112, 104, 64, 120);
  ctx.quadraticCurveTo(16, 104, 16, 68);
  ctx.lineTo(16, 28);
  ctx.closePath();

  // 방패 채우기 (그라디언트)
  const grad = ctx.createLinearGradient(64, 8, 64, 120);
  grad.addColorStop(0, '#2d2d2d');
  grad.addColorStop(1, '#1a1a1a');
  ctx.fillStyle = grad;
  ctx.fill();

  // 방패 테두리
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // 체크마크
  ctx.beginPath();
  ctx.moveTo(42, 66);
  ctx.lineTo(57, 82);
  ctx.lineTo(86, 50);
  ctx.strokeStyle = '#1D9E75';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.restore();

  return canvas;
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

[16, 48, 128].forEach((size) => {
  const canvas = drawShield(size);
  const buffer = canvas.toBuffer('image/png');
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, buffer);
  console.log(`Created icons/icon${size}.png`);
});
