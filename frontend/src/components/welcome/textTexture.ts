/**
 * Builds crisp text labels as canvas textures so we can integrate headings
 * and labels INTO the 3D scene without bundling an external typeface font
 * (Three's TextGeometry needs a font JSON; we avoid that to keep the bundle
 * light and offline-safe). The browser's own web-safe fonts are used.
 */
import * as THREE from "three";

export interface TextSpriteOptions {
  color?: string;
  fontFamily?: string;
  fontWeight?: string;
  fontSize?: number;
  /** World height of the sprite (meters). Width is derived from aspect. */
  worldHeight?: number;
  /** Optional pill background (palette color). */
  background?: string;
  padding?: number;
  letterSpacing?: number;
}

const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function makeTextSprite(text: string, opts: TextSpriteOptions = {}): THREE.Sprite {
  const {
    color = "#33503f",
    fontWeight = "700",
    fontSize = 64,
    worldHeight = 4,
    background,
    padding = 28,
    letterSpacing = 0,
  } = opts;

  const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);

  // First pass: measure at base resolution.
  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d")!;
  const fontStr = `${fontWeight} ${fontSize}px ${FONT_STACK}`;
  mctx.font = fontStr;

  let totalWidth = 0;
  if (letterSpacing > 0) {
    for (const ch of text) totalWidth += mctx.measureText(ch).width + letterSpacing;
    totalWidth -= letterSpacing;
  } else {
    totalWidth = mctx.measureText(text).width;
  }

  const textW = Math.ceil(totalWidth) + padding * 2;
  const textH = Math.ceil(fontSize * 1.4) + padding * 2;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(textW * dpr);
  canvas.height = Math.ceil(textH * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  if (background) {
    const r = Math.min(textH / 2, 22);
    roundRect(ctx, 0, 0, textW, textH, r);
    ctx.fillStyle = background;
    ctx.fill();
  }

  ctx.font = fontStr;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;

  if (letterSpacing > 0) {
    let x = textW / 2 - totalWidth / 2;
    ctx.textAlign = "left";
    for (const ch of text) {
      ctx.fillText(ch, x, textH / 2);
      x += mctx.measureText(ch).width + letterSpacing;
    }
  } else {
    ctx.fillText(text, textW / 2, textH / 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const sprite = new THREE.Sprite(material);
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(worldHeight * aspect, worldHeight, 1);
  sprite.userData.texture = texture;
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Dispose a sprite's texture + material safely. */
export function disposeSprite(sprite: THREE.Sprite): void {
  const tex = sprite.userData.texture as THREE.Texture | undefined;
  if (tex) tex.dispose();
  sprite.material.dispose();
}
