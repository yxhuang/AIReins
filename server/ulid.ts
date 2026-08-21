import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encode(value: bigint, length: number): string {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output = ALPHABET[Number(value & 31n)] + output;
    value >>= 5n;
  }
  return output;
}

export function ulid(now = Date.now()): string {
  const time = encode(BigInt(now), 10);
  const bytes = randomBytes(10);
  let randomness = 0n;
  for (const byte of bytes) randomness = (randomness << 8n) | BigInt(byte);
  return time + encode(randomness, 16);
}
