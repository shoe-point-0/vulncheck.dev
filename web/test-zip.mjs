import { crc32 } from "./zip-reader.mjs";

const encoder = new TextEncoder();

export function makeStoredZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const definition of entries) {
    const name = encoder.encode(definition.path);
    const content = definition.bytes instanceof Uint8Array ? definition.bytes : encoder.encode(definition.content ?? "");
    const method = definition.method ?? 0;
    const compressed = definition.compressed ?? content;
    const declaredSize = definition.uncompressedSize ?? content.byteLength;
    const declaredCRC = definition.crc ?? crc32(content);
    const flags = definition.flags ?? 0x0800;
    const localHeader = concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(declaredCRC), u32(compressed.byteLength), u32(declaredSize), u16(name.byteLength), u16(0), name, compressed
    ]);
    local.push(localHeader);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(declaredCRC), u32(compressed.byteLength), u32(declaredSize), u16(name.byteLength), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
    ]));
    offset += localHeader.byteLength;
  }
  const centralBytes = concat(central);
  return new Blob([concat([...local, centralBytes, concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBytes.byteLength), u32(offset), u16(0)
  ])])]);
}

export async function mutateZip(zip, offset, value) {
  const bytes = new Uint8Array(await zip.arrayBuffer());
  bytes[offset] = value;
  return new Blob([bytes]);
}

function u16(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concat(parts) {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
