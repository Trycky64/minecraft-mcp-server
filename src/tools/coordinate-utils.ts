export function coerceCoordinates(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const coercedX = Number(x);
  const coercedY = Number(y);
  const coercedZ = Number(z);

  if (!Number.isFinite(coercedX) || !Number.isFinite(coercedY) || !Number.isFinite(coercedZ)) {
    throw new Error("x, y, and z must be valid numbers");
  }
  if (Math.abs(coercedX) > 30_000_000 || Math.abs(coercedZ) > 30_000_000 || coercedY < -2048 || coercedY > 2048) {
    throw new Error("coordinates are outside the supported world bounds");
  }

  return { x: coercedX, y: coercedY, z: coercedZ };
}
